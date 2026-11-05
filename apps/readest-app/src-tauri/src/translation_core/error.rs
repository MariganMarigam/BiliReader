//! Errors for the embedded translation core (L3, llama.cpp in-process).

/// Failure modes of a single translation job / engine lifecycle.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    /// The GGUF file does not exist at the requested path.
    #[error("model missing: {0}")]
    ModelMissing(String),
    /// A translation was requested before the engine finished loading.
    #[allow(dead_code)] // surfaces once the frontend calls translate before init
    #[error("engine not loaded; call local_engine_status first")]
    NotLoaded,
    /// llama.cpp backend/model/context failure (bad GGUF, OOM, template, decode).
    #[error("llama backend: {0}")]
    Backend(String),
    /// The job was cancelled through [`crate::translation_core::engine::CancelToken`].
    #[error("cancelled")]
    Cancelled,
    /// The worker thread panicked while serving the job.
    #[error("translation worker panicked")]
    Panic,
    /// Caller-supplied input was rejected before tokenization.
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// The worker thread is gone (channel closed).
    #[error("translation engine closed")]
    Closed,
}

/// Errors surfaced by [`crate::translation_core::TranslationCore`] helpers.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// Filesystem failure while preparing the model directory.
    #[allow(dead_code)] // used by model-manager steps (1.7)
    #[error("io: {0}")]
    Io(String),
    /// Engine-level failure.
    #[error(transparent)]
    Engine(#[from] EngineError),
    /// A core lock was poisoned by a panicking thread.
    #[error("translation core lock poisoned")]
    Lock,
}
