/**
 * Bundled FreeDict English→Russian dictionary provider.
 *
 * The StarDict bundle ships in `public/dicts/freedict-eng-rus/` (about 6.7 MB:
 * a 1.1 MB `.idx`, a DictZip-compressed `.dict.dz` and a tiny `.ifo`). It is
 * fetched from the app's own static assets on first use — no download, no
 * network provider, no filesystem permission.
 *
 * Rendering is intentionally not a raw HTML dump: FreeDict entries carry the
 * pronunciation and part-of-speech markers as `<font>` tags and the
 * translations as nested `<ol>/<li>` lists. We lift the markers into the card
 * header, keep the ordered senses, and add the CC BY-SA attribution footer.
 */
import { StarDictReader, type StarDictEntry } from '../stardictReader';
import { BUILTIN_PROVIDER_IDS, type DictionaryProvider } from '../types';

export const FREEDICT_ENG_RUS_BASE_PATH = '/dicts/freedict-eng-rus';
export const FREEDICT_ENG_RUS_FILES = {
  ifo: 'freedict-eng-rus.ifo',
  idx: 'freedict-eng-rus.idx',
  dict: 'freedict-eng-rus.dict.dz',
} as const;
/** Shown above every card and in the tab strip. */
export const FREEDICT_ENG_RUS_LABEL = 'FreeDict EN–RU';
const SOURCE_VERSION = '2025.11.23';
const SOURCE_LICENSE = 'CC BY-SA 3.0';
const SOURCE_FOOTER = `Source: FreeDict eng-rus ${SOURCE_VERSION} · ${SOURCE_LICENSE}`;

/** Minimal response shape the provider needs — keeps tests independent of `Response`. */
export type FreedictFetcher = (
  url: string,
) => Promise<{ ok: boolean; status: number; blob: () => Promise<Blob> }>;

export interface FreedictSource {
  /** Directory URL without a trailing slash. */
  basePath: string;
  fetcher?: FreedictFetcher;
}

export interface FreedictEntryData {
  headword: string;
  /** Raw StarDict `h` payload. */
  html: string;
}

const defaultFetcher: FreedictFetcher = (url) => fetch(url);

const readerCache = new Map<string, Promise<StarDictReader>>();

const fetchBlob = async (source: FreedictSource, filename: string): Promise<Blob> => {
  const fetcher = source.fetcher ?? defaultFetcher;
  const url = `${source.basePath.replace(/\/+$/, '')}/${filename}`;
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`FreeDict asset ${url} failed: HTTP ${response.status}`);
  }
  return response.blob();
};

/**
 * Load (once per base path) the bundled reader. Concurrent callers share the
 * same in-flight promise; a failure clears the cache so a later retry can
 * succeed after an asset is restored.
 */
export const getFreedictReader = (source: FreedictSource): Promise<StarDictReader> => {
  const key = source.basePath;
  const cached = readerCache.get(key);
  if (cached) return cached;
  const loading = (async () => {
    const [ifo, idx, dict] = await Promise.all([
      fetchBlob(source, FREEDICT_ENG_RUS_FILES.ifo),
      fetchBlob(source, FREEDICT_ENG_RUS_FILES.idx),
      fetchBlob(source, FREEDICT_ENG_RUS_FILES.dict),
    ]);
    const reader = new StarDictReader();
    await reader.load({ ifo, idx, dict });
    return reader;
  })().catch((error) => {
    readerCache.delete(key);
    throw error;
  });
  readerCache.set(key, loading);
  return loading;
};

/** Drop the cached reader (tests, or after a failed bundle is replaced). */
export const __resetFreedictReaderForTests = (): void => {
  readerCache.clear();
};

const readEntries = async (
  reader: StarDictReader,
  entries: StarDictEntry[],
): Promise<FreedictEntryData[]> => {
  const decoder = new TextDecoder('utf-8');
  const out: FreedictEntryData[] = [];
  for (const entry of entries) {
    const bytes = await reader.read(entry);
    if (!bytes.length) continue;
    out.push({ headword: entry.word, html: decoder.decode(bytes) });
  }
  return out;
};

/**
 * All homographs for `word`, in `.idx` order, falling back to the `.syn`
 * index when the headword is absent. The bundle has no `.syn`, but imported
 * StarDict bundles may, so the provider path stays uniform.
 */
export const lookupFreedictEntries = async (
  word: string,
  source: FreedictSource = { basePath: FREEDICT_ENG_RUS_BASE_PATH },
): Promise<FreedictEntryData[]> => {
  const reader = await getFreedictReader(source);
  const matches = await reader.lookupAll(word);
  if (matches.length > 0) return readEntries(reader, matches);
  const syn = await reader.resolveSynonym(word);
  return syn ? readEntries(reader, [syn]) : [];
};

