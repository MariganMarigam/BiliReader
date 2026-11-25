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
      "url": "https://github.com/<owner>/<repo>/releases/download/models-v1/Hy-MT2-1.8B-Q4_K_M.gguf",
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

- `id`, `kind`, `lang_pair`, `url`, `license`, `display_name` — non-empty strings
- `kind` — `translation` or `dictionary`
- `url` — absolute `http(s)`
- `size_bytes`, `min_ram_mb` — positive integers
- `sha256` — 64 hex characters

The **asset file name must stay `Hy-MT2-1.8B-Q4_K_M.gguf`**: Rust loads
`models_dir.join(MODEL_FILENAME)` (`src-tauri/src/translation_core/mod.rs`) and
the installer names the file after the URL basename.

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
4. SHA-256 is computed in 4 MB chunks; a mismatch deletes the part file.
5. Atomic `rename` into place, `.tmp` cleaned up, then `local_engine_status`
   is invoked so the engine loads immediately.

Errors surface as `ModelInstallError` codes: `network`, `checksum`, `disk`,
`cancelled`, `unsupported`.

## How to update the model

1. Download the new GGUF, compute `sha256sum`, note the byte size.
2. Upload it as an asset to a new GitHub Release tag (e.g. `models-v2`).
3. Update `url`, `size_bytes`, `sha256`, and `display_name` in
   `public/models/manifest.json`.
4. Run `tsc`, the model tests, and rebuild the app — the manifest is compiled
   into the bundle, so an app update is required to change it.

## Publishing a release asset

```sh
sha256sum Hy-MT2-1.8B-Q4_K_M.gguf
gh release create models-v1 Hy-MT2-1.8B-Q4_K_M.gguf \
  --title "Translation model v1" \
  --notes "Hy-MT2-1.8B Q4_K_M, Apache-2.0"
```

GitHub Release assets support `Range`, which is what resume relies on.

## Limits

- One translation entry per manifest; the panel shows the first one.
- No background or automatic download — the user must press *Download*.
- Desktop (Tauri) only: the web build has no embedded engine and the panel is hidden.
- Free disk space is reported as unknown on desktop (no Rust command exposes it;
  Rust changes are out of scope for this stage). A full disk surfaces as a `disk`
  error during download.
- A model outside the app-managed folder can be shown and used, but deleting it
  from the panel may be refused by the filesystem scope — remove it manually.
