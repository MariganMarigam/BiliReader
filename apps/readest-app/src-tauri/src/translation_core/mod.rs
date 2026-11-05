//! Embedded translation core. Stage 1.1 ships the L3 llama.cpp engine.

pub mod commands;
pub mod engine;
pub mod error;
pub mod llama;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use engine::CancelToken;
use error::{CoreError, EngineError};
use llama::{LlamaConfig, LlamaEngine, LLAMA_CPP_PIN, WRAPPER};

/// Default model directory on dev machines; the app normally passes its own.
pub const DEFAULT_MODEL_DIR: &str = "/home/codexrescriptus/.local/share/bilireader/models";
/// GGUF filename inside the model directory.
pub const MODEL_FILENAME: &str = "Hy-MT2-1.8B-Q4_K_M.gguf";

/// Loaded engines. Only L3 exists in this stage.
#[allow(dead_code)] // reserved: `TranslationCore` populates it from stage 1.2
#[derive(Default)]
pub struct EngineSet {
    /// The llama.cpp engine, once loaded.
    pub llama: Option<Arc<LlamaEngine>>,
}

/// Shared state behind [`TranslationCore`].
#[derive(Default)]
pub struct CoreInner {
    /// Loaded engine (idempotent init).
    pub llama: RwLock<Option<Arc<LlamaEngine>>>,
    /// Active jobs by `job_id` (frontend-generated UUID).
    pub cancels: Mutex<HashMap<String, CancelToken>>,
    /// Path of the GGUF actually loaded (for `local_engine_status`).
    pub model_path: RwLock<Option<PathBuf>>,
    /// Last initialization error, surfaced to the UI.
    pub last_error: RwLock<Option<String>>,
    /// Serializes engine init (llama backend is a process singleton).
    pub init: Mutex<()>,
}

/// Cheaply cloneable handle registered as Tauri state.
#[derive(Clone, Default)]
pub struct TranslationCore {
    /// Shared inner state (cloneable `Arc`).
    pub inner: Arc<CoreInner>,
}

impl TranslationCore {
    /// Empty core; nothing is loaded.
    pub fn new() -> Self {
        Self::default()
    }

    /// Cancel registry (used by `cancel_translation` and tests).
    #[allow(dead_code)] // called by tests; commands use `cancel_job`
    pub fn cancels(&self) -> &Mutex<HashMap<String, CancelToken>> {
        &self.inner.cancels
    }

    /// Idempotent engine init for a model directory.
    ///
    /// Resolution order: `BIREADER_MODEL_PATH` when set, otherwise
    /// `<models_dir>/Hy-MT2-1.8B-Q4_K_M.gguf`. Missing model is not an error:
    /// it sets `last_error` and reports `ready = false`.
    pub fn ensure_engine(&self, models_dir: &Path) -> Result<bool, CoreError> {
        {
            let guard = self.inner.llama.read().map_err(|_| CoreError::Lock)?;
            if guard.is_some() {
                return Ok(true);
            }
        }
        let path = resolve_model_path(models_dir);
        self.ensure_engine_at(&path)
    }

    /// Idempotent engine init for an explicit GGUF path (env-independent).
    pub fn ensure_engine_at(&self, model_path: &Path) -> Result<bool, CoreError> {
        // Serialize init: a second `LlamaBackend::init()` would fail with
        // `BackendAlreadyInitialized`.
        let _init = self.inner.init.lock().map_err(|_| CoreError::Lock)?;
        if self
            .inner
            .llama
            .read()
            .map_err(|_| CoreError::Lock)?
            .is_some()
        {
            return Ok(true);
        }

        if !model_path.exists() {
            self.set_error(Some(format!("model missing: {}", model_path.display())));
            return Ok(false);
        }

        match LlamaEngine::open(model_path, LlamaConfig::default()) {
            Ok(engine) => {
                let engine = Arc::new(engine);
                *self.inner.model_path.write().map_err(|_| CoreError::Lock)? =
                    Some(model_path.to_path_buf());
                *self.inner.llama.write().map_err(|_| CoreError::Lock)? = Some(engine);
                self.set_error(None);
                Ok(true)
            }
            Err(err @ EngineError::ModelMissing(_)) => {
                self.set_error(Some(err.to_string()));
                Ok(false)
            }
            Err(err) => {
                log::error!("llama engine init failed: {err}");
                self.set_error(Some(err.to_string()));
                Ok(false)
            }
        }
    }

    /// Snapshot for `local_engine_status`.
    pub fn status(&self) -> CoreStatus {
        let engine = self.inner.llama.read().ok().and_then(|g| g.clone());
        let model_path = self
            .inner
            .model_path
            .read()
            .ok()
            .and_then(|g| g.clone())
            .map(|p| p.display().to_string());
        let error = self.inner.last_error.read().ok().and_then(|g| g.clone());
        let cfg = engine
            .as_ref()
            .map(|e| e.config().clone())
            .unwrap_or_default();
        CoreStatus {
            ready: engine.is_some(),
            engine: WRAPPER.to_string(),
            llama_cpp_commit: LLAMA_CPP_PIN.to_string(),
            model_path,
            n_ctx: cfg.n_ctx,
            threads: cfg.n_threads,
            error,
        }
    }

    fn set_error(&self, message: Option<String>) {
        if let Ok(mut guard) = self.inner.last_error.write() {
            *guard = message;
        }
    }
}

/// Resolve the GGUF path: `BIREADER_MODEL_PATH` wins, then `models_dir`.
pub fn resolve_model_path(models_dir: &Path) -> PathBuf {
    if let Some(path) = std::env::var_os("BIREADER_MODEL_PATH") {
        return PathBuf::from(path);
    }
    models_dir.join(MODEL_FILENAME)
}

/// Reject blank input before tokenization.
pub fn validate_text(text: &str) -> Result<(), EngineError> {
    if text.trim().is_empty() {
        return Err(EngineError::InvalidInput("empty text".to_string()));
    }
    Ok(())
}

/// Cancel a registered job; `true` if the job was still active.
pub fn cancel_job(inner: &CoreInner, job_id: &str) -> bool {
    inner
        .cancels
        .lock()
        .ok()
        .and_then(|registry| registry.get(job_id).map(|token| {
            token.cancel();
            true
        }))
        .unwrap_or(false)
}

/// Status returned by `local_engine_status`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CoreStatus {
    /// Engine loaded and ready to translate.
    pub ready: bool,
    /// Wrapper provenance.
    pub engine: String,
    /// Vendored llama.cpp commit.
    pub llama_cpp_commit: String,
    /// GGUF actually loaded, if any.
    pub model_path: Option<String>,
    /// Context window.
    pub n_ctx: u32,
    /// Worker threads.
    pub threads: i32,
    /// Last initialization error.
    pub error: Option<String>,
}

/// Result returned by `translate_local`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalTranslation {
    /// Caller-supplied job id.
    pub job_id: String,
    /// Translated text (empty when cancelled).
    pub text: String,
    /// Generated tokens.
    pub tokens: usize,
    /// Wall-clock duration in milliseconds.
    pub ms: u64,
    /// True when the job was cancelled.
    pub cancelled: bool,
}
