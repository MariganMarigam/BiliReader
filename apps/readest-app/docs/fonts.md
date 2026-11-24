# Fonts

## Bundled offline fonts

Readest ships paraType's PT Serif and PT Sans so Cyrillic (and Latin) text still
renders when Google Fonts is unreachable. The files live in `public/fonts/` and
are registered as local `@font-face` rules — no network request is involved:

| Family            | Directory            | Faces                                    |
| ----------------- | -------------------- | ---------------------------------------- |
| `PT Serif (offline)` | `public/fonts/ptserif/` | Regular, Bold, Italic, BoldItalic (TTF) |
| `PT Sans (offline)`  | `public/fonts/ptsans/`  | Regular, Bold, Italic, BoldItalic (TTF) |

Both families are usable in Settings → Font (interface) and in the book font
panel. The two `@font-face` blocks live in:

- `src/styles/globals.css` — top-level UI (settings previews, custom font cards);
- `src/styles/fonts.ts` (`getOfflineFontFaces`) — mounted into every reader
  iframe by `mountAdditionalFonts`.

The resolved serif and sans-serif chains end with these families, just before
the generic `serif` / `sans-serif` keyword, so an offline device degrades to a
shipped typeface instead of the platform default. The default document font
(`Bitter`) is unchanged.

### License

PT Serif and PT Sans are © ParaType, released under the SIL Open Font License
1.1. The license text is bundled next to the binaries as `OFL.txt` in each
directory. Source: <https://github.com/google/fonts/tree/main/ofl/ptserif> and
<https://github.com/google/fonts/tree/main/ofl/ptsans>.

Font files total ~3 MB (limit for the bundled set is 8 MB).

## Importing custom fonts

Settings → Font → Custom Fonts → **Import Font**. Supported formats: `.ttf`,
`.otf`, `.woff`, `.woff2` (Android's picker asks the native side for an
unfiltered dialog because SAF has no reliable MIME mapping for font files; the
web picker re-checks the extension after selection).

Import validation is strict:

- the container signature must be sfnt (`0x00010000`), `true`, `OTTO`, `wOFF`
  or `wOF2` — anything else is rejected with an error naming the file;
- a file may not exceed **20 MB**;
- the library holds at most **50** imported fonts; importing past that shows an
  error until one is deleted.

Rejected files never reach the filesystem, so no orphaned bundle directories
are created. The limits and their messages are defined in
`src/utils/font.ts` (`validateFontData`, `MAX_CUSTOM_FONTS`) and enforced by
`src/services/fontService.ts` (size/signature) and
`src/components/settings/CustomFonts.tsx` (count, error toasts).
