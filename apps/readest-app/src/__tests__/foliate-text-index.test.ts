import { describe, expect, test } from 'vitest';
import {
  buildTextIndex,
  offsetFromPosition,
  rangeFromOffsets,
  sentenceAt,
} from 'foliate-js/text-index.js';
import { clearSentenceIndexCache, getDocIndex } from '@/app/reader/utils/sentenceIndex';

// The engine index is DOM-only: no geometry, no iframe. That makes it testable
// in jsdom and keeps the app free of a second text walker.
const docFrom = (html: string): Document =>
  new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');

const sentencesOf = (doc: Document, locale: string): string[] => {
  const index = buildTextIndex(doc.body, { locale });
  return (index.sentences as [number, number][]).map(([start, end]) =>
    index.text.slice(start, end),
  );
};

describe('buildTextIndex: text table', () => {
  test('nodes are adjacent and cover the whole text', () => {
    const doc = docFrom('<p>Hello <b>world</b>.</p><p>Second!</p>');
    const index = buildTextIndex(doc.body);
    expect(index.text).toBe('Hello world.Second!');
    expect(index.nodes.length).toBe(4);
    for (let i = 0; i + 1 < index.nodes.length; i++) {
      expect(index.nodes[i]!.end).toBe(index.nodes[i + 1]!.start);
    }
    const total = index.nodes.reduce((sum, entry) => sum + (entry.end - entry.start), 0);
    expect(total).toBe(index.text.length);
    expect(index.nodes[0]!.start).toBe(0);
    expect(index.nodes[index.nodes.length - 1]!.end).toBe(index.text.length);
  });

  test('rangeFromOffsets round-trips 20 random pairs', () => {
    const doc = docFrom(
      '<p>Он пришёл домой и <i>сразу</i> лёг спать. Потом встал, т.е. проснулся, ' +
        'и вышел во двор.</p><p>The quick brown fox jumps over the lazy dog. ' +
        'Mr. Smith paid 5.5 dollars.</p>',
    );
    const index = buildTextIndex(doc.body, { locale: 'ru' });
    let seed = 123456789;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 20; i++) {
      const start = Math.floor(rand() * (index.text.length - 1));
      const end = start + 1 + Math.floor(rand() * (index.text.length - start - 1));
      const range = rangeFromOffsets(index, start, end);
      expect(range).not.toBeNull();
      expect(range!.toString()).toBe(index.text.slice(start, end));
    }
  });

  test('rangeFromOffsets returns null for an empty range or an empty index', () => {
    const doc = docFrom('<p>Text.</p>');
    const index = buildTextIndex(doc.body);
    expect(rangeFromOffsets(index, 3, 3)).toBeNull();
    expect(rangeFromOffsets({ nodes: [] }, 0, 5)).toBeNull();
  });

  test('surrogate pairs are counted in code units and never split', () => {
    const doc = docFrom('<p>Смайлик 😀 в тексте.</p>');
    const index = buildTextIndex(doc.body);
    expect(index.text.includes('😀')).toBe(true);
    expect(index.text.length).toBe(index.nodes[0]!.end);
    const at = index.text.indexOf('😀');
    expect(index.text.slice(at, at + 2)).toBe('😀');
    expect(rangeFromOffsets(index, at, at + 2)!.toString()).toBe('😀');
  });

  test('hash is stable across builds of the same document', () => {
    const doc = docFrom('<p>Same text.</p>');
    const first = buildTextIndex(doc.body);
    const second = buildTextIndex(doc.body);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(buildTextIndex(docFrom('<p>Other text.</p>').body).hash).not.toBe(first.hash);
  });
});

