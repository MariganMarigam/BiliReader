//! L3 engine: llama.cpp in-process through the `llama-cpp-2` crate.
//!
//! The crate's `LlamaContext<'a>` borrows its `LlamaModel` and is `Send` but
//! not `Sync`, so model + context live in one dedicated thread (`llama-l3`)
//! as locals of [`engine_thread`]. [`LlamaEngine`] exposes only an mpsc
//! sender, which is `Send + Sync` once wrapped in a `Mutex`; no `unsafe impl`
//! is needed anywhere.

use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;

use super::engine::{
    CancelToken, Engine, EngineOutput, EngineRequest, Level, TokenSink,
};
use super::error::EngineError;

/// llama.cpp commit vendored by `llama-cpp-sys-2` 0.1.161 (v0.8.0).
pub const LLAMA_CPP_PIN: &str = "8642541b255bfb5dc39cd351a178be09013a55d6";
/// Human-readable wrapper provenance.
pub const WRAPPER: &str = "llama-cpp-2 0.1.161";

/// Runtime knobs for the embedded engine.
#[derive(Debug, Clone)]
pub struct LlamaConfig {
    /// Context window size.
    pub n_ctx: u32,
    /// Worker threads (decode + batch).
    pub n_threads: i32,
    /// Default cap on generated tokens.
    pub max_new_tokens: usize,
    /// System prompt steering the model to translate, not chat.
    pub system_prompt: String,
}

impl Default for LlamaConfig {
    fn default() -> Self {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(4) as i32;
        Self {
            n_ctx: 2048,
            n_threads: threads.max(1),
            max_new_tokens: 128,
            system_prompt:
                "Translate the following English text to Russian. Output translation only."
                    .to_string(),
        }
    }
}

/// One queued translation job. Owns everything it needs, so it can cross the
/// thread boundary as a plain `Send` value.
struct Job {
    text: String,
    context: Option<String>,
    max_new_tokens: usize,
    cancel: CancelToken,
    /// Token pieces are relayed through a channel to the caller thread; the
    /// caller's sink is never moved into the worker.
    sink: Box<dyn FnMut(&str) + Send>,
    reply: Sender<Result<EngineOutput, EngineError>>,
}

/// Handle to the `llama-l3` worker thread.
pub struct LlamaEngine {
    tx: Mutex<Sender<Job>>,
    cfg: Arc<LlamaConfig>,
}

impl LlamaEngine {
    /// Spawn `llama-l3`, load the GGUF and create the context.
    ///
    /// Returns only after the model is fully loaded (or an error arrives over
    /// the handshake channel), so a successful `open` means `ready`.
    pub fn open(gguf_path: &Path, cfg: LlamaConfig) -> Result<Self, EngineError> {
        let (tx, rx) = mpsc::channel::<Job>();
        let (boot_tx, boot_rx) = mpsc::channel::<Result<(), EngineError>>();
        let path = gguf_path.to_path_buf();
        let cfg = Arc::new(cfg);
        let thread_cfg = Arc::clone(&cfg);

        std::thread::Builder::new()
            .name("llama-l3".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || engine_thread(path, thread_cfg, rx, boot_tx))
            .map_err(|e| EngineError::Backend(format!("spawn llama-l3: {e}")))?;

        match boot_rx.recv_timeout(Duration::from_secs(120)) {
            Ok(Ok(())) => Ok(Self {
                tx: Mutex::new(tx),
                cfg,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(EngineError::Backend(
                "llama backend init timeout".to_string(),
            )),
        }
    }

    /// Effective configuration (threads, ctx, defaults).
    pub fn config(&self) -> &LlamaConfig {
        &self.cfg
    }
}

impl Drop for LlamaEngine {
    fn drop(&mut self) {
        // Dropping `tx` (inside the Mutex) closes the channel, which makes the
        // worker leave `recv()` and drop context, model and backend in RAII
        // order. Nothing else is required here.
    }
}

#[allow(dead_code)] // `id`/`level` are consumed by the router in stage 1.3
impl Engine for LlamaEngine {
    fn id(&self) -> &'static str {
        WRAPPER
    }

    fn level(&self) -> Level {
        Level::L3
    }

    fn translate(
        &self,
        req: &EngineRequest<'_>,
        cancel: &CancelToken,
        sink: &mut dyn TokenSink,
    ) -> Result<EngineOutput, EngineError> {
        let (tok_tx, tok_rx) = mpsc::channel::<String>();
        let (reply_tx, reply_rx) = mpsc::channel::<Result<EngineOutput, EngineError>>();
        let max_new_tokens = if req.max_new_tokens == 0 {
            self.cfg.max_new_tokens
        } else {
            req.max_new_tokens
        };

        let job = Job {
            text: req.text.to_string(),
            context: req.context.map(ToString::to_string),
            max_new_tokens,
            cancel: cancel.clone(),
            sink: Box::new(move |piece: &str| {
                let _ = tok_tx.send(piece.to_string());
            }),
            reply: reply_tx,
        };

        {
            let tx = self.tx.lock().map_err(|_| EngineError::Closed)?;
            tx.send(job).map_err(|_| EngineError::Closed)?;
        }

        // Relay pieces to the caller's sink while waiting for the final reply.
        // A 20 ms poll only bounds the tail latency after the last token.
        loop {
            match tok_rx.recv_timeout(Duration::from_millis(20)) {
                Ok(piece) => sink.on_token(&piece),
                Err(RecvTimeoutError::Timeout) => {
                    if let Ok(done) = reply_rx.try_recv() {
                        return done;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return reply_rx.recv().unwrap_or(Err(EngineError::Closed));
                }
            }
        }
    }
}

/// Worker thread body: owns `backend`, `model` and `ctx` for its lifetime.
fn engine_thread(
    path: PathBuf,
    cfg: Arc<LlamaConfig>,
    rx: Receiver<Job>,
    boot_tx: Sender<Result<(), EngineError>>,
) {
    // Drop order is reverse declaration order: ctx → model → backend.
    let backend = match LlamaBackend::init() {
        Ok(b) => b,
        Err(e) => {
            let _ = boot_tx.send(Err(EngineError::Backend(format!("backend init: {e}"))));
            return;
        }
    };

    if !path.exists() {
        let _ = boot_tx.send(Err(EngineError::ModelMissing(path.display().to_string())));
        return;
    }

    let model = match LlamaModel::load_from_file(&backend, &path, &LlamaModelParams::default()) {
        Ok(m) => m,
        Err(e) => {
            let _ = boot_tx.send(Err(EngineError::Backend(format!("load model: {e}"))));
            return;
        }
    };

    let params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(cfg.n_ctx))
        .with_n_threads(cfg.n_threads);
    let mut ctx = match model.new_context(&backend, params) {
        Ok(c) => c,
        Err(e) => {
            let _ = boot_tx.send(Err(EngineError::Backend(format!("new context: {e}"))));
            return;
        }
    };

    let _ = boot_tx.send(Ok(()));

    while let Ok(mut job) = rx.recv() {
        let reply = job.reply.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            generate(&model, &mut ctx, &cfg, &mut job)
        }))
        .unwrap_or_else(|_| {
            log::error!("llama-l3 worker panicked while generating");
            Err(EngineError::Panic)
        });
        let _ = reply.send(result);
    }
}

