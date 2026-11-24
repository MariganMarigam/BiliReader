import { useEffect, useRef, useState } from 'react';
import { offsetFromPosition, rangeFromOffsets, sentenceAt } from 'foliate-js/text-index.js';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslator } from '@/hooks/useTranslator';
import type { UseTranslatorOptions } from '@/services/translators';
import { getCaretPosition } from '../utils/crossDocSelection';
import { toParentViewportPoint } from '../utils/annotatorUtil';
import { getSectionEntry, primeSection, type DocSentenceIndex } from '../utils/sentenceIndex';
import { hideSentenceHighlight, showSentenceHighlight } from '../utils/sentenceHighlight';

// A held line is a two-step gesture: the press has to stay put this long before
// it engages, so a tap and a swipe both keep their page-turn. 400 ms matches the
// platform long-press feel without eating a deliberate short tap.
const HOLD_MS = 400;
// Drift past this many CSS px before the hold means a swipe, not a settle.
const HOLD_SLOP_PX = 8;
// How far past the held line's top/bottom edge the pointer must travel before
// it counts as pointing at the neighbouring sentence (a fraction of line height).
const SWITCH_RATIO = 0.8;
// Two switches closer than this are one gesture: the second waits for the rest.
const SWITCH_DEBOUNCE_MS = 120;
// Idle time after a switch before the neighbouring sentences are prefetched.
const PREFETCH_IDLE_MS = 250;

// Only the y of a converted point is used; passing x = 0 makes that explicit.
const CONVERT_X = 0;

/** Where the popup anchors, in window coordinates. */
export interface SentenceHoldAnchor {
  x: number;
  top: number;
  bottom: number;
}

export interface SentenceHoldState {
  /** Spine index of the section the held line belongs to. */
  index: number;
  sentenceIdx: number;
  /** The held sentence, as the popup shows it above the translation. */
  text: string;
  anchor: SentenceHoldAnchor;
  /** The translation has settled (either way). */
  ready: boolean;
  translation: string | null;
  error: string | null;
}

interface WindowPoint {
  x: number;
  y: number;
}

interface Press {
  doc: Document;
  index: number;
  pointerId: number;
  /** iframe CSS px, for the caret lookup. */
  x: number;
  y: number;
  /** window-relative, for the stillness check across frames. */
  window: WindowPoint;
}

interface ActiveLine {
  doc: Document;
  spineIndex: number;
  sentenceIdx: number;
  range: Range;
  text: string;
  index: DocSentenceIndex;
  sentences: Array<[number, number]>;
  /** Geometry of the held sentence in iframe CSS px. */
  top: number;
  bottom: number;
  lineHeight: number;
}

interface LineGeometry {
  top: number;
  bottom: number;
  lineHeight: number;
}

/**
 * The held-line gesture: point at a line, hold still, and the sentence under it
 * is highlighted in the overlayer and translated in the popup.
 *
 * The hook owns the state machine only; the listeners stay with
 * `useTextSelector`, which already owns the pointer gesture and its latches.
 * Nothing here calls `preventDefault`, so a tap or swipe that bows out keeps its
 * native page-turn.
 *
 * @param bookKey The reader book key, for the view and its settings.
 */
