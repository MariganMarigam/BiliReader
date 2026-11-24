import { buildTextIndex } from 'foliate-js/text-index.js';

import type { FoliateView } from '@/types/view';

/**
 * Pure-DOM sentence index of one rendered document/chunk.
 *
 * The engine builds it; this module only owns the lifecycle: a per-`Document`
 * memo so a section is indexed once, plus a small LRU keyed by the text hash so
 * a re-rendered section (new `Document`, same text) is not re-segmented.
 */
export type DocSentenceIndex = ReturnType<typeof buildTextIndex>;

/** Minimal surface of the foliate overlayer this feature draws into. */
export interface OverlayerLike {
  add?: (key: string, range: Range, draw: unknown, options?: unknown) => void;
  remove?: (key: string) => void;
}

export interface SectionEntry {
  doc: Document;
  overlayer?: OverlayerLike;
  index: DocSentenceIndex;
}

const MAX_CACHED_SECTIONS = 8;

let byDoc = new WeakMap<Document, DocSentenceIndex>();
let failed = new WeakSet<Document>();
const byHash = new Map<string, DocSentenceIndex>();

const remember = (index: DocSentenceIndex): void => {
  const hash = String(index.hash);
  if (byHash.has(hash)) return;
  byHash.set(hash, index);
  while (byHash.size > MAX_CACHED_SECTIONS) {
    const oldest = byHash.keys().next().value;
    if (oldest === undefined) break;
    byHash.delete(oldest);
  }
};

/**
 * Sentence index of a rendered document, built on first use.
 *
 * @returns `null` when the document has no indexable body or building threw.
 */
export const getDocIndex = (doc: Document): DocSentenceIndex | null => {
  const cached = byDoc.get(doc);
  if (cached) return cached;
  if (failed.has(doc)) return null;
  const root = doc.body ?? doc.documentElement;
  if (!root) return null;
  try {
    // The index holds node references, so it is never shared between
    // documents: the hash LRU only tracks what was built and for how long.
    const index = buildTextIndex(root) as DocSentenceIndex;
    byDoc.set(doc, index);
    remember(index);
    return index;
  } catch (e) {
    failed.add(doc);
    console.warn('[sentence-index]', e);
    return null;
  }
};

/**
 * The rendered content of one spine section, with its sentence index.
 *
 * `overlayer` is `undefined` until foliate has created it; callers then wait
 * for the `create-overlayer` event instead of drawing.
 *
 * @returns `null` when the section is not rendered or cannot be indexed.
 */
export const getSectionEntry = (view: FoliateView, spineIndex: number): SectionEntry | null => {
  const contents = view.renderer?.getContents?.() ?? [];
  const content = contents.find((item) => item.index === spineIndex && item.doc);
  if (!content?.doc) return null;
  const index = getDocIndex(content.doc);
  if (!index) return null;
  return {
    doc: content.doc,
    overlayer: (content.overlayer as OverlayerLike | undefined) ?? undefined,
    index,
  };
};

/**
 * Build the index of a section that is not rendered yet (adjacent-section
 * prefetch at a section boundary).
 *
 * The returned document is detached: `text`/`sentences` are valid, but
 * `rangeFromOffsets` must not be called on it.
 *
 * @returns `null` on any failure — never throws.
 */
export const primeSection = async (
  view: FoliateView,
  spineIndex: number,
): Promise<DocSentenceIndex | null> => {
  try {
    const section = view.book?.sections?.[spineIndex];
    const doc = await section?.createDocument?.();
    if (!doc) return null;
    return getDocIndex(doc);
  } catch (e) {
    console.warn('[sentence-index]', e);
    return null;
  }
};

/** Drop all cached indexes (tests, and when the book is closed). */
export const clearSentenceIndexCache = (): void => {
  byDoc = new WeakMap<Document, DocSentenceIndex>();
  failed = new WeakSet<Document>();
  byHash.clear();
};
