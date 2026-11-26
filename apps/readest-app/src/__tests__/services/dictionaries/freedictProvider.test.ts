import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createFreedictEngRusProvider,
  getFreedictReader,
  lookupFreedictEntries,
  __resetFreedictReaderForTests,
  type FreedictFetcher,
  type FreedictSource,
} from '@/services/dictionaries/providers/freedictProvider';
import { routeSingleWordSelection } from '@/services/dictionaries/wordLookup';
import { BUILTIN_PROVIDER_IDS, type DictionarySettings } from '@/services/dictionaries/types';

const BUNDLE_DIR = path.resolve(__dirname, '../../../../public/dicts/freedict-eng-rus');
const FILES = ['freedict-eng-rus.ifo', 'freedict-eng-rus.idx', 'freedict-eng-rus.dict.dz'];

const bundles = new Map<string, ArrayBuffer>();

const fetchFromBundle: FreedictFetcher = async (url) => {
  const name = url.split('/').pop() ?? '';
  const bytes = bundles.get(name);
  if (!bytes) {
    return { ok: false, status: 404, blob: async () => new Blob([]) };
  }
  return { ok: true, status: 200, blob: async () => new File([bytes], name) };
};

const source: FreedictSource = { basePath: 'test://freedict-eng-rus', fetcher: fetchFromBundle };

const enabledSettings: DictionarySettings = {
  providerOrder: [BUILTIN_PROVIDER_IDS.freedictEngRus, BUILTIN_PROVIDER_IDS.wiktionary],
  providerEnabled: { [BUILTIN_PROVIDER_IDS.freedictEngRus]: true },
};

const makeContext = () => ({
  lang: 'en',
  signal: new AbortController().signal,
  container: document.createElement('div'),
});

beforeAll(async () => {
  for (const name of FILES) {
    const buffer = await readFile(path.join(BUNDLE_DIR, name));
    const copy = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(copy).set(buffer);
    bundles.set(name, copy);
  }
});

beforeEach(() => {
  __resetFreedictReaderForTests();
});

describe('bundled FreeDict eng-rus', () => {
  it('loads the shipped StarDict bundle without reader changes', async () => {
    const reader = await getFreedictReader(source);
    expect(reader.ifo['bookname']).toContain('FreeDict');
    expect(reader.ifo['sametypesequence']).toBe('h');
    expect(reader.entryCount).toBe(62181);
  });

  it('finds an exact headword and keeps its homographs in order', async () => {
    const entries = await lookupFreedictEntries('dog', source);
    expect(entries.map((e) => e.headword)).toEqual(['dog', 'dog']);
    expect(entries[0]!.html).toContain('соба́ка');
    expect(entries[0]!.html).toContain('grammar');
  });

  it('renders part of speech, senses, pronunciation and the source note', async () => {
    const provider = createFreedictEngRusProvider(source);
    const ctx = makeContext();
    const outcome = await provider.lookup('dog', ctx);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.headword).toBe('dog');
    const text = ctx.container.textContent ?? '';
    expect(text).toContain('dog');
    expect(text).toContain('noun');
    expect(text).toContain('verb');
    expect(text).toContain('dɑɡ');
    expect(text).toContain('соба́ка');
    expect(text).toContain('CC BY-SA 3.0');
  });

  it('resolves an inflected selection through the English lemmatizer', async () => {
    expect(await lookupFreedictEntries('ran', source)).toHaveLength(0);
    const route = await routeSingleWordSelection('ran', 'en', source, enabledSettings);
    expect(route).toEqual({ route: 'dictionary', headword: 'run' });
  });

  it('routes a miss and a phrase to the existing translator', async () => {
    expect(await routeSingleWordSelection('zzzxq', 'en', source, enabledSettings)).toEqual({
      route: 'translator',
    });
    expect(await routeSingleWordSelection('the dog', 'en', source, enabledSettings)).toEqual({
      route: 'translator',
    });
  });

  it('falls back to translation when the bundle is missing or disabled', async () => {
    const missing: FreedictSource = {
      basePath: 'test://missing-freedict',
      fetcher: async () => ({ ok: false, status: 404, blob: async () => new Blob([]) }),
    };
    expect(await routeSingleWordSelection('dog', 'en', missing, enabledSettings)).toEqual({
      route: 'translator',
    });

    const provider = createFreedictEngRusProvider(missing);
    await expect(provider.lookup('dog', makeContext())).resolves.toMatchObject({
      ok: false,
      reason: 'error',
    });

    const disabled: DictionarySettings = {
      ...enabledSettings,
      providerEnabled: { [BUILTIN_PROVIDER_IDS.freedictEngRus]: false },
    };
    expect(await routeSingleWordSelection('dog', 'en', source, disabled)).toEqual({
      route: 'translator',
    });
  });

  it('answers warm lookups well under 10 ms', async () => {
    // Warm the reader, the blob slices and the decompressed chunk cache.
    await lookupFreedictEntries('house', source);
    const started = performance.now();
    const iterations = 20;
    for (let i = 0; i < iterations; i++) await lookupFreedictEntries('house', source);
    const average = (performance.now() - started) / iterations;
    expect(average).toBeLessThan(10);
  });
});
