# Local translation provider

The `local` provider translates on this machine. It has two transports, picked
at runtime:

| Platform | Transport | Requires |
| --- | --- | --- |
| Desktop (Tauri) | Embedded llama.cpp core, in-process, over Tauri IPC | A local GGUF model |
| Web | OpenAI-compatible server (llama.cpp `llama-server` at `127.0.0.1:8080/v1`) | A running HTTP server |

Either way it is a first-class entry next to Google/DeepL: no account, no
premium plan and no cloud request — the book text never leaves the device.

Server installation and model download are described in
[local-mt-server.md](local-mt-server.md).

## Defaults

| Setting | Default |
| --- | --- |
| Endpoint (web only) | `http://127.0.0.1:8080/v1` |
| Model (web only) | `hy-mt2-1.8b` |
| Temperature | `0.2` (settings JSON only, no UI yet) |
| Models directory (desktop only) | `localTranslator.modelsDir`, empty means the core's default |

The endpoint must include the API version path (`/v1`). A bare host such as
`127.0.0.1:8080` is normalised to `http://127.0.0.1:8080/v1`; a value without a
scheme gets `http://`. The model name must match what the server reports at
`GET /v1/models`. Desktop ignores both: it runs the GGUF directly (see
[Embedded engine](#embedded-engine-desktop)).

`local` is the default for new installations and for book configurations
created after the upgrade. Existing saved providers are never rewritten: an
existing user keeps DeepL/Google until they choose **Local Server** themselves.

## Enable

Desktop needs no server: install the GGUF (see
[local-mt-server.md](local-mt-server.md)) and pick **Local Server**.

Web:

1. Start the server: `scripts/bilireader-mt-server.sh` (see
   [local-mt-server.md](local-mt-server.md)).
2. Settings → Language → Translation Service → **Local Server**.
3. Optionally adjust **Endpoint** and **Model**; edits are saved on blur.
4. Press **Test**. It calls `GET /v1/models` (falling back to `/health` on
   older builds) and shows `Connected` or the reason it failed.

On desktop **Test** asks the core instead (`local_engine_status`): it reports
`Connected` when the model is loaded, otherwise the engine's reason (for
example `model missing: <path>`).

The provider is available in the reader translation popup as well; selecting it
there persists to the global read settings.

## Embedded engine (desktop)

The desktop app links llama.cpp in-process (`llama-cpp-2`); no child process,
no port, no CORS. `src/services/translators/providers/local.ts` selects the
transport with `isTauriAppPlatform()`:

- desktop → `invoke('translate_local', { jobId, text, context })` per paragraph
- web → the OpenAI-compatible HTTP path described above

Rust commands (`src-tauri/src/translation_core/commands.rs`):

| Command | Arguments | Returns |
| --- | --- | --- |
| `local_engine_status` | `modelsDir` (empty = default) | `CoreStatus` (`ready`, `engine`, `model_path`, `n_ctx`, `threads`, `error`) |
| `translate_local` | `jobId`, `text`, `context` | `{ job_id, text, tokens, ms, cancelled }` |
| `cancel_translation` | `jobId` | `true` when the job was known |

Token deltas are emitted as `translation://token` (`{ job_id, delta }`); the
provider itself waits for the whole paragraph.

Model resolution: `BIREADER_MODEL_PATH` if set, otherwise
`<modelsDir>/Hy-MT2-1.8B-Q4_K_M.gguf`. The model is downloaded from
HuggingFace (`tencent/Hy-MT2-1.8B-GGUF`, Q4_K_M quantisation); see
[local-mt-server.md](local-mt-server.md) for the file list and checksum. A
missing model is not a crash: the status reports `ready: false` and the first
translation fails with `Local Translator Unavailable: …install…`.

Paragraphs are translated one at a time: the engine is single-threaded, so
concurrent IPC calls would only queue. `AbortSignal` cancels the active job via
`cancel_translation`, and the provider stops the loop; a `cancelled: true`
result is surfaced as an `AbortError`, not a translation.

### Verify by hand on desktop

1. Put the GGUF in the models directory (or export `BIREADER_MODEL_PATH`).
2. `scripts/bilireader-run.sh`, open a book, translate a paragraph.
3. Press **Test** in Settings → Language: expect `Connected`.
4. Move the GGUF away and translate again: expect
   `Local Translator Unavailable: the embedded translation model is not
   installed…`, with no cloud fallback.
5. Restore the file, translate a long paragraph and cancel/close the popup
   mid-flight: the next paragraph must not be sent (watch
   `translation://token` in the devtools console).

## Verify from the shell

```sh
curl -s http://127.0.0.1:8080/v1/models
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"hy-mt2-1.8b","messages":[{"role":"system","content":"Translate into French."},{"role":"user","content":"Hello"}],"temperature":0.2}'
```

The first command should list `hy-mt2-1.8b`; the second returns a
`choices[0].message.content` translation.

## When it fails

There is no silent fallback: a dead local server produces a translation error,
not a Google translation. The popup's detail line shows one of:

- `Local Translator Unavailable: cannot reach <endpoint>. Start llama-server or
  change the endpoint in Settings → Language.` — server not running, wrong
  port/host or a network sandbox blocking loopback.
- `Local Translator Unavailable: <endpoint>/chat/completions returned 404 — the
  endpoint should end with /v1` — endpoint points at the server root or a
  different path.
- `Local Translator Unavailable` plus a timeout/abort message — the model did
  not answer within 180 s. Reduce the endpoint load or use a smaller model.
- `Local Translator Unavailable: the embedded translation model is not
  installed…` (desktop) — no GGUF at the resolved path; the HTTP endpoint is
  never used as a fallback there.
- `Local Translator Unavailable: the embedded translation engine is not loaded`
  (desktop) — `local_engine_status` failed, e.g. a broken GGUF; the status
  `error` names the cause.

Fix the server first, then press **Test** again. Switching the provider back to
Google/DeepL is always possible from the same dropdown.

## Cache behaviour

Translations are cached under `<transport>#local#<hash>`, where `transport` is
`embedded` (desktop) or `http` (web) and the hash folds the endpoint, the model
and the rendered prompt. A paragraph translated by the embedded core and one
translated by an HTTP server therefore never share a cache entry, and changing
the model or the endpoint cannot return a translation produced by the old
configuration. Changing only temperature does not invalidate the cache.

## Difference from Custom Translators

| | Local Server | Custom Translator |
| --- | --- | --- |
| Premium required | No | Yes |
| Account/token | No | No for OpenAI-compatible endpoints |
| Configuration | Endpoint + model | Endpoint, key, model, prompt, batching |
| Default provider | Yes (new installs/books) | Never |
| Transport | Embedded llama.cpp core (desktop) or OpenAI-compatible HTTP (web) | OpenAI-compatible HTTP via the same factory |

Use **Local Server** for the bundled llama.cpp setup. Use a Custom Translator
when you need an API key, a non-default prompt or several endpoints side by
side.

## Web builds

The web build always uses the HTTP transport described above: the browser's
`fetch` is used, an HTTPS page cannot call `http://127.0.0.1` (mixed content),
and the server must send CORS headers. `requiresApp` is `false`, but a
plain-HTTP dev server such as `pnpm dev-web` is the supported web scenario.
The desktop build ignores the endpoint entirely, so a desktop settings export
carrying a stale endpoint is harmless.