describe('buildTextIndex: sentence segmentation', () => {
  test('ru: no break after "т.е."', () => {
    const sentences = sentencesOf(docFrom('<p>Он пришёл, т.е. явился. Потом ушёл.</p>'), 'ru');
    expect(sentences).toEqual(['Он пришёл, т.е. явился.', 'Потом ушёл.']);
  });

  test('en: no break after "Mr." or inside "5.5"', () => {
    const sentences = sentencesOf(docFrom('<p>Mr. Smith paid 5.5 dollars. Then left.</p>'), 'en');
    expect(sentences).toEqual(['Mr. Smith paid 5.5 dollars.', 'Then left.']);
  });

  test('ru: initials stay with the following sentence', () => {
    const sentences = sentencesOf(docFrom('<p>А. С. Пушкин писал. Потом читал.</p>'), 'ru');
    expect(sentences).toEqual(['А. С. Пушкин писал.', 'Потом читал.']);
  });

  test('<br> is a hard break and never merged over', () => {
    const doc = docFrom('<p>Первая часть<br>вторая часть.</p>');
    const index = buildTextIndex(doc.body, { locale: 'ru' });
    const sentences = (index.sentences as [number, number][]).map(([start, end]) =>
      index.text.slice(start, end),
    );
    expect(sentences.length).toBe(2);
    for (const sentence of sentences) {
      expect(sentence.includes('Первая') && sentence.includes('вторая')).toBe(false);
    }
    expect(index.breaks).toContain(index.text.indexOf('вторая'));
  });

  test('paragraph boundaries beat the short-segment merge', () => {
    expect(sentencesOf(docFrom('<p>a</p><p>b</p>'), 'en')).toEqual(['a', 'b']);
  });

  test('short segments merge forward, but not across <br>', () => {
    const merged = sentencesOf(
      docFrom('<p>Да. Нет. Ну хорошо, поехали дальше по тексту.</p>'),
      'ru',
    );
    expect(merged.length).toBe(1);
    expect(merged[0]).toContain('Да. Нет.');

    const split = sentencesOf(docFrom('<p>Да.<br>Нет.</p>'), 'ru');
    expect(split).toEqual(['Да.', 'Нет.']);
  });

  test('sentences are ascending, non-overlapping and contain no break', () => {
    const doc = docFrom('<p>Первое предложение здесь.</p><p>Второе, т.е. следующее. Третье.</p>');
    const index = buildTextIndex(doc.body, { locale: 'ru' });
    const sentences = index.sentences as [number, number][];
    expect(sentences.length).toBeGreaterThan(1);
    for (let i = 0; i + 1 < sentences.length; i++) {
      expect(sentences[i]![0]).toBeLessThan(sentences[i]![1]);
      expect(sentences[i]![1]).toBeLessThanOrEqual(sentences[i + 1]![1]);
      expect(sentences[i]![0]).toBeLessThan(sentences[i + 1]![0]);
    }
    const breaks = new Set(index.breaks as number[]);
    for (const [start, end] of sentences) {
      for (let offset = start + 1; offset < end; offset++) {
        expect(breaks.has(offset)).toBe(false);
      }
    }
  });
});

describe('offsetFromPosition', () => {
  test('maps a text node offset to a flat offset', () => {
    const doc = docFrom('<p>Hello <b>world</b>.</p>');
    const index = buildTextIndex(doc.body);
    const hello = doc.querySelector('p')!.firstChild as Text;
    expect(offsetFromPosition(index, hello, 3)).toBe(3);
    expect(offsetFromPosition(index, hello, 99)).toBe(hello.length);
    const b = doc.querySelector('b')!.firstChild as Text;
    expect(offsetFromPosition(index, b, 2)).toBe(8);
    expect(sentenceAt(index, 8)).toBe(0);
  });

  test('maps an element position to the next indexed text node', () => {
    const doc = docFrom('<p><b>ab</b><i>cd</i></p>');
    const index = buildTextIndex(doc.body);
    const i = doc.querySelector('i')!;
    // Position before <i> is the start of its text.
    expect(offsetFromPosition(index, i, 0)).toBe(2);
    // Position at the end of <p> (after <i>) falls back to the previous end.
    const p = doc.querySelector('p')!;
    expect(offsetFromPosition(index, p, 2)).toBe(4);
  });

  test('returns -1 for nodes outside the index', () => {
    const doc = docFrom('<p>Indexed.</p>');
    const index = buildTextIndex(doc.body);
    const foreign = docFrom('<p>Other.</p>').querySelector('p')!.firstChild as Text;
    expect(offsetFromPosition(index, foreign, 0)).toBe(-1);
    const comment = doc.createComment('note');
    expect(offsetFromPosition(index, comment, 0)).toBe(-1);
  });
});

describe('sentenceIndex cache', () => {
  test('memoizes the index per Document', () => {
    const doc = docFrom('<p>Кэш. Проверка.</p>');
    const first = getDocIndex(doc);
    const second = getDocIndex(doc);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(first!.text).toBe('Кэш. Проверка.');
  });

  test('clearSentenceIndexCache drops the cached entry', () => {
    const doc = docFrom('<p>Сброс кэша.</p>');
    const first = getDocIndex(doc);
    clearSentenceIndexCache();
    const second = getDocIndex(doc);
    expect(second).not.toBe(first);
    expect(second!.text).toBe(first!.text);
    expect(second!.hash).toBe(first!.hash);
  });
});
