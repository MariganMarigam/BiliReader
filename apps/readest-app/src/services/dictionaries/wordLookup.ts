/**
 * Single-word dictionary-first dispatch.
 *
 * The translation action has to decide, before it spends an MT request,
 * whether the selection is one word the bundled offline dictionary knows.
 * Exact headword wins; inflections are covered by
 * {@link buildLookupCandidates}, which appends lemmatizer output after the
 * exact/case variants. Any failure (assets missing, unsupported bundle)
 * returns `null` so the caller falls through to the existing translator —
 * a broken dictionary must never break translation.
 */
import { buildLookupCandidates } from './lookupCandidates';
import { lookupFreedictEntries, type FreedictSource } from './providers/freedictProvider';
import { BUILTIN_PROVIDER_IDS, type DictionarySettings } from './types';

/**
 * Strip surrounding punctuation/quotes and return the bare word, or `null`
 * when the selection is a phrase. Apostrophes and hyphens inside a word are
 * preserved (`don't`, `well-known`).
 */
export const normalizeSingleWord = (text: string): string | null => {
  const trimmed = text
    .trim()
    .replace(/^[^\p{L}\p{M}]+/u, '')
    .replace(/[^\p{L}\p{M}]+$/u, '');
  if (!trimmed) return null;
  return /^[\p{L}\p{M}][\p{L}\p{M}'’\-]*$/u.test(trimmed) ? trimmed : null;
};

export const isSingleWordSelection = (text: string): boolean => normalizeSingleWord(text) !== null;

/** True when the bundled dictionary is present in the user's provider list and enabled. */
export const isLocalDictionaryEnabled = (settings?: DictionarySettings): boolean => {
  if (!settings) return true;
  const order = settings.providerOrder ?? [];
  const enabled = settings.providerEnabled ?? {};
  return (
    order.includes(BUILTIN_PROVIDER_IDS.freedictEngRus) &&
    enabled[BUILTIN_PROVIDER_IDS.freedictEngRus] !== false
  );
};

export interface LocalDictionaryHit {
  /** Dictionary headword that matched (may be a lemma, not the selection). */
  headword: string;
}

/**
 * Exact-then-lemma lookup against the bundled dictionary. Returns `null` for
 * phrases, disabled providers, misses, and any load error.
 */
export const lookupLocalDictionaryWord = async (
  text: string,
  lang?: string | null,
  source?: FreedictSource,
  settings?: DictionarySettings,
): Promise<LocalDictionaryHit | null> => {
  if (!isLocalDictionaryEnabled(settings)) return null;
  const word = normalizeSingleWord(text);
  if (!word) return null;

  try {
    for (const candidate of buildLookupCandidates(word, lang)) {
      const entries = await lookupFreedictEntries(candidate, source);
      if (entries.length > 0) return { headword: entries[0]!.headword };
    }
  } catch {
    // A missing/corrupt bundle is a miss, not an application error.
    return null;
  }
  return null;
};

export type SingleWordRoute = { route: 'dictionary'; headword: string } | { route: 'translator' };

/**
 * Decide where a selection should be answered: the bundled dictionary
 * (exact headword or lemma) or the existing translator. Phrases always go
 * to the translator without touching the dictionary.
 */
export const routeSingleWordSelection = async (
  text: string,
  lang?: string | null,
  source?: FreedictSource,
  settings?: DictionarySettings,
): Promise<SingleWordRoute> => {
  const hit = await lookupLocalDictionaryWord(text, lang, source, settings);
  return hit ? { route: 'dictionary', headword: hit.headword } : { route: 'translator' };
};
