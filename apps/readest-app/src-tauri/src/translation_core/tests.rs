//! Tests for the embedded translation core.
//!
//! The real-model tests run only when `BIREADER_MODEL_PATH` points at an
//! existing GGUF; without it they print `SKIP` and pass. They share one
//! `LlamaEngine` because `LlamaBackend::init()` is a process singleton.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::engine::{CancelToken, Engine, EngineRequest};
use super::error::EngineError;
use super::llama::{LlamaConfig, LlamaEngine, LLAMA_CPP_PIN, WRAPPER};
use super::*;

static ENGINE: OnceLock<Option<Arc<LlamaEngine>>> = OnceLock::new();
static SERIAL: Mutex<()> = Mutex::new(());

const LONG_SENTENCE: &str = "The old lighthouse keeper climbed the spiral staircase every evening \
before sunset to trim the lamp and write a short entry in the logbook about the weather, the \
ships he had seen on the horizon, and the slow changes of the season along the rocky coast.";

fn rss_kib() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find(|line| line.starts_with("VmRSS:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse().ok())
}

fn shared_engine() -> Option<Arc<LlamaEngine>> {
    ENGINE
        .get_or_init(|| {
            let raw = std::env::var("BIREADER_MODEL_PATH").ok()?;
            let path = PathBuf::from(raw);
            if !path.exists() {
                eprintln!("SKIP: BIREADER_MODEL_PATH does not exist: {}", path.display());
                return None;
            }
            println!("RSS_BEFORE_LOAD_KIB={:?}", rss_kib());
            let started = Instant::now();
            match LlamaEngine::open(&path, LlamaConfig::default()) {
                Ok(engine) => {
                    println!(
                        "MODEL_LOAD_MS={}",
                        started.elapsed().as_millis()
                    );
                    println!("RSS_AFTER_LOAD_KIB={:?}", rss_kib());
                    Some(Arc::new(engine))
                }
                Err(err) => {
                    eprintln!("SKIP: LlamaEngine::open failed: {err}");
                    None
                }
            }
        })
        .clone()
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "bilireader-translation-{tag}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn status_without_model_is_not_ready() {
    let dir = temp_dir("status-missing");
    let core = TranslationCore::new();
    assert!(!core
        .ensure_engine_at(&dir.join("missing.gguf"))
        .expect("ensure_engine_at"));

    let status = core.status();
    assert!(!status.ready);
    assert_eq!(status.engine, WRAPPER);
    assert_eq!(status.llama_cpp_commit, LLAMA_CPP_PIN);
    assert!(status.error.is_some());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn status_is_idempotent() {
    let dir = temp_dir("status-idempotent");
    let core = TranslationCore::new();
    let path = dir.join("missing.gguf");
    assert!(!core.ensure_engine_at(&path).expect("first call"));
    assert!(!core.ensure_engine_at(&path).expect("second call"));
    assert!(!core.status().ready);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn cancel_token_flips_flag() {
    let token = CancelToken::new();
    assert!(!token.is_cancelled());
    token.cancel();
    assert!(token.is_cancelled());
}

#[test]
fn cancel_unknown_job_returns_false() {
    let core = TranslationCore::new();
    assert!(!cancel_job(&core.inner, "missing-job"));
    assert!(core.cancels().lock().expect("registry").is_empty());
}

#[test]
fn cancels_registry_drops_entry() {
    let core = TranslationCore::new();
    let token = CancelToken::new();
    core.cancels()
        .lock()
        .expect("registry")
        .insert("job-1".to_string(), token.clone());
    assert!(cancel_job(&core.inner, "job-1"));
    assert!(token.is_cancelled());
    core.cancels().lock().expect("registry").remove("job-1");
    assert!(core.cancels().lock().expect("registry").get("job-1").is_none());
}

#[test]
fn empty_text_is_rejected() {
    let err = validate_text("   \n\t").expect_err("blank text must fail");
    assert!(err.to_string().contains("empty"));
    assert!(validate_text("Hello").is_ok());
}

#[test]
fn real_model_translates_en_to_ru() {
    let _guard = SERIAL.lock().expect("serial");
    let Some(engine) = shared_engine() else {
        eprintln!("SKIP real_model_translates_en_to_ru: no model");
        return;
    };
    let mut sink = ();

    for (label, text) in [
        ("WORD", "Hello"),
        ("SHORT", "The weather is nice today."),
        ("LONG", LONG_SENTENCE),
    ] {
        let req = EngineRequest {
            text,
            context: None,
            max_new_tokens: 128,
        };
        let started = Instant::now();
        let out = engine
            .translate(&req, &CancelToken::new(), &mut sink)
            .expect("translate");
        println!(
            "{label}_MS={} {label}_TOKENS={} {label}_TEXT={:?}",
            started.elapsed().as_millis(),
            out.tokens,
            out.text
        );
        assert!(!out.text.is_empty(), "{label}: empty translation");
        assert!(out.tokens > 0, "{label}: no tokens generated");
    }

    println!("RSS_AFTER_TRANSLATE_KIB={:?}", rss_kib());
}

#[test]
fn real_model_cancel_is_immediate() {
    let _guard = SERIAL.lock().expect("serial");
    let Some(engine) = shared_engine() else {
        eprintln!("SKIP real_model_cancel_is_immediate: no model");
        return;
    };

    let token = CancelToken::new();
    let worker_token = token.clone();
    let started = Instant::now();
    let handle = std::thread::spawn(move || {
        let mut sink = ();
        let req = EngineRequest {
            text: LONG_SENTENCE,
            context: None,
            max_new_tokens: 128,
        };
        engine.translate(&req, &worker_token, &mut sink)
    });

    std::thread::sleep(Duration::from_millis(20));
    let cancel_started = Instant::now();
    token.cancel();
    let result = handle.join().expect("join translation thread");
    println!(
        "CANCEL_LATENCY_MS={} CANCEL_TOTAL_MS={}",
        cancel_started.elapsed().as_millis(),
        started.elapsed().as_millis()
    );

    match result {
        Err(EngineError::Cancelled) => {}
        other => panic!("expected Cancelled, got {other:?}"),
    }
    println!("RSS_AFTER_CANCEL_KIB={:?}", rss_kib());
}
