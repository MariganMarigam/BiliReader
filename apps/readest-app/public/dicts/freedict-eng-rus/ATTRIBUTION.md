# FreeDict English–Russian dictionary

- **Dictionary:** English–Русский FreeDict+WikDict dictionary (en–ru)
- **Version:** 2025.11.23 (`date=2025-11-23` in the `.ifo`)
- **Publisher:** Karl Bartel / FreeDict, generated with WikDict
- **Project page:** https://freedict.org/
- **Download:** https://download.freedict.org/dictionaries/eng-rus/2025.11.23/freedict-eng-rus-2025.11.23.stardict.tar.xz
- **SHA-512 of the source archive:** `ffbfbbe9817dc9a2a84fb8556d99ba73b5bc572eab18f91988029adfc2a7917616dd20d13c94a99871857a047ce2a47a3538bde545f97065eb7e531d7a6ef4b4`
- **Packed into this repository:** 2026-11-26
- **License:** Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0), see `LICENSE`

## Changes made for bundling

- `eng-rus.idx.gz` was decompressed to `freedict-eng-rus.idx`.
- The 22.6 MB uncompressed `eng-rus.dict` was recompressed as a proper
  DictZip (`freedict-eng-rus.dict.dz`, 388 chunks) so the reader can
  decompress only the chunks a lookup touches.
- Everything else (headwords, definitions, pronunciation, part-of-speech
  markup) is unmodified FreeDict data.

The dictionary data remains under CC BY-SA 3.0. The application source code
is licensed separately; the share-alike obligation applies to the dictionary
data and to adaptations of it, not to the application that reads it.
