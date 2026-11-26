# Offline translation model

The embedded translator (llama.cpp + Hy-MT2-1.8B Q4_K_M) is **not bundled**. The
app ships a manifest and downloads the GGUF on request from Settings → Language
→ *Offline engine*.

Code: `src/services/models/manifest.ts` (manifest), `src/services/models/modelManager.ts`
(download/verify/remove), `src/components/settings/OfflineEnginePanel.tsx` (UI).

## Manifest

`apps/readest-app/public/models/manifest.json`, served at `/models/manifest.json`:

```json
{
  "version": 1,
  "models": [
    {
      "id": "hy-mt2-1.8b-q4_k_m",
      "kind": "translation",
      "lang_pair": "en-ru",
      "urls": [
        "https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/a0c709d9fac510f2c807aa3af52872340dc37a4a/Hy-MT2-1.8B-Q4_K_M.gguf"
      ],
      "size_bytes": 1133080448,
      "sha256": "dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699",
      "license": "Apache-2.0",
      "min_ram_mb": 3072,
      "display_name": "Hy-MT2 1.8B (Q4_K_M)"
    }
  ]
}
```

Rules enforced by `parseModelManifest` (a bad manifest fails loudly, never
reaches the downloader):

- `id`, `kind`, `lang_pair`, `license`, `display_name` — non-empty strings
- `kind` — `translation` or `dictionary`
- `urls` — non-empty array of unique absolute `http(s)` URLs; the first entry is
  the primary source, the rest are fallbacks tried in order
- `size_bytes`, `min_ram_mb` — positive integers
- `sha256` — 64 hex characters

The **asset file name must stay `Hy-MT2-1.8B-Q4_K_M.gguf`**: Rust loads
`models_dir.join(MODEL_FILENAME)` (`src-tauri/src/translation_core/mod.rs`) and
the installer names the file after the URL basename.

## Sources and failover

The primary source is Hugging Face, pinned to an immutable revision:

```
https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/<revision>/Hy-MT2-1.8B-Q4_K_M.gguf
```

`urls` is an array so more sources can be appended without a schema change. The
downloader tries them in order; failover is implemented in
`src/services/models/modelManager.ts` and works with any array length, including
the current single element.

Failover rules:

- A network error (including HTTP 403/404), a short download or a size mismatch
  moves on to the next URL.
- A checksum mismatch also moves on to the next URL; the corrupt part is deleted.
- Cancellation and disk errors never fail over — they are reported immediately.
- Resume is scoped to one URL: switching sources restarts at byte 0 unless the
  part file already hashes to the expected asset.
- When every source fails, the last error is surfaced as `ModelInstallError`.

Verification (last checked 2026-11-26):

```sh
curl -sIL -o /dev/null -w "%{http_code}\n" \
  https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/a0c709d9fac510f2c807aa3af52872340dc37a4a/Hy-MT2-1.8B-Q4_K_M.gguf
```

| Source | Response | Size |
| --- | --- | --- |
| Hugging Face (pinned revision) | `200` (after a `302` to the CDN) | 1 133 080 448 bytes |

### GitHub Release fallback (planned, not published)

A GitHub Release asset is intended as the second source. It is **not published
yet** and must not be added to `urls` until it exists. To add it later:

1. Upload the GGUF as an asset in a new release tag, e.g. `models-v1`, and wait
   for the upload to finish.
2. Confirm it is downloadable — a `302` to the asset CDN is the expected answer
   (GitHub serves `Range` requests):
   ```sh
   gh release view models-v1 --repo MariganMarigam/BiliReader --json assets \
     --jq '.assets[] | {name, size}'
   curl -sIL -o /dev/null -w "%{http_code}\n" \
     https://github.com/MariganMarigam/BiliReader/releases/download/models-v1/Hy-MT2-1.8B-Q4_K_M.gguf
   ```
3. Append the release URL as the second element of `urls`. No code change is
   needed: the manifest order is the try order.

## Where models live

| Role | Path |
| --- | --- |
| App-managed download target | `<appData>/Readest/bilireader/models/` — Linux `~/.local/share/com.bilireader.app/Readest/bilireader/models/` |
| Engine lookup | `settings.localTranslator.modelsDir`, else `BIREADER_MODELS_DIR`, else `<platform data_dir>/bilireader/models/` (Linux `~/.local/share/bilireader/models/`) |

