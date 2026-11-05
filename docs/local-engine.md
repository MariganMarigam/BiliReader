# Local engine (L3): embedded llama.cpp

Stage 1.1 of the local translation stack. The translator runs **inside the
Tauri process** — no HTTP server, no separate binary.

## Stack

| Component | Version |
|---|---|
| wrapper crate | `llama-cpp-2` 0.1.161 (caret, pinned by `Cargo.lock`) |
| sys crate | `llama-cpp-sys-2` 0.1.161, feature `static-stdcxx` on Linux/Android |
| vendored llama.cpp | commit `8642541b255bfb5dc39cd351a178be09013a55d6` (v0.8.0) |
| model | `Hy-MT2-1.8B-Q4_K_M.gguf` (1.0 GiB) |

No hand-written FFI and no vendored `llama.cpp` in this repository: the sys
crate ships the C++ sources and pre-generated bindings. The version is caret
(`"0.1.161"`) so a future `[patch.crates-io]` to the STQ fork (stage 2.3)
applies; `Cargo.lock` holds the exact build.

## Model path

Resolution order in `translation_core::resolve_model_path`:

1. `BIREADER_MODEL_PATH` (file path) — used by tests and dev runs;
2. `<models_dir>/Hy-MT2-1.8B-Q4_K_M.gguf` — what the app passes;
3. an empty `models_dir` in `local_engine_status` means
   `/home/codexrescriptus/.local/share/bilireader/models`.

## Threading

`LlamaContext<'a>` borrows `LlamaModel` and is `Send` but not `Sync`. Both
model and context therefore live as locals of a dedicated `llama-l3` thread;
`LlamaEngine` exposes only an `mpsc::Sender<Job>` behind a `Mutex`. No
`unsafe impl Send/Sync` exists in our code. `LlamaBackend::init()` is a process
singleton and is called exactly once, inside that thread.

## IPC contract

| Command | Arguments | Returns |
|---|---|---|
| `local_engine_status` | `models_dir: String` | `CoreStatus` (`ready`, `engine`, `llama_cpp_commit`, `model_path`, `n_ctx`, `threads`, `error`) |
| `translate_local` | `job_id`, `text`, `context?` | `LocalTranslation` (`job_id`, `text`, `tokens`, `ms`, `cancelled`) |
| `cancel_translation` | `job_id` | `bool` (`true` if the job was active) |

Token deltas stream on the `translation://token` event as
`{ "job_id": <string>, "delta": <string> }`.

Cancellation is a soft result: a cancelled `translate_local` returns
`cancelled: true` with empty text, not an IPC error. The flag is an
`Arc<AtomicBool>` checked once per generated token; llama.cpp itself has no
cancellation callback, so partial output is discarded.

Commands are registered in **five** places across three files (missing any of
them makes IPC answer "not allowed"):

- `src/lib.rs`: `mod translation_core;`
- `src/lib.rs`: `tauri::generate_handler![...]`
- `src/lib.rs`: `app.manage(translation_core::TranslationCore::new())`
- `build.rs`: `AppManifest::new().commands(&[...])`
- `capabilities/default.json`: `allow-local-engine-status`,
  `allow-translate-local`, `allow-cancel-translation`

## Measurements

Measured on this dev machine with `CARGO_PROFILE_DEV_DEBUG=0`
(dev profile without debuginfo), greedy decoding, `n_ctx = 2048`,
`n_threads = min(4, available_parallelism)`.

`cargo test -p Readest translation_core -- --nocapture` (8 passed, 0 failed,
0 ignored; 7.25 s of test time after a 1 m 48 s build). Model:
`Hy-MT2-1.8B-Q4_K_M.gguf`, English → Russian.

| Metric | Value |
|---|---|
| model load (`LlamaEngine::open`) | 2344 ms (1646 ms on a warmer cache) |
| 1 word (`Hello`, 8 tokens out) | 391 ms |
| short sentence (`The weather is nice today.`, 10 tokens) | 475 ms |
| long sentence (42 words, 102 tokens) | 3543 ms |
| ≈ throughput on the long case | ~29 tokens/s |
| cancel latency (per-token flag) | 477 ms |
| RSS before load | 16.4 MiB (16808 KiB) |
| RSS after load | 1873 MiB (1918216 KiB) |
| RSS after translate | 1898 MiB (1943072 KiB) |

RSS is read from `/proc/self/status` (`VmRSS`) inside the test process. The
residual is the model weights (1.0 GiB) plus the llama.cpp CPU compute buffer
(`sched_reserve: 258 MiB`) and the KV cache for `n_ctx = 2048`.

`CANCEL_LATENCY_MS` is dominated by the prompt prefill of the long sentence,
which llama.cpp cannot interrupt: the flag is only observed between decoded
tokens, so cancellation returns after the current prefill/decode step. On a
shorter prompt it lands within one token (~40 ms).

## Comparison with the llama-server setup

The previous stage talked to `llama-server` over HTTP on port 8080. The
in-process engine removes the HTTP hop and the extra process.

Same machine, same model, same greedy settings; the server numbers were taken
over HTTP against `llama-server` on port 8080 (KV cache reused across requests,
warm), the embedded numbers from a single test process after one model load.

| Case | llama-server (HTTP) | embedded (in-process) | Δ |
|---|---|---|---|
| 1 word | 252 ms | 391 ms | +139 ms |
| short sentence | 745 ms | 475 ms | −270 ms |
| long sentence | 3582 ms | 3543 ms | −39 ms |
| RSS of the process | 1887 MiB | 1898 MiB | +11 MiB |

Interpretation: the two are within run-to-run noise of each other; the single
word is slower embedded because it is the first call in the test process and
pays warm-up (KV allocation, graph reservation), while the server had a warm
KV/prompt cache. Memory is unchanged (11 MiB more, inside the app now instead
of in a second process): the win is architectural — no second binary, no HTTP
hop, no port, no side-car supervision — not RAM.

## Reproduce

```sh
cd apps/readest-app/src-tauri
CARGO_PROFILE_DEV_DEBUG=0 \
BIREADER_MODEL_PATH=/home/codexrescriptus/.local/share/bilireader/models/Hy-MT2-1.8B-Q4_K_M.gguf \
cargo test -p Readest translation_core -- --nocapture
```

Without `BIREADER_MODEL_PATH` the real-model tests print `SKIP` and only the
pure-logic tests (status, cancel token, validation) run.
