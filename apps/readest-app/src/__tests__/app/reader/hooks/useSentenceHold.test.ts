import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

// Holding a line still opens the sentence translation. The gesture must never
// claim a press early (a tap or swipe has to keep its page turn), must freeze
// pagination only once it engages, and must drop a stale translation when the
// line changes under a slower request.
const HOLD_MS = 400;
const DEBOUNCE_MS = 120;
const PREFETCH_MS = 250;
const LINE_TOP = 100;
const LINE_HEIGHT = 20;

const TEXT = 'Первое предложение здесь. Второе предложение здесь. Третье предложение здесь.';

const h = vi.hoisted(() => ({
  doc: null as unknown as Document,
  caret: null as unknown as { node: Node; offset: number },
  rects: [] as Array<{
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  }>,
  view: {
    renderer: { scrollLocked: false },
    book: { sections: [{}, {}, {}] },
  },
  viewSettings: {} as Record<string, unknown>,
  overlayer: { add: vi.fn(), remove: vi.fn() },
  translate: vi.fn<(input: string[], options?: { useCache?: boolean }) => Promise<string[]>>(),
  primeSection: vi.fn(async () => null),
  index: null as unknown as Record<string, unknown>,
  showSentenceHighlight: vi.fn(() => true),
  hideSentenceHighlight: vi.fn(),
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => h.view,
    getViewSettings: () => h.viewSettings,
  }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getBookData: () => ({ book: { title: 'T', author: 'A' } }) }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      globalReadSettings: { translationProvider: 'deepl', translateTargetLang: 'RU' },
    },
  }),
}));
vi.mock('@/hooks/useTranslator', () => ({
  useTranslator: () => ({ translate: h.translate }),
}));
vi.mock('@/app/reader/utils/crossDocSelection', () => ({
  getCaretPosition: () => h.caret,
}));
vi.mock('@/app/reader/utils/sentenceHighlight', () => ({
  showSentenceHighlight: h.showSentenceHighlight,
  hideSentenceHighlight: h.hideSentenceHighlight,
}));
vi.mock('@/app/reader/utils/sentenceIndex', () => ({
  getSectionEntry: () => ({ doc: h.doc, overlayer: h.overlayer, index: h.index }),
  primeSection: h.primeSection,
}));
import { buildTextIndex } from 'foliate-js/text-index.js';
import { useSentenceHold } from '@/app/reader/hooks/useSentenceHold';

