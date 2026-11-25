/**
 * Offline translation-model manifest.
 *
 * The manifest ships inside the app bundle (`public/models/manifest.json`) and
 * is the only source of truth for what the model manager may download: URL,
 * size, checksum and licence all come from here, never from the UI.
 *
 * Keep this module dependency-free apart from `fetch` so it can be unit-tested
 * without the Tauri runtime.
 */

/** Model families the app knows how to install. */
export const MODEL_KINDS = ['translation', 'dictionary'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export interface ModelEntry {
  /** Stable identity, also the temp-file stem (`<id>.part`). */
  id: string;
  kind: ModelKind;
  /** Language pair the model covers, e.g. `en-ru`. */
  lang_pair: string;
  /** Absolute HTTPS URL of the asset in a GitHub Release. */
  url: string;
  size_bytes: number;
  /** Lowercase hex SHA-256 of the asset, verified before the file is used. */
  sha256: string;
  /** SPDX licence identifier shown next to the download button. */
  license: string;
  min_ram_mb: number;
  display_name: string;
}

export interface ModelManifest {
  version: number;
  models: ModelEntry[];
}

/** Path served by the Next.js static export and by Tauri's asset protocol. */
export const MODELS_MANIFEST_URL = '/models/manifest.json';

const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new Error(`Invalid model manifest: ${message}`);
};

const readString = (raw: Record<string, unknown>, field: string, where: string): string => {
  const value = raw[field];
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(`${where}.${field} must be a non-empty string`);
  }
  return value;
};

const readPositiveInt = (raw: Record<string, unknown>, field: string, where: string): number => {
  const value = raw[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return fail(`${where}.${field} must be a positive integer`);
  }
  return value;
};

const parseEntry = (raw: unknown, index: number): ModelEntry => {
  const where = `models[${index}]`;
  if (!isRecord(raw)) return fail(`${where} must be an object`);

  const id = readString(raw, 'id', where);
  const kind = readString(raw, 'kind', where);
  if (!(MODEL_KINDS as readonly string[]).includes(kind)) {
    return fail(`${where}.kind must be one of ${MODEL_KINDS.join(', ')}`);
  }
  const url = readString(raw, 'url', where);
  if (!/^https?:\/\//i.test(url)) return fail(`${where}.url must be an absolute http(s) URL`);
  const sha256 = readString(raw, 'sha256', where).toLowerCase();
  if (!SHA256_HEX.test(sha256)) return fail(`${where}.sha256 must be 64 hex characters`);

  return {
    id,
    kind: kind as ModelKind,
    lang_pair: readString(raw, 'lang_pair', where),
    url,
    size_bytes: readPositiveInt(raw, 'size_bytes', where),
    sha256,
    license: readString(raw, 'license', where),
    min_ram_mb: readPositiveInt(raw, 'min_ram_mb', where),
    display_name: readString(raw, 'display_name', where),
  };
};

/**
 * Validate and normalise a manifest document.
 *
 * @throws Error naming the offending field — a corrupted manifest must never
 *   silently reach the downloader with a zero size or an empty checksum.
 */
export const parseModelManifest = (raw: unknown): ModelManifest => {
  if (!isRecord(raw)) return fail('root must be an object');
  const version = raw['version'] ?? 1;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return fail('version must be a positive integer');
  }
  const models = raw['models'];
  if (!Array.isArray(models)) return fail('models must be an array');
  return {
    version,
    models: models.map((entry, index) => parseEntry(entry, index)),
  };
};

/** Load the bundled manifest. `fetcher` is injectable for tests. */
export const fetchModelManifest = async (
  fetcher: typeof fetch = fetch,
  url: string = MODELS_MANIFEST_URL,
): Promise<ModelManifest> => {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Failed to load model manifest: ${response.status} ${response.statusText}`);
  }
  const raw: unknown = await response.json();
  return parseModelManifest(raw);
};

/** Entries in the manifest, optionally narrowed to one kind. */
export const getModelEntries = (manifest: ModelManifest, kind?: ModelKind): ModelEntry[] =>
  kind ? manifest.models.filter((model) => model.kind === kind) : manifest.models;

/** Look up one entry by id; `null` when the manifest does not describe it. */
export const findModel = (manifest: ModelManifest, id: string): ModelEntry | null =>
  manifest.models.find((model) => model.id === id) ?? null;