const decodeHtml = (html: string): Document =>
  new DOMParser().parseFromString(`<div id="freedict-root">${html}</div>`, 'text/html');

interface ParsedEntry {
  transcriptions: string[];
  partsOfSpeech: string[];
  sensesHtml: string;
}

/** Split a FreeDict `h` payload into header metadata + ordered senses markup. */
const parseEntryHtml = (html: string): ParsedEntry => {
  const doc = decodeHtml(html);
  const root = doc.getElementById('freedict-root');
  if (!root) return { transcriptions: [], partsOfSpeech: [], sensesHtml: html };

  const transcriptions: string[] = [];
  root.querySelectorAll('font[color="gray"]').forEach((node) => {
    const text = node.textContent?.trim();
    if (text) transcriptions.push(text);
    node.remove();
  });

  const partsOfSpeech: string[] = [];
  root.querySelectorAll('font[class="grammar"]').forEach((node) => {
    const text = node.textContent?.trim();
    if (text) partsOfSpeech.push(text);
    node.remove();
  });

  // The pronunciation and POS wrappers stay behind as empty <div>s; drop
  // them so the sense list does not start with blank lines.
  root.querySelectorAll('div').forEach((node) => {
    if (!node.textContent?.trim() && !node.querySelector('ol, ul, li, div')) node.remove();
  });

  return { transcriptions, partsOfSpeech, sensesHtml: root.innerHTML };
};

const appendSenses = (container: HTMLElement, html: string): void => {
  const body = document.createElement('div');
  body.className = 'freedict-senses mt-2 space-y-1 text-sm';
  body.innerHTML = html;
  body.querySelectorAll('ol').forEach((list) => {
    list.className = 'ml-4 list-decimal space-y-1';
  });
  body.querySelectorAll('ol ol').forEach((list) => {
    list.className = 'ml-4 list-disc space-y-0.5';
  });
  container.appendChild(body);
};

const renderEntry = (container: HTMLElement, entry: FreedictEntryData): void => {
  const { transcriptions, partsOfSpeech, sensesHtml } = parseEntryHtml(entry.html);

  const header = document.createElement('div');
  header.className = 'flex flex-wrap items-baseline gap-2';
  if (partsOfSpeech.length > 0) {
    const pos = document.createElement('span');
    pos.className = 'text-xs font-medium text-emerald-600';
    pos.textContent = partsOfSpeech.join(' · ');
    header.appendChild(pos);
  }
  if (transcriptions.length > 0) {
    const phonetic = document.createElement('span');
    phonetic.className = 'text-xs not-eink:opacity-60';
    phonetic.textContent = `/${transcriptions.join(' / ')}/`;
    header.appendChild(phonetic);
  }
  if (header.childElementCount > 0) container.appendChild(header);

  appendSenses(container, sensesHtml);
};

/** Register the bundled bundle as a normal `DictionaryProvider`. */
export const createFreedictEngRusProvider = (
  source: FreedictSource = { basePath: FREEDICT_ENG_RUS_BASE_PATH },
): DictionaryProvider => {
  return {
    id: BUILTIN_PROVIDER_IDS.freedictEngRus,
    kind: 'stardict',
    label: FREEDICT_ENG_RUS_LABEL,
    async init() {
      await getFreedictReader(source);
    },
    async lookup(word, ctx) {
      try {
        const entries = await lookupFreedictEntries(word, source);
        if (ctx.signal.aborted) return { ok: false, reason: 'error', message: 'aborted' };
        if (entries.length === 0) return { ok: false, reason: 'empty' };

        const h1 = document.createElement('h1');
        h1.textContent = entries[0]!.headword;
        h1.className = 'text-lg font-bold';
        ctx.container.appendChild(h1);

        for (const entry of entries) renderEntry(ctx.container, entry);

        const footer = document.createElement('div');
        footer.className = 'mt-3 text-[11px] not-eink:opacity-60';
        footer.textContent = SOURCE_FOOTER;
        ctx.container.appendChild(footer);

        return {
          ok: true,
          headword: entries[0]!.headword,
          sourceLabel: `${FREEDICT_ENG_RUS_LABEL} · ${SOURCE_LICENSE}`,
        };
      } catch (error) {
        return {
          ok: false,
          reason: 'error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};

/** Shared singleton used by the registry; its reader is warmed for fast dispatch. */
export const freedictEngRusProvider = createFreedictEngRusProvider();