// The index is built once from a real (jsdom) document so the offsets, the
// ranges and the sentence lookup are the shipped code, not a stub.
const INDEX = (() => {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html lang="ru"><body><p>${TEXT}</p></body></html>`,
    'text/html',
  );
  h.doc = doc;
  const index = buildTextIndex(doc.body, { locale: 'ru' });
  h.caret = { node: doc.querySelector('p')!.firstChild as Text, offset: 3 };
  return index;
})();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.view.renderer.scrollLocked = false;
  h.viewSettings = { sentenceTranslateEnabled: true };
  h.index = INDEX;
  h.rects = [
    {
      left: 0,
      top: LINE_TOP,
      right: 300,
      bottom: LINE_TOP + LINE_HEIGHT,
      width: 300,
      height: LINE_HEIGHT,
    },
  ];
  h.caret = { node: h.doc.querySelector('p')!.firstChild as Text, offset: 3 };
  h.translate.mockResolvedValue(['перевод']);
  h.showSentenceHighlight.mockReturnValue(true);
  // jsdom has no layout: the range geometry comes from the test.
  Range.prototype.getClientRects = function () {
    return h.rects.map((rect) => ({ ...rect, toJSON: () => rect })) as unknown as DOMRectList;
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pointerEvent = (x: number, y: number) =>
  ({ clientX: x, clientY: y, button: 0, pointerId: 1 }) as unknown as PointerEvent;

const setup = () => renderHook(() => useSentenceHold('book-1'));

// One animation frame: the pointer moves are coalesced onto it.
const frame = () => vi.advanceTimersByTimeAsync(20);

const holdStill = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HOLD_MS + 1);
  });
};

describe('useSentenceHold: arming and cancelling', () => {
  test('does not engage before the hold elapses', async () => {
    const { result } = setup();
    await act(async () => {
      expect(result.current.arm(h.doc, 0, pointerEvent(10, 110))).toBe(true);
      await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    });
    expect(result.current.state).toBeNull();
    expect(h.view.renderer.scrollLocked).toBe(false);
    expect(h.showSentenceHighlight).not.toHaveBeenCalled();
  });

  test('a move past the slop before the hold cancels it', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.arm(h.doc, 0, pointerEvent(10, 110));
      result.current.onMove(h.doc, pointerEvent(19, 110));
      await frame();
      await vi.advanceTimersByTimeAsync(HOLD_MS);
    });
    expect(result.current.state).toBeNull();
    expect(h.view.renderer.scrollLocked).toBe(false);
  });

  test('is not armed at all while the highlight quick action owns the hold', async () => {
    h.viewSettings = {
      sentenceTranslateEnabled: true,
      enableAnnotationQuickActions: true,
      annotationQuickAction: 'highlight',
    };
    const { result } = setup();
    await act(async () => {
      expect(result.current.arm(h.doc, 0, pointerEvent(10, 110))).toBe(false);
      await vi.advanceTimersByTimeAsync(HOLD_MS + 1);
    });
    expect(result.current.state).toBeNull();
  });

  test('is not armed when the setting is off (the default)', async () => {
    h.viewSettings = {};
    const { result } = setup();
    expect(result.current.arm(h.doc, 0, pointerEvent(10, 110))).toBe(false);
  });
});

describe('useSentenceHold: engagement', () => {
  test('engages the sentence under the point, freezes pagination and translates it', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.arm(h.doc, 0, pointerEvent(10, 110));
    });
    await holdStill();

    expect(h.view.renderer.scrollLocked).toBe(true);
    expect(h.showSentenceHighlight).toHaveBeenCalledTimes(1);
    const state = result.current.state!;
    expect(state.sentenceIdx).toBe(0);
    expect(state.text).toBe('Первое предложение здесь.');
    expect(state.anchor.top).toBe(LINE_TOP);
    expect(state.anchor.bottom).toBe(LINE_TOP + LINE_HEIGHT);
    expect(h.translate).toHaveBeenCalledWith(['Первое предложение здесь.'], { useCache: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.state!.translation).toBe('перевод');
    expect(result.current.state!.ready).toBe(true);
  });

  test('a stale translation never overwrites the newer line', async () => {
    const resolvers: Array<(value: string[]) => void> = [];
    h.translate.mockImplementation(
      () => new Promise<string[]>((resolve) => resolvers.push(resolve)),
    );
    const { result } = setup();
    await act(async () => {
      result.current.arm(h.doc, 0, pointerEvent(10, 110));
    });
    await holdStill();

    // Drag past the line's bottom edge: the next sentence becomes active.
    await act(async () => {
      result.current.onMove(h.doc, pointerEvent(10, 200));
      await frame();
      await vi.advanceTimersByTimeAsync(PREFETCH_MS);
    });
    expect(result.current.state!.sentenceIdx).toBe(1);

    await act(async () => {
      resolvers[0]!(['устаревший']);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.state!.translation).not.toBe('устаревший');
    expect(result.current.state!.sentenceIdx).toBe(1);

    await act(async () => {
      resolvers[1]!(['свежий']);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.state!.translation).toBe('свежий');
  });

  test('prefetches the neighbouring sentence once, after an idle moment', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.arm(h.doc, 0, pointerEvent(10, 110));
    });
    await holdStill();
    const afterEngage = h.translate.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREFETCH_MS);
    });
    expect(h.translate.mock.calls.length).toBe(afterEngage + 1);
    expect(h.translate).toHaveBeenCalledWith(['Второе предложение здесь.'], { useCache: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREFETCH_MS);
    });
    expect(h.translate.mock.calls.length).toBe(afterEngage + 1);
    expect(result.current.state!.sentenceIdx).toBe(0);
  });
});

describe('useSentenceHold: switching lines', () => {
  const engage = async () => {
    const hook = setup();
    await act(async () => {
      hook.result.current.arm(h.doc, 0, pointerEvent(10, 110));
    });
    await holdStill();
    return hook;
  };

  test('a drag past the line moves to the next sentence, inside it does nothing', async () => {
    const { result } = await engage();
    await act(async () => {
      result.current.onMove(h.doc, pointerEvent(10, 125));
      await frame();
    });
    expect(result.current.state!.sentenceIdx).toBe(0);

    await act(async () => {
      result.current.onMove(h.doc, pointerEvent(10, 200));
      await frame();
    });
    expect(result.current.state!.sentenceIdx).toBe(1);
    expect(result.current.state!.text).toBe('Второе предложение здесь.');
  });

  test('a second switch within the debounce waits for the rest of it', async () => {
    const { result } = await engage();
    await act(async () => {
      result.current.onMove(h.doc, pointerEvent(10, 200));
      await frame();
    });
    expect(result.current.state!.sentenceIdx).toBe(1);

    // Immediately after: still 1, the switch is deferred.
    await act(async () => {
      result.current.onMove(h.doc, pointerEvent(10, 200));
      await frame();
    });
    expect(result.current.state!.sentenceIdx).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(result.current.state!.sentenceIdx).toBe(2);
  });

  test('moving up from the first sentence of the first section is a dead end', async () => {
    const { result } = await engage();
    await act(async () => {
      result.current.onMove(h.doc, pointerEvent(10, 10));
      await frame();
    });
    expect(h.primeSection).not.toHaveBeenCalled();
    expect(result.current.state!.sentenceIdx).toBe(0);
  });

  test('moving up from the first sentence indexes the previous section', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.arm(h.doc, 1, pointerEvent(10, 110));
    });
    await holdStill();
    await act(async () => {
      result.current.onMove(h.doc, pointerEvent(10, 10));
      await frame();
    });
    expect(h.primeSection).toHaveBeenCalledWith(h.view, 0);
    expect(result.current.state!.sentenceIdx).toBe(0);
  });

  test('moving down from the last sentence indexes the next section', async () => {
    h.caret = { node: h.doc.querySelector('p')!.firstChild as Text, offset: TEXT.length - 5 };
    const { result } = await engage();
    expect(result.current.state!.sentenceIdx).toBe(2);

    await act(async () => {
      result.current.onMove(h.doc, pointerEvent(10, 200));
      await frame();
    });
    expect(h.primeSection).toHaveBeenCalledWith(h.view, 1);
    expect(result.current.state!.sentenceIdx).toBe(2);
  });
});

describe('useSentenceHold: release and cancel', () => {
  const engage = async () => {
    const hook = setup();
    await act(async () => {
      hook.result.current.arm(h.doc, 0, pointerEvent(10, 110));
    });
    await holdStill();
    return hook;
  };

  test('end releases the page-turn freeze but keeps the popup', async () => {
    const { result } = await engage();
    let consumed = false;
    await act(async () => {
      consumed = result.current.end(h.doc, 0, pointerEvent(10, 110));
    });
    expect(consumed).toBe(true);
    expect(h.view.renderer.scrollLocked).toBe(false);
    expect(result.current.state).not.toBeNull();
  });

  test('a release without a held line is not consumed', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.arm(h.doc, 0, pointerEvent(10, 110));
    });
    expect(result.current.end(h.doc, 0, pointerEvent(10, 110))).toBe(false);
  });

  test('cancel (pointercancel) drops the highlight, the freeze and the state', async () => {
    const { result } = await engage();
    await act(async () => {
      result.current.cancel();
    });
    expect(h.view.renderer.scrollLocked).toBe(false);
    expect(h.hideSentenceHighlight).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBeNull();
  });

  test('unmounting mid-hold releases the freeze', async () => {
    const { result, unmount } = await engage();
    await act(async () => {
      unmount();
    });
    expect(h.view.renderer.scrollLocked).toBe(false);
    expect(result.current.state).not.toBeNull();
  });
});
