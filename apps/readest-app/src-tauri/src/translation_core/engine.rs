//! Engine abstraction shared by every translation level.
//!
//! Only L3 (llama.cpp in-process) exists in stage 1; L1/L2 arrive in later
//! steps with the same trait.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::error::EngineError;

/// Translation level. L3 is the embedded llama.cpp engine.
#[allow(dead_code)] // L1/L2 are wired in later stages
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// Dictionary / cache level (stage 1.2+).
    L1,
    /// Rules / small model level (stage 1.5+).
    L2,
    /// Embedded llama.cpp level (this stage).
    L3,
}

#[allow(dead_code)] // used once L1/L2 routing lands
impl Level {
    /// Lowercase wire name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Level::L1 => "l1",
            Level::L2 => "l2",
            Level::L3 => "l3",
        }
    }

    /// Case-insensitive parse of the wire name.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "l1" => Some(Level::L1),
            "l2" => Some(Level::L2),
            "l3" => Some(Level::L3),
            _ => None,
        }
    }
}

/// Cancellation flag for one generation. Cloning is cheap (shared `Arc`).
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    /// A fresh, non-cancelled token.
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    /// Flip the flag. Idempotent and safe from any thread.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether the job has been cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Streaming receiver for generated tokens.
pub trait TokenSink {
    /// Called once per generated token piece, in order.
    fn on_token(&mut self, piece: &str);
}

impl TokenSink for () {
    fn on_token(&mut self, _piece: &str) {}
}

/// Adapts any `FnMut(&str)` to [`TokenSink`].
pub struct FnSink<F>(pub F);

impl<F: FnMut(&str)> TokenSink for FnSink<F> {
    fn on_token(&mut self, piece: &str) {
        (self.0)(piece);
    }
}

/// Result of one successful translation.
#[derive(Debug, Clone, Default)]
pub struct EngineOutput {
    /// Trimmed generated text.
    pub text: String,
    /// Number of generated tokens.
    pub tokens: usize,
}

/// Input for one translation job.
pub struct EngineRequest<'a> {
    /// Source text (English).
    pub text: &'a str,
    /// Optional surrounding context prepended to the prompt.
    pub context: Option<&'a str>,
    /// Hard cap on generated tokens.
    pub max_new_tokens: usize,
}

/// A translation backend.
pub trait Engine: Send + Sync {
    /// Provenance id, e.g. `"llama-cpp-2 0.1.161"`.
    fn id(&self) -> &'static str;
    /// Level implemented by this engine.
    fn level(&self) -> Level;
    /// Translate `req`, streaming pieces into `sink`. Blocks until done.
    fn translate(
        &self,
        req: &EngineRequest<'_>,
        cancel: &CancelToken,
        sink: &mut dyn TokenSink,
    ) -> Result<EngineOutput, EngineError>;
}
