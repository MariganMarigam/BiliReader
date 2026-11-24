import { describe, expect, test, vi } from 'vitest';
import {
  drawSentenceHighlight,
  groupLineRects,
  hideSentenceHighlight,
  showSentenceHighlight,
  SENTENCE_HIGHLIGHT_KEY,
  type LineRect,
} from '@/app/reader/utils/sentenceHighlight';
import { clearSentenceIndexCache } from '@/app/reader/utils/sentenceIndex';
import type { FoliateView } from '@/types/view';

const docFrom = (html: string): Document =>
  new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');

const rect = (top: number, left = 0, right = 100, height = 20): LineRect => ({
  left,
  top,
  right,
  bottom: top + height,
  width: right - left,
  height,
});

const page = { left: 0, top: 0, right: 400, bottom: 600 };

const viewWith = (doc: Document, overlayer?: unknown): FoliateView =>
  ({
    renderer: {
      getContents: () => [{ index: 0, doc, overlayer }],
    },
  }) as unknown as FoliateView;

describe('groupLineRects', () => {
  test('folds rects whose line centres are within 2 px, splits past that', () => {
    // Same height, so the top distance is the centre distance.
    expect(groupLineRects([rect(10), rect(12)])).toHaveLength(1);
    expect(groupLineRects([rect(10), rect(13)])).toHaveLength(2);
  });

  test('keeps the page of the line it folds and spans its rects', () => {
    const lines = groupLineRects([
      { ...rect(10, 10, 60), page },
      { ...rect(12, 80, 120), page },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ left: 10, right: 120, top: 10, bottom: 32, page });
  });

  test('drops zero-width and zero-height rects', () => {
    expect(groupLineRects([rect(10, 0, 0), rect(20, 0, 50, 0)])).toHaveLength(0);
    expect(groupLineRects([rect(10), rect(10, 0, 0)])).toHaveLength(1);
  });

  test('never folds rects from two different pages into one line', () => {
    const lines = groupLineRects([
      { ...rect(10), page },
      { ...rect(11), page: { ...page, left: 400, right: 800 } },
    ]);
    expect(lines).toHaveLength(2);
  });
});

describe('drawSentenceHighlight', () => {
  test('stretches each page-tiled line across the column with the padding', () => {
    const rects = [
      { ...rect(10), page },
      { ...rect(40), page },
      { ...rect(70), page },
    ];
    const group = drawSentenceHighlight(rects, { color: '#3b82f6', padLeft: 20, padRight: 20 });
    const strips = Array.from(group.querySelectorAll('rect'));
    expect(strips).toHaveLength(3);
    for (const strip of strips) {
      expect(strip.getAttribute('x')).toBe('20');
      expect(strip.getAttribute('width')).toBe('360');
      expect(strip.getAttribute('pointer-events')).toBe('none');
    }
    expect(group.getAttribute('pointer-events')).toBe('none');
    expect(group.getAttribute('fill')).toBe('#3b82f6');
  });

  test('stretches a scrolled line by the padding around itself', () => {
    const group = drawSentenceHighlight([rect(10, 100, 300)], {
      color: '#fff',
      padLeft: 20,
      padRight: 20,
    });
    const strip = group.querySelector('rect')!;
    expect(strip.getAttribute('x')).toBe('80');
    expect(strip.getAttribute('width')).toBe('240');
    expect(strip.getAttribute('y')).toBe('8');
    expect(strip.getAttribute('height')).toBe('24');
  });

  test('skips a line the padding would invert', () => {
    const group = drawSentenceHighlight([{ ...rect(10), page: { ...page, right: 30 } }], {
      color: '#fff',
      padLeft: 20,
      padRight: 20,
    });
    expect(group.querySelectorAll('rect')).toHaveLength(0);
  });
});

describe('showSentenceHighlight', () => {
  test('returns false without an overlayer, and never throws', () => {
    const doc = docFrom('<p>Предложение здесь.</p>');
    clearSentenceIndexCache();
    expect(showSentenceHighlight(viewWith(doc), 0, doc.createRange())).toBe(false);
  });

  test('adds the range under the sentence key with the root padding', () => {
    const doc = docFrom('<p>Предложение здесь.</p>');
    const add = vi.fn();
    const remove = vi.fn();
    const view = viewWith(doc, { add, remove });
    const range = doc.createRange();
    clearSentenceIndexCache();

    expect(showSentenceHighlight(view, 0, range)).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    const [key, added, draw, options] = add.mock.calls[0]!;
    expect(key).toBe(SENTENCE_HIGHLIGHT_KEY);
    expect(added).toBe(range);
    expect(draw).toBe(drawSentenceHighlight);
    expect(options).toMatchObject({ color: expect.any(String), padLeft: 0, padRight: 0 });

    hideSentenceHighlight(view, 0);
    expect(remove).toHaveBeenCalledWith(SENTENCE_HIGHLIGHT_KEY);
  });

  test('hiding a section that is not rendered is a no-op', () => {
    const doc = docFrom('<p>Текст.</p>');
    const view = { renderer: { getContents: () => [] } } as unknown as FoliateView;
    expect(() => hideSentenceHighlight(view, 3)).not.toThrow();
    expect(showSentenceHighlight(view, 3, doc.createRange())).toBe(false);
  });
});
