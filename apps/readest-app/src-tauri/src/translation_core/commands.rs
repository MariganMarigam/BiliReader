//! Tauri commands exposed to the frontend for the embedded translator.

use std::path::PathBuf;
use std::time::Instant;

use tauri::Emitter;

use super::engine::{CancelToken, Engine as _, EngineRequest, FnSink};
use super::error::EngineError;
use super::{
    cancel_job, validate_text, CoreStatus, LocalTranslation, TranslationCore, DEFAULT_MODEL_DIR,
};

/// Default cap on generated tokens for one IPC call.
const MAX_NEW_TOKENS: usize = 128;
/// Event carrying streamed token deltas.
const TOKEN_EVENT: &str = "translation://token";

/// Load (idempotently) the embedded engine and report its status.
///
/// An empty `models_dir` means [`DEFAULT_MODEL_DIR`]. `BIREADER_MODEL_PATH`
/// overrides the resolved GGUF path.
#[tauri::command]
pub async fn local_engine_status(
    state: tauri::State<'_, TranslationCore>,
    models_dir: String,
) -> Result<CoreStatus, String> {
    let core = TranslationCore {
        inner: state.inner.clone(),
    };
    let dir = if models_dir.trim().is_empty() {
        PathBuf::from(DEFAULT_MODEL_DIR)
    } else {
        PathBuf::from(models_dir)
    };
    tauri::async_runtime::spawn_blocking(move || core.ensure_engine(&dir).map(|_| core.status()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Translate one text locally, streaming pieces on `translation://token`.
#[tauri::command]
pub async fn translate_local(
    app: tauri::AppHandle,
    state: tauri::State<'_, TranslationCore>,
    job_id: String,
    text: String,
    context: Option<String>,
) -> Result<LocalTranslation, String> {
    validate_text(&text).map_err(|e| e.to_string())?;

    let core = state.inner.clone();
    let engine = core
        .llama
        .read()
        .map_err(|_| "engine lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "engine not loaded; call local_engine_status first".to_string())?;

    let token = CancelToken::new();
    core.cancels
        .lock()
        .map_err(|_| "cancel registry lock poisoned".to_string())?
        .insert(job_id.clone(), token.clone());

    let started = Instant::now();
    let emit_job_id = job_id.clone();
    let app_handle = app.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        let mut sink = FnSink(move |piece: &str| {
            let _ = app_handle.emit(
                TOKEN_EVENT,
                serde_json::json!({ "job_id": emit_job_id, "delta": piece }),
            );
        });
        let req = EngineRequest {
            text: &text,
            context: context.as_deref(),
            max_new_tokens: MAX_NEW_TOKENS,
        };
        engine.translate(&req, &token, &mut sink)
    })
    .await;
    let ms = started.elapsed().as_millis() as u64;

    // Always unregister, including on error, before mapping the result.
    if let Ok(mut registry) = core.cancels.lock() {
        registry.remove(&job_id);
    }

    match join {
        Ok(Ok(out)) => Ok(LocalTranslation {
            job_id,
            text: out.text,
            tokens: out.tokens,
            ms,
            cancelled: false,
        }),
        // Cancellation is a soft result for the UI, not an IPC error.
        Ok(Err(EngineError::Cancelled)) => Ok(LocalTranslation {
            job_id,
            text: String::new(),
            tokens: 0,
            ms,
            cancelled: true,
        }),
        Ok(Err(e)) => Err(e.to_string()),
        Err(e) => Err(format!("translation task failed: {e}")),
    }
}

/// Request cancellation of a running job. `false` when the id is unknown.
#[tauri::command]
pub fn cancel_translation(
    state: tauri::State<'_, TranslationCore>,
    job_id: String,
) -> Result<bool, String> {
    Ok(cancel_job(&state.inner, &job_id))
}