export const useSentenceHold = (bookKey: string) => {
  const { getView, getViewSettings } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const { settings } = useSettingsStore();

  const viewSettings = getViewSettings(bookKey);
  const book = getBookData(bookKey)?.book;
  // Instantiated with the gesture even when the feature is off, so the store may
  // still be short of its read settings; the defaults match the translator's.
  const readSettings = settings?.globalReadSettings;
  const { translate } = useTranslator({
    provider: readSettings?.translationProvider ?? 'deepl',
    sourceLang: viewSettings?.translateSourceLang ?? 'AUTO',
    targetLang: readSettings?.translateTargetLang ?? 'EN',
    promptId: viewSettings?.translationPromptId,
    bookTitle: book?.title,
    bookAuthor: book?.author,
  } as UseTranslatorOptions);

  const [state, setState] = useState<SentenceHoldState | null>(null);

  const press = useRef<Press | null>(null);
  const active = useRef<ActiveLine | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trailingSwitch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const framePending = useRef(false);
  const pendingMove = useRef<{ doc: Document; ev: PointerEvent } | null>(null);
  const generation = useRef(0);
  const lastSwitchAt = useRef(0);
  const prefetched = useRef(new Set<string>());
  const warned = useRef(false);

  // Long press belongs to the highlight quick action when it is armed: the two
  // must never both claim the same still hold.
  const isEnabled = (): boolean => {
    const settings = getViewSettings(bookKey);
    if (!settings?.sentenceTranslateEnabled) return false;
    return !(
      settings.enableAnnotationQuickActions && settings.annotationQuickAction === 'highlight'
    );
  };

  const clearTimers = () => {
    if (timer.current) clearTimeout(timer.current);
    if (trailingSwitch.current) clearTimeout(trailingSwitch.current);
    if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
    timer.current = null;
    trailingSwitch.current = null;
    prefetchTimer.current = null;
  };

  const cancel = () => {
    clearTimers();
    press.current = null;
    generation.current++;
    const held = active.current;
    active.current = null;
    if (held) {
      const view = getView(bookKey);
      if (view) {
        view.renderer.scrollLocked = false;
        hideSentenceHighlight(view, held.spineIndex);
      }
    }
    setState(null);
  };

  // Top/bottom/line height of the range, in iframe CSS px. One layout read per
  // engage or switch, never per pointermove.
  const measure = (range: Range): LineGeometry | null => {
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let lineHeight = 0;
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
      lineHeight = Math.max(lineHeight, rect.height);
    }
    if (!Number.isFinite(top) || bottom <= top) return null;
    return { top, bottom, lineHeight: lineHeight || bottom - top };
  };

  const anchorFor = (doc: Document, geometry: LineGeometry, x: number): SentenceHoldAnchor => {
    const top = toParentViewportPoint(doc, CONVERT_X, geometry.top);
    const bottom = toParentViewportPoint(doc, CONVERT_X, geometry.bottom);
    return { x, top: top.y, bottom: bottom.y };
  };

  const prefetchNeighbours = () => {
    if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
    prefetchTimer.current = setTimeout(() => {
      prefetchTimer.current = null;
      const current = active.current;
      if (!current) return;
      for (const next of [current.sentenceIdx - 1, current.sentenceIdx + 1]) {
        const bounds = current.sentences[next];
        if (!bounds) continue;
        const text = current.index.text.slice(bounds[0], bounds[1]);
        if (!text || prefetched.current.has(text)) continue;
        // Bounded: the text is only remembered to avoid re-asking for it.
        if (prefetched.current.size > 256) prefetched.current.clear();
        prefetched.current.add(text);
        // Warms the local cache the popup reads, so switching lines is instant.
        translate([text], { useCache: true }).catch(() => {});
      }
    }, PREFETCH_IDLE_MS);
  };

  const requestTranslation = (held: ActiveLine) => {
    const gen = ++generation.current;
    translate([held.text], { useCache: true })
      .then((result) => {
        if (gen !== generation.current) return;
        setState((prev) =>
          prev ? { ...prev, translation: result[0] ?? null, ready: true } : prev,
        );
      })
      .catch((error: unknown) => {
        if (gen !== generation.current) return;
        setState((prev) =>
          prev
            ? {
                ...prev,
                ready: true,
                error: error instanceof Error ? error.message : String(error),
              }
            : prev,
        );
      });
    prefetchNeighbours();
  };

  // Move the hold to another sentence of the same section.
  const switchTo = (sentenceIdx: number) => {
    const held = active.current;
    const view = getView(bookKey);
    if (!held || !view) return;
    const bounds = held.sentences[sentenceIdx];
    if (!bounds) return;
    const range = rangeFromOffsets(held.index, bounds[0], bounds[1]);
    if (!range) return;
    const geometry = measure(range);
    if (!geometry) return;
    lastSwitchAt.current = Date.now();
    const next: ActiveLine = {
      ...held,
      sentenceIdx,
      range,
      text: held.index.text.slice(bounds[0], bounds[1]),
      ...geometry,
    };
    active.current = next;
    showSentenceHighlight(view, held.spineIndex, range);
    // A mouse press that turned into a drag leaves a native selection over the
    // strip; the line highlight is the only selection this gesture shows.
    held.doc.getSelection()?.removeAllRanges();
    setState((prev) =>
      prev
        ? {
            ...prev,
            sentenceIdx,
            text: next.text,
            ready: false,
            translation: null,
            error: null,
            anchor: anchorFor(held.doc, geometry, prev.anchor.x),
          }
        : prev,
    );
    requestTranslation(next);
  };

  // One step towards the neighbouring sentence; at a section edge the adjacent
  // section is indexed instead (its text is prefetched, not its view).
  const stepTo = (delta: number) => {
    const held = active.current;
    if (!held) return;
    const view = getView(bookKey);
    if (!view) return;
    const next = held.sentenceIdx + delta;
    if (next < 0 || next >= held.sentences.length) {
      const neighbour = next < 0 ? held.spineIndex - 1 : held.spineIndex + 1;
      const count = view.book?.sections?.length ?? 0;
      if (neighbour >= 0 && neighbour < count) void primeSection(view, neighbour);
      return;
    }
    const now = Date.now();
    if (now - lastSwitchAt.current < SWITCH_DEBOUNCE_MS) {
      if (trailingSwitch.current) return;
      trailingSwitch.current = setTimeout(() => {
        trailingSwitch.current = null;
        stepTo(delta);
      }, SWITCH_DEBOUNCE_MS);
      return;
    }
    switchTo(next);
  };

  const handleMove = (doc: Document, ev: PointerEvent) => {
    const started = press.current;
    const held = active.current;
    if (!held) {
      if (!started) return;
      const frameRect = doc.defaultView?.frameElement?.getBoundingClientRect();
      const x = ev.clientX + (frameRect?.left ?? 0);
      const y = ev.clientY + (frameRect?.top ?? 0);
      if (Math.hypot(x - started.window.x, y - started.window.y) > HOLD_SLOP_PX) cancel();
      return;
    }
    const y = ev.clientY;
    if (y < held.top - SWITCH_RATIO * held.lineHeight) stepTo(-1);
    else if (y > held.bottom + SWITCH_RATIO * held.lineHeight) stepTo(1);
  };

  const engage = () => {
    timer.current = null;
    const started = press.current;
    if (!started) return;
    const view = getView(bookKey);
    if (!view) return cancel();
    const position = getCaretPosition(started.doc, started.x, started.y);
    if (!position) return cancel();
    const entry = getSectionEntry(view, started.index);
    if (!entry) return cancel();
    const offset = offsetFromPosition(entry.index, position.node, position.offset);
    if (offset < 0) return cancel();
    const sentenceIdx = sentenceAt(entry.index, offset);
    if (sentenceIdx < 0) return cancel();
    const bounds = entry.index.sentences[sentenceIdx];
    if (!bounds) return cancel();
    const range = rangeFromOffsets(entry.index, bounds[0], bounds[1]);
    if (!range) return cancel();
    const geometry = measure(range);
    if (!geometry) return cancel();
    view.renderer.scrollLocked = true;
    const held: ActiveLine = {
      doc: started.doc,
      spineIndex: started.index,
      sentenceIdx,
      range,
      text: entry.index.text.slice(bounds[0], bounds[1]),
      index: entry.index,
      sentences: entry.index.sentences as Array<[number, number]>,
      ...geometry,
    };
    active.current = held;
    if (!showSentenceHighlight(view, started.index, range) && !warned.current) {
      warned.current = true;
      console.warn('[sentence-hold] the section has no overlayer yet; popup only');
    }
    setState({
      index: started.index,
      sentenceIdx,
      text: held.text,
      anchor: anchorFor(started.doc, geometry, started.window.x),
      ready: false,
      translation: null,
      error: null,
    });
    requestTranslation(held);
  };

  /**
   * Arm the hold on pointer-down.
   *
   * @returns `true` when this press belongs to the gesture, so the caller can
   *   keep it away from the drag-selection paths. No `preventDefault` happens
   *   here: until the timer fires the press is a plain press.
   */
  const arm = (doc: Document, index: number, ev: PointerEvent): boolean => {
    if (ev.button !== 0) return false;
    if (!isEnabled()) return false;
    if (active.current) return false;
    if (timer.current) clearTimeout(timer.current);
    const frameRect = doc.defaultView?.frameElement?.getBoundingClientRect();
    press.current = {
      doc,
      index,
      pointerId: ev.pointerId,
      x: ev.clientX,
      y: ev.clientY,
      window: { x: ev.clientX + (frameRect?.left ?? 0), y: ev.clientY + (frameRect?.top ?? 0) },
    };
    timer.current = setTimeout(engage, HOLD_MS);
    return true;
  };

  /** Feed the pointer move to the gesture (frame-coalesced: one per frame). */
  const onMove = (doc: Document, ev: PointerEvent) => {
    pendingMove.current = { doc, ev };
    if (framePending.current) return;
    framePending.current = true;
    const win = doc.defaultView;
    const schedule = win?.requestAnimationFrame?.bind(win) ?? globalThis.requestAnimationFrame;
    const run = () => {
      framePending.current = false;
      const move = pendingMove.current;
      pendingMove.current = null;
      if (move) handleMove(move.doc, move.ev);
    };
    if (schedule) schedule(run);
    else globalThis.setTimeout(run, 0);
  };

  /**
   * End the gesture's press.
   *
   * The highlight and the popup stay up (they belong to `cancel`/`dismiss`);
   * only the page-turn freeze is released.
   *
   * @returns `true` when a line was held, so the caller can consume the release
   *   instead of treating it as a tap.
   */
  const end = (_doc: Document, _index: number, _ev?: PointerEvent): boolean => {
    if (timer.current) clearTimeout(timer.current);
    if (trailingSwitch.current) clearTimeout(trailingSwitch.current);
    timer.current = null;
    trailingSwitch.current = null;
    press.current = null;
    if (!active.current) return false;
    const view = getView(bookKey);
    if (view) view.renderer.scrollLocked = false;
    return true;
  };

  const dismiss = () => cancel();

  useEffect(() => {
    return () => {
      // Unmounting mid-hold must not leave the section frozen.
      clearTimers();
      press.current = null;
      const held = active.current;
      active.current = null;
      if (!held) return;
      const view = getView(bookKey);
      if (!view) return;
      view.renderer.scrollLocked = false;
      hideSentenceHighlight(view, held.spineIndex);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  return { arm, onMove, end, cancel, dismiss, state, isHolding: () => active.current !== null };
};
