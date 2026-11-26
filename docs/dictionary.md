# Bundled dictionary (FreeDict EN–RU)

Readest ships one offline dictionary so a tap on a single English word is
answered locally, without a network round-trip or an LLM call. The existing
translation path is still the fallback for phrases and for words the
dictionary does not contain.

## Source and license

| | |
|---|---|
| Dictionary | English–Русский FreeDict+WikDict dictionary (en–ru) |
| Version | 2025.11.23 |
| Publisher | Karl Bartel / [FreeDict](https://freedict.org/), generated with WikDict |
| Download | <https://download.freedict.org/dictionaries/eng-rus/2025.11.23/freedict-eng-rus-2025.11.23.stardict.tar.xz> |
| License | [CC BY-SA 3.0 Unported](https://creativecommons.org/licenses/by-sa/3.0/) |

The dictionary **data** is licensed under CC BY-SA 3.0. That copyleft applies
to the data and to adaptations of the data (for example, a modified or
extended copy of the dictionary). It does not apply to the Readest
application source code, which is licensed separately and merely reads the
data.

`public/dicts/freedict-eng-rus/` contains:

- `freedict-eng-rus.ifo` — StarDict metadata (`sametypesequence=h`).
- `freedict-eng-rus.idx` — sorted headword index (the upstream `.idx.gz`,
  decompressed).
- `freedict-eng-rus.dict.dz` — DictZip body (388 chunks). Recompressed from
  the 22.6 MB raw `.dict` so lookups inflate one chunk instead of the whole
  file.
- `LICENSE` — full CC BY-SA 3.0 legal code.
- `ATTRIBUTION.md` — name, version, source URL, checksum, build date and the
  list of changes.

Total payload: ~6.5 MB.

## Lookup flow

1. Single word selection → bundled dictionary, exact headword (case
   insensitive). Homographs are rendered in `.idx` order, so `dog` shows the
   noun and verb entries.
2. Exact miss → `buildLookupCandidates` appends English lemma candidates
   (`ran` → `run`, `children` → `child`). The same candidate list is used by
   the dictionary popup itself.
3. Dictionary miss, phrase, disabled provider, or missing/corrupt asset →
   the existing translator path (local MT or configured provider).

The provider is `builtin:freedict-eng-rus` (`kind: 'stardict'`,
`src/services/dictionaries/providers/freedictProvider.ts`). It reads the
static assets with `fetch('/dicts/freedict-eng-rus/...')`, so it works in the
web build and in Tauri's asset protocol alike; there is no download and no
app-data-directory permission. `StarDictReader` serves both the bundled
bundle and user-imported `.dict`/`.dict.dz` bundles unchanged.

A warm lookup costs a handful of `.idx` blob slices plus one DictZip chunk
inflate; the unit suite asserts the average stays below 10 ms. The first
lookup pays a one-time asset load (and a `lookup` miss is harmless — the
caller falls back to MT).

## Updating the dictionary

1. Pick a newer release under
   <https://download.freedict.org/dictionaries/eng-rus/> and download the
   `.stardict.tar.xz` plus its `.sha512`; verify the checksum.
2. Extract it. The archive contains `*.ifo`, `*.idx.gz`, `*.dict`, `COPYING`.
3. `gzip -dk eng-rus.idx.gz` and rename the files to
   `freedict-eng-rus.{ifo,idx,dict.dz}`.
4. Recompress `eng-rus.dict` as DictZip. Any DictZip implementation works;
   the resulting file must keep the FEXTRA `RA` subfield (the reader detects
   it and otherwise falls back to whole-file gunzip).
5. Replace the three binary files, `LICENSE`, and update
   `ATTRIBUTION.md` (version, URL, checksum, date, changes).
6. Run `vitest run src/__tests__/services/dictionaries/freedictProvider.test.ts`.
   The test reads the real files from `public/dicts/freedict-eng-rus/` and
   checks the word count, exact hits, homographs, lemma fallback and the warm
   lookup budget.
7. Keep the payload under 15 MB; prefer DictZip over a raw `.dict`.

## Adding another language

1. Put the bundle under `public/dicts/<language>/` with the same four-file
   layout (`ifo`, `idx`, `dict.dz`, `LICENSE`, `ATTRIBUTION.md`).
2. Add an id to `BUILTIN_PROVIDER_IDS` in
   `src/services/dictionaries/types.ts`, and a label in `builtinLabel()`
   (`src/components/settings/CustomDictionaries.tsx`).
3. Create a provider like `freedictProvider.ts`: the factory already accepts
   a `FreedictSource` (`basePath` + optional `fetcher`), but the filenames are
   the EN–RU ones. Parameterise the filenames (or copy the module) and expose
   a singleton.
4. Register the singleton in `builtinFor()` in
   `src/services/dictionaries/registry.ts` and seed it in
   `DEFAULT_DICTIONARY_SETTINGS` (`src/store/customDictionaryStore.ts`). The
   store backfills new defaults into existing users' `providerOrder`.
5. Route lookups by language in `lookupLocalDictionaryWord`
   (`src/services/dictionaries/wordLookup.ts`) — the bundled EN–RU provider
   should only answer English selections.
6. Add a fixture-backed test next to `freedictProvider.test.ts`.
