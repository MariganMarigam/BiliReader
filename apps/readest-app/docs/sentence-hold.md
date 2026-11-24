# Sentence Translate on a Held Line

Hold a line still and the reader highlights that sentence and opens the
translator popup on it. Dragging up or down past the line moves the hold to the
previous or next sentence; releasing keeps the popup open, and a tap anywhere in
the reading area puts it away.

## The flag

`sentenceTranslateEnabled` in `ViewSettings` (see `TranslatorConfig` in
`src/types/book.ts`). **Off by default** — the switch is in
Settings → Language → Translation → *Translate a Held Line*. It stays off until
the model manager ships; once that lands the default flips on.

The setting is per book (`saveViewSettings(..., true /* per-book */, false)`), so
a reader can enable it for the book they are studying without changing every
book.

## Mutual exclusion with the highlight quick action

The highlight quick action (`enableAnnotationQuickActions` +
`annotationQuickAction === 'highlight'`) claims the same still press. While it is
armed:

- the switch is disabled and explains why, and
- `useSentenceHold(...).arm()` refuses to arm at all, whatever the flag says.

Instant annotation otherwise needs no cooperation: the hold never calls
`preventDefault` before its timer fires, so a tap or a swipe keeps its page
turn.

## Implementation

| Piece | Where |
|---|---|
| Sentence boundaries of a rendered section | `packages/foliate-js/text-index.js` (`buildTextIndex`) |
| Per-document index cache, adjacent-section priming | `src/app/reader/utils/sentenceIndex.ts` |
| Line strips drawn in the section's overlayer | `src/app/reader/utils/sentenceHighlight.ts` |
| The gesture state machine (400 ms hold, 8 px slop, 120 ms switch debounce, neighbour prefetch) | `src/app/reader/hooks/useSentenceHold.ts` |
| Pointer wiring, tap-to-dismiss | `src/app/reader/hooks/useTextSelector.ts` |
| Popup | the existing `TranslatorPopup`, anchored on the held line's geometry |

The highlight lives in the foliate overlayer under the `sentence-hold` key, so it
survives re-layout and never touches the content DOM. Translations are warmed
through `useTranslator({ useCache: true })` for the held sentence and its
neighbours, so line switching reads the local cache instead of the network.

Vertical writing and fonts that override the root padding are not supported:
with `viewSettings.vertical` the line is not highlighted (the popup still works).
