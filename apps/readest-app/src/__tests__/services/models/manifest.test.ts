import { describe, expect, it, vi } from 'vitest';
import {
  findModel,
  getModelEntries,
  fetchModelManifest,
  parseModelManifest,
} from '@/services/models/manifest';
import shippedManifest from '../../../../public/models/manifest.json';

const validEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'hy-mt2-1.8b-q4_k_m',
  kind: 'translation',
  lang_pair: 'en-ru',
  urls: [
    'https://huggingface.co/o/r/resolve/0123456789abcdef/Hy-MT2-1.8B-Q4_K_M.gguf',
    'https://github.com/o/r/releases/download/models-v1/Hy-MT2-1.8B-Q4_K_M.gguf',
  ],
  size_bytes: 1133080448,
  sha256: 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699',
  license: 'Apache-2.0',
  min_ram_mb: 3072,
  display_name: 'Hy-MT2 1.8B (Q4_K_M)',
  ...overrides,
});

const validManifest = (models: unknown[] = [validEntry()]): Record<string, unknown> => ({
  version: 1,
  models,
});

describe('parseModelManifest', () => {
  it('accepts the shipped public/models/manifest.json', () => {
    const manifest = parseModelManifest(shippedManifest);
    expect(manifest.version).toBe(1);
    expect(manifest.models).toHaveLength(1);
    const [entry] = manifest.models;
    expect(entry!.id).toBe('hy-mt2-1.8b-q4_k_m');
    expect(entry!.kind).toBe('translation');
    expect(entry!.size_bytes).toBe(1133080448);
    expect(entry!.license).toBe('Apache-2.0');
    expect(entry!.min_ram_mb).toBeGreaterThan(0);
    expect(entry!.urls).toHaveLength(1);
    expect(entry!.urls[0]).toMatch(/^https:\/\/huggingface\.co\//);
  });

  it('normalises the checksum to lowercase and defaults the version', () => {
    const manifest = parseModelManifest({
      models: [
        validEntry({ sha256: 'DC5F44FCF1FA496EE7AD725982C0C8C553A4DE00259B53AF84C4B89FB0C06699' }),
      ],
    });
    expect(manifest.version).toBe(1);
    expect(manifest.models[0]!.sha256).toBe(
      'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699',
    );
  });

  it.each([
    ['a short checksum', validManifest([validEntry({ sha256: 'dc5f44fc' })])],
    ['a zero size', validManifest([validEntry({ size_bytes: 0 })])],
    ['a relative url', validManifest([validEntry({ urls: ['/models/model.gguf'] })])],
    ['an empty urls array', validManifest([validEntry({ urls: [] })])],
    ['a non-string fallback', validManifest([validEntry({ urls: ['https://a/x.gguf', 42] })])],
    [
      'a repeated url',
      validManifest([validEntry({ urls: ['https://a/x.gguf', 'https://a/x.gguf'] })]),
    ],
    ['an unknown kind', validManifest([validEntry({ kind: 'llm' })])],
    ['a missing display name', validManifest([validEntry({ display_name: '' })])],
    ['a non-array models field', { version: 1, models: {} }],
    ['a non-object entry', validManifest(['model.gguf'])],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseModelManifest(raw)).toThrow(/Invalid model manifest/);
  });
});

describe('fetchModelManifest', () => {
  it('loads and validates the manifest over HTTP', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => validManifest(),
    }));
    const manifest = await fetchModelManifest(fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith('/models/manifest.json');
    expect(manifest.models).toHaveLength(1);
  });

  it('reports a missing manifest instead of returning an empty list', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
    }));
    await expect(fetchModelManifest(fetcher as unknown as typeof fetch)).rejects.toThrow(
      /404 Not Found/,
    );
  });
});

describe('getModelEntries / findModel', () => {
  const manifest = parseModelManifest(validManifest());

  it('lists models and can narrow by kind', () => {
    expect(getModelEntries(manifest)).toHaveLength(1);
    expect(getModelEntries(manifest, 'translation')).toHaveLength(1);
    expect(getModelEntries(manifest, 'dictionary')).toHaveLength(0);
  });

  it('finds a model by id', () => {
    expect(findModel(manifest, 'hy-mt2-1.8b-q4_k_m')?.license).toBe('Apache-2.0');
    expect(findModel(manifest, 'missing')).toBeNull();
  });
});