The app-managed directory is used because the Tauri filesystem scope only
authorises `**/Readest/**`. After installing, the panel persists the absolute
directory into `localTranslator.modelsDir` so `local_engine_status` loads the
file that was just downloaded.

A model already sitting in `BIREADER_MODELS_DIR` or the engine default
directory is detected through `local_engine_status` and shown as *installed*;
nothing is re-downloaded and no scope access is needed to read it.

## Download behaviour

1. Free-space check (when the platform can report it).
2. Streaming download to `<models dir>/.tmp/<id>.part` (single connection, progress callback).
3. Interrupted? The next attempt keeps `.part` and requests `Range: bytes=<have>-`
   into `.part.tail`, merges it in 4 MB chunks, then continues. Servers that
   ignore `Range` restart the part file instead of corrupting it.
4. SHA-256 is computed in 4 MB chunks; a mismatch deletes the part file and
   falls through to the next URL in `urls`, if any.
5. Atomic `rename` into place, `.tmp` cleaned up, then `local_engine_status`
   is invoked so the engine loads immediately.

Errors surface as `ModelInstallError` codes: `network`, `checksum`, `disk`,
`cancelled`, `unsupported`.

## How to update the model

1. Download the new GGUF, compute `sha256sum`, note the byte size:
   ```sh
   sha256sum Hy-MT2-<version>.gguf
   stat -c %s Hy-MT2-<version>.gguf
   ```
2. Pin the new Hugging Face revision. Never use `main` or a branch name: the
   commit sha is the immutable identity of the bytes.
   ```sh
   curl -s https://huggingface.co/api/models/tencent/Hy-MT2-1.8B-GGUF | jq -r .sha
   ```
   Build the URL as
   `https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/<sha>/Hy-MT2-1.8B-Q4_K_M.gguf`.
3. Confirm the URL and its size before editing the manifest:
   ```sh
   curl -sIL <url> | grep -iE '^HTTP|^content-length|x-linked-size'
   ```
   A `302` to the CDN and a final `200` with `content-length: 1133080448` (or the
   matching `x-linked-size`) is expected. A different size means STOP.
4. Update `urls` (Hugging Face first; append a GitHub Release URL only once that
   asset is actually published), `size_bytes`, `sha256`, and `display_name` in
   `apps/readest-app/public/models/manifest.json`.
5. Keep the asset name equal to the file name the Rust loader expects; if the
   new model is a different file, `MODEL_FILENAME` in
   `src-tauri/src/translation_core/mod.rs` must change with it.
6. Run `tsc`, the model tests, and rebuild the app — the manifest is compiled
   into the bundle, so an app update is required to change it.

## Publishing the fallback release (deferred)

Publication on GitHub is currently **postponed** (weak network); there are no
release assets. Use this only when the fallback is re-enabled, and never
overwrite an existing tag — installed builds pin checksums.

Keep the asset name equal to the file name the Rust loader expects.

Full notes template for a new tag:

```md
## Hy-MT2 <version> — offline translation model

| | |
| --- | --- |
| Size | <bytes> bytes |
| SHA-256 | `<sha256>` |
| License | Apache-2.0 |
| Language pair | en → ru |
| Min. RAM | 3072 MB |
```

```sh
sha256sum Hy-MT2-1.8B-Q4_K_M.gguf
gh release create models-v1 Hy-MT2-1.8B-Q4_K_M.gguf \
  --repo MariganMarigam/BiliReader \
  --title "Translation model v1 (Hy-MT2 1.8B Q4_K_M)" \
  --notes-file output/models-v1-release-notes.md --latest=false
```

Always pass `--repo`: `gh` otherwise resolves the repository from the remotes and
picks `upstream` (`readest/readest`), where the account cannot create releases
(`HTTP 404`). GitHub Release assets support `Range`, which is what resume relies
on; the upload takes several minutes for a ~1.1 GB file.

## Limits

- One translation entry per manifest; the panel shows the first one.
- No background or automatic download — the user must press *Download*.
- Desktop (Tauri) only: the web build has no embedded engine and the panel is hidden.
- Free disk space is reported as unknown on desktop (no Rust command exposes it;
  Rust changes are out of scope for this stage). A full disk surfaces as a `disk`
  error during download.
- A model outside the app-managed folder can be shown and used, but deleting it
  from the panel may be refused by the filesystem scope — remove it manually.
