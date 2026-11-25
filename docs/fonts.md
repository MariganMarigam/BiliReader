# Fonts

The fork bundles two typefaces so a book still renders Cyrillic (and Latin) with
no network at all. Everything else in the font pickers is a system font or a
Google-hosted webfont that needs connectivity.

The implementation-level notes live in
[apps/readest-app/docs/fonts.md](../apps/readest-app/docs/fonts.md).

## What is bundled

ParaType's **PT Serif** and **PT Sans**, four faces each, shipped as TTF inside
the app package:

| Family               | Directory                            | Faces                                  | Size    |
| -------------------- | ------------------------------------ | -------------------------------------- | ------- |
| `PT Serif (offline)` | `apps/readest-app/public/fonts/ptserif` | Regular, Bold, Italic, BoldItalic      | ~1.4 MB |
| `PT Sans (offline)`  | `apps/readest-app/public/fonts/ptsans`  | Regular, Bold, Italic, BoldItalic      | ~1.7 MB |

Both directories carry the license text as `OFL.txt` next to the binaries. PT
Serif and PT Sans are © ParaType, released under the **SIL Open Font License
1.1**, which permits bundling and redistribution with the app as long as the
license ships alongside. Total bundled set: ~3.1 MB, against an 8 MB budget for
shipped fonts.

## How they are registered

Nothing is fetched. The files are declared as local `@font-face` rules in two
places:

- `src/styles/globals.css` — the top-level UI (settings previews, custom-font
  cards, library);
- `src/styles/fonts.ts` (`getOfflineFontFaces`) — injected into every reader
  iframe by `mountAdditionalFonts`, so the book view and footnote popups see the
  same faces.

Family names are defined once in `src/styles/offlineFonts.ts` and imported by
both the `@font-face` registry and the picker lists, so the strings cannot drift
apart.

## Choosing them in Settings

Both families appear by name in the font pickers:

- **Settings → Font → Serif / Sans-serif** lists `PT Serif (offline)` after
  `PT Serif` and `PT Sans (offline)` after `PT Sans` (`SERIF_FONTS` and
  `SANS_SERIF_FONTS` in `src/services/constants.ts`).
- The book font panel offers the same entries.

The resolved serif and sans-serif fallback chains end with the bundled families
just before the generic `serif` / `sans-serif` keyword, so a device with no
Google Fonts access degrades to a shipped typeface instead of the platform
default. The default document font (`Bitter`) is unchanged.

## Offline versus the Google-hosted families

`PT Serif` and `PT Sans` (without the suffix) are the Google Fonts versions: the
reader injects `https://fonts.googleapis.com/css2?...` stylesheets, so they only
render once the network answers. The `(offline)` variants are separate families
resolved from the package, identical in design, with zero requests. Same for
every other Google family in the picker (`Literata`, `Merriweather`,
`Vollkorn`, `Roboto`, `Open Sans`, …) — those are online-only. System families
(`Georgia`, `Helvetica`, `Times New Roman`) come from the OS and need no network.

Practical consequence: on a plane, in a Faraday-cage reader, or behind a
blocking firewall, books styled with a Google family fall through the chain to
the offline face; selecting the `(offline)` entry directly makes that
deterministic. **Cyrillic now works without a network connection** — before the
bundle, a disconnected device had no Cyrillic-capable fallback beyond whatever
the platform shipped, which on several Linux/Android configurations is a
Latin-only default.

## Importing your own fonts

Settings → Font → Custom Fonts → **Import Font**. Accepted extensions: `.ttf`,
`.otf`, `.woff`, `.woff2`. Validation is deliberately strict, and rejects before
anything is written to the Fonts store (no orphaned bundle directories):

- **Structural check** — the container signature must be sfnt (`0x00010000`),
  Apple `true`, `OTTO`, `wOFF` or `wOF2`. A renamed image or archive is refused
  with an error naming the file, instead of registering a card that renders
  nothing.
- **Size limit** — 20 MB per file (`MAX_FONT_FILE_SIZE`).
- **Count limit** — 50 imported fonts per library (`MAX_CUSTOM_FONTS`);
  importing beyond that fails until one is deleted.

Limits and messages live in `src/utils/font.ts` (`validateFontData`), enforced by
`src/services/fontService.ts` (size, signature) and
`src/components/settings/CustomFonts.tsx` (count, error toasts).

## Android

Android's Storage Access Framework has no reliable MIME mapping for `.ttf` and
`.otf`, so a MIME-filtered picker greys out exactly the files people want to
import. The fork therefore opens the SAF dialog unfiltered for font imports and
re-checks the extension after selection (`src/hooks/useFileSelector.ts`). On the
web the same post-selection check runs, because `accept` is only a hint — an
"All files" switch or a drag-and-drop bypasses it — and a rejected file raises a
toast listing the offending names.

The bundled faces need no Android-specific handling: they are ordinary assets
served from the app package and mounted with the same `@font-face` CSS.
