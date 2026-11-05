# Local translation provider

The `local` provider translates through an OpenAI-compatible server on this
machine (llama.cpp `llama-server` at `127.0.0.1:8080` by default). It is a
first-class entry next to Google/DeepL: no account, no premium plan and no
cloud request — the book text never leaves the device.

Server installation and model download are described in
[local-mt-server.md](local-mt-server.md).

## Defaults

| Setting | Default |
| --- | --- |
| Endpoint | `http://127.0.0.1:8080/v1` |
| Model | `hy-mt2-1.8b` |
| Temperature | `0.2` (settings JSON only, no UI yet) |

The endpoint must include the API version path (`/v1`). A bare host such as
`127.0.0.1:8080` is normalised to `http://127.0.0.1:8080/v1`; a value without a
scheme gets `http://`. The model name must match what the server reports at
`GET /v1/models`.

`local` is the default for new installations and for book configurations
created after the upgrade. Existing saved providers are never rewritten: an
existing user keeps DeepL/Google until they choose **Local Server** themselves.

## Enable

1. Start the server: `scripts/bilireader-mt-server.sh` (see
   [local-mt-server.md](local-mt-server.md)).
2. Settings → Language → Translation Service → **Local Server**.
3. Optionally adjust **Endpoint** and **Model**; edits are saved on blur.
4. Press **Test**. It calls `GET /v1/models` (falling back to `/health` on
   older builds) and shows `Connected` or the reason it failed.

The provider is available in the reader translation popup as well; selecting it
there persists to the global read settings.

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

Fix the server first, then press **Test** again. Switching the provider back to
Google/DeepL is always possible from the same dropdown.

## Cache behaviour

Translations are cached under `local#<hash>`, where the hash folds the endpoint,
the model and the rendered prompt. Changing the model or the endpoint therefore
cannot return a translation produced by the old configuration. Changing only
temperature does not invalidate the cache.

## Difference from Custom Translators

| | Local Server | Custom Translator |
| --- | --- | --- |
| Premium required | No | Yes |
| Account/token | No | No for OpenAI-compatible endpoints |
| Configuration | Endpoint + model | Endpoint, key, model, prompt, batching |
| Default provider | Yes (new installs/books) | Never |
| Transport | OpenAI-compatible HTTP via the same factory | Same factory |

Use **Local Server** for the bundled llama.cpp setup. Use a Custom Translator
when you need an API key, a non-default prompt or several endpoints side by
side.

## Web builds

In the desktop app the request goes through Tauri (`tauriFetch`) and loopback is
always reachable. In a web build the browser's `fetch` is used: an HTTPS page
cannot call `http://127.0.0.1` (mixed content), and the server must send CORS
headers. `requiresApp` is `false`, but a plain-HTTP dev server such as
`pnpm dev-web` is the supported web scenario.