/// Prompt construction + token loop for one job.
fn generate(
    model: &LlamaModel,
    ctx: &mut llama_cpp_2::context::LlamaContext<'_>,
    cfg: &LlamaConfig,
    job: &mut Job,
) -> Result<EngineOutput, EngineError> {
    if job.text.trim().is_empty() {
        return Err(EngineError::InvalidInput("empty text".to_string()));
    }

    let template = model
        .chat_template(None)
        .map_err(|e| EngineError::Backend(format!("chat template: {e}")))?;
    let user = match job.context.as_deref() {
        Some(context) if !context.trim().is_empty() => {
            format!("{}\n\n{}", context.trim(), job.text)
        }
        _ => job.text.clone(),
    };
    let messages = [
        LlamaChatMessage::new("system".to_string(), cfg.system_prompt.clone())
            .map_err(|e| EngineError::Backend(format!("chat message: {e}")))?,
        LlamaChatMessage::new("user".to_string(), user)
            .map_err(|e| EngineError::Backend(format!("chat message: {e}")))?,
    ];
    let prompt = model
        .apply_chat_template(&template, &messages, true)
        .map_err(|e| EngineError::Backend(format!("apply chat template: {e}")))?;

    let vocab = model.vocab();
    // `parse_special = true`: the chat template embeds the model's special
    // markers (e.g. `<|im_start|>`); tokenizing them as plain text derails
    // generation into special-token soup.
    let tokens = vocab.tokenize(prompt.as_bytes(), true, true);
    if tokens.is_empty() {
        return Err(EngineError::InvalidInput("empty prompt".to_string()));
    }
    if tokens.len() >= cfg.n_ctx as usize {
        return Err(EngineError::InvalidInput(format!(
            "prompt too long: {} tokens for n_ctx {}",
            tokens.len(),
            cfg.n_ctx
        )));
    }

    let mut batch = LlamaBatch::new(tokens.len(), 1);
    for (i, token) in tokens.iter().enumerate() {
        batch
            .add(*token, i as i32, &[0], i + 1 == tokens.len())
            .map_err(|e| EngineError::Backend(format!("batch add prompt: {e}")))?;
    }

    ctx.clear_kv_cache();
    ctx.decode(&mut batch)
        .map_err(|e| EngineError::Backend(format!("decode prompt: {e}")))?;

    let mut sampler = LlamaSampler::greedy();
    let mut out: Vec<u8> = Vec::with_capacity(64);
    let mut emitted = 0usize;
    let mut n_cur = tokens.len() as i32;
    let mut n_out = 0usize;

    loop {
        if job.cancel.is_cancelled() {
            return Err(EngineError::Cancelled);
        }
        if n_out >= job.max_new_tokens || n_cur >= cfg.n_ctx as i32 {
            break;
        }

        let token = sampler.sample(ctx, -1);
        if vocab.is_eog(token) {
            break;
        }

        // Control tokens are template machinery, never translation output.
        if !vocab.is_control(token) {
            let piece_bytes = vocab.token_to_piece(token, false, None);
            out.extend_from_slice(&piece_bytes);
            // Only forward complete UTF-8; a token may split a multi-byte char.
            if let Ok(chunk) = std::str::from_utf8(&out[emitted..]) {
                if !chunk.is_empty() {
                    (job.sink)(chunk);
                    emitted = out.len();
                }
            }
        }

        n_out += 1;
        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|e| EngineError::Backend(format!("batch add token: {e}")))?;
        n_cur += 1;
        ctx.decode(&mut batch)
            .map_err(|e| EngineError::Backend(format!("decode token: {e}")))?;
    }

    Ok(EngineOutput {
        text: String::from_utf8_lossy(&out).trim().to_string(),
        tokens: n_out,
    })
}
