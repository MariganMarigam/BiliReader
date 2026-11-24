import { MAX_RECTS } from 'foliate-js/text-index.js';

import type { FoliateView } from '@/types/view';
import { getSectionEntry } from './sentenceIndex';

/** A client rect of a range, as the overlayer reports it (iframe CSS px). */
export interface LineRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  /** The page the rect sits on, when the section is paginated. */
  page?: { left: number; top: number; right: number; bottom: number } | null;
}

export interface SentenceHighlightOptions {
  color: string;
  padLeft: number;
  padRight: number;
  padY?: number;
  radius?: number;
}

/** One held line at a time: the key is book-wide, `add` replaces it. */
export const SENTENCE_HIGHLIGHT_KEY = 'sentence-hold';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LINE_TOLERANCE_PX = 2;
const DEFAULT_PAD_Y = 2;
const DEFAULT_RADIUS = 4;
const OPACITY = 0.22;
const COLOR = '#3b82f6';

const centreY = (rect: LineRect): number => (rect.top + rect.bottom) / 2;

const samePage = (a: LineRect, b: LineRect): boolean =>
  (a.page?.left ?? null) === (b.page?.left ?? null) &&
  (a.page?.top ?? null) === (b.page?.top ?? null);

/**
 * Fold the client rects of a range into visual lines.
 *
 * The geometry a rect carries survives the fold (the first rect of a line wins
 * for `page`), so the drawing step can stretch a line across its column.
 *
 * @param rects Client rects of one range, in any order.
 * @param tolerance Max distance between line centres that still counts as one
 *   line; 2 px absorbs the sub-pixel drift of a wrapped line.
 */
export const groupLineRects = (rects: LineRect[], tolerance = LINE_TOLERANCE_PX): LineRect[] => {
  const sorted = rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .slice(0, MAX_RECTS);
  const lines: LineRect[] = [];
  for (const rect of sorted) {
    const line = lines[lines.length - 1];
    if (line && samePage(line, rect) && Math.abs(centreY(rect) - centreY(line)) <= tolerance) {
      line.left = Math.min(line.left, rect.left);
      line.top = Math.min(line.top, rect.top);
      line.right = Math.max(line.right, rect.right);
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.width = line.right - line.left;
      line.height = line.bottom - line.top;
      continue;
    }
    lines.push({ ...rect });
  }
  return lines;
};

/**
 * Draw one strip per line, stretched to the column.
 *
 * A page-tiled rect is stretched to the column box (`page` minus the padding
 * the engine sets on the root element, which is the page margin); a scrolled
 * rect has no page, so it is stretched by the same padding around itself.
 * Pure: no layout reads, no DOM state.
 */
export const drawSentenceHighlight = (
  rects: LineRect[],
  options: SentenceHighlightOptions,
): SVGGElement => {
  const { color, padLeft, padRight, padY = DEFAULT_PAD_Y, radius = DEFAULT_RADIUS } = options;
  const g = document.createElementNS(SVG_NS, 'g') as SVGGElement;
  g.setAttribute('fill', color);
  g.setAttribute('pointer-events', 'none');
  g.style.pointerEvents = 'none';
  g.style.opacity = String(OPACITY);
  for (const line of groupLineRects(rects)) {
    const x = line.page ? line.page.left + padLeft : line.left - padLeft;
    const right = line.page ? line.page.right - padRight : line.right + padRight;
    const width = right - x;
    const height = line.height + padY * 2;
    if (width <= 0 || height <= 0) continue;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(line.top - padY));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    rect.setAttribute('rx', String(Math.min(radius, height / 2, width / 2)));
    rect.setAttribute('pointer-events', 'none');
    g.append(rect);
  }
  return g;
};

const rootPadding = (doc: Document): { padLeft: number; padRight: number } => {
  const style = doc.defaultView?.getComputedStyle(doc.documentElement);
  return {
    padLeft: Number.parseFloat(style?.paddingLeft ?? '') || 0,
    padRight: Number.parseFloat(style?.paddingRight ?? '') || 0,
  };
};

/**
 * Highlight a sentence in the section's overlayer.
 *
 * The overlayer owns the geometry: it re-reads the range on every re-layout and
 * keeps the highlight out of the content DOM.
 *
 * @returns `false` when the section is not rendered or has no overlayer yet;
 *   the caller then waits for `create-overlayer` instead of drawing.
 */
export const showSentenceHighlight = (
  view: FoliateView,
  spineIndex: number,
  range: Range,
): boolean => {
  const entry = getSectionEntry(view, spineIndex);
  const overlayer = entry?.overlayer;
  if (!entry || !overlayer?.add) return false;
  const { padLeft, padRight } = rootPadding(entry.doc);
  overlayer.add(SENTENCE_HIGHLIGHT_KEY, range, drawSentenceHighlight, {
    color: COLOR,
    padLeft,
    padRight,
  } satisfies SentenceHighlightOptions);
  return true;
};

/** Drop the highlight; a section without one is a no-op. */
export const hideSentenceHighlight = (view: FoliateView, spineIndex: number): void => {
  getSectionEntry(view, spineIndex)?.overlayer?.remove?.(SENTENCE_HIGHLIGHT_KEY);
};
