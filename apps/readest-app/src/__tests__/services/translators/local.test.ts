import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateTextMock, fetchMock, settingsState } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  fetchMock: vi.fn(),
  settingsState: {
    settings: undefined as
      | { localTranslator?: { endpoint?: string; model?: string; temperature?: number } }
      | undefined,
  },
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});
vi.mock('@/services/ai/utils/httpFetch', () => ({ getAIFetch: () => fetchMock }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => settingsState },
}));

import {
  checkLocalEndpoint,
  localProvider,
  readLocalTranslatorConfig,
} from '@/services/translators/providers/local';
import {
  DEFAULT_LOCAL_ENDPOINT,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_LOCAL_TEMPERATURE,
  normalizeLocalEndpoint,
} from '@/services/translators/localDefaults';
import { renderPrompt, DEFAULT_TRANSLATION_PROMPT } from '@/services/translators/custom/prompts';

type GenerateArgs = { system: string; prompt: string; temperature?: number };
const lastCall = (n = -1): GenerateArgs => generateTextMock.mock.calls.at(n)![0] as GenerateArgs;

describe('localProvider', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    fetchMock.mockReset();
    settingsState.settings = undefined;
  });

  it('is listed without auth, premium or app requirements', () => {
    expect(localProvider.name).toBe('local');
    expect(localProvider.label.length).toBeGreaterThan(0);
    expect(localProvider.authRequired).toBe(false);
    expect(localProvider.premiumRequired).toBe(false);
    expect(localProvider.requiresApp).toBe(false);
    expect(localProvider.concurrency).toBeGreaterThan(0);
  });

  it('translates through the OpenAI-compatible factory with the stored temperature', async () => {
    settingsState.settings = {
      localTranslator: { endpoint: DEFAULT_LOCAL_ENDPOINT, model: 'm1', temperature: 0.2 },
    };
    generateTextMock.mockResolvedValue({ text: 'Bonjour' });

    const out = await localProvider.translate(['Hello'], 'en', 'fr', null, false, undefined, {
      bookTitle: 'Book',
    });

    expect(out).toEqual(['Bonjour']);
    const args = lastCall();
    expect(args.system).toContain(
      renderPrompt(DEFAULT_TRANSLATION_PROMPT, {
        sourceLang: 'en',
        targetLang: 'fr',
        bookTitle: 'Book',
      }),
    );
    expect(args.temperature).toBe(0.2);
  });

  it('coalesces concurrent paragraphs into one numbered request', async () => {
    generateTextMock.mockResolvedValue({ text: '[1]\nUn\n\n[2]\nDeux' });

    const results = await Promise.all([
      localProvider.translate(['One'], 'en', 'fr'),
      localProvider.translate(['Two'], 'en', 'fr'),
    ]);

    expect(results).toEqual([['Un'], ['Deux']]);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(lastCall().prompt).toBe('[1]\nOne\n\n[2]\nTwo');
  });

  it('changes the cache key with the model and the endpoint', () => {
    settingsState.settings = {
      localTranslator: { endpoint: 'http://127.0.0.1:8080/v1', model: 'a' },
    };
    const base = localProvider.getCacheKey!('en', 'fr', {});

    settingsState.settings = {
      localTranslator: { endpoint: 'http://127.0.0.1:8080/v1', model: 'b' },
    };
    const otherModel = localProvider.getCacheKey!('en', 'fr', {});

    settingsState.settings = {
      localTranslator: { endpoint: 'http://127.0.0.1:9090/v1', model: 'a' },
    };
    const otherEndpoint = localProvider.getCacheKey!('en', 'fr', {});

    settingsState.settings = {
      localTranslator: { endpoint: 'http://127.0.0.1:8080/v1', model: 'a' },
    };
    expect(localProvider.getCacheKey!('en', 'fr', {})).toBe(base);

    expect(otherModel).not.toBe(base);
    expect(otherEndpoint).not.toBe(base);
  });

  it('falls back to the default endpoint when settings are not hydrated', async () => {
    expect(readLocalTranslatorConfig()).toEqual({
      baseUrl: DEFAULT_LOCAL_ENDPOINT,
      model: DEFAULT_LOCAL_MODEL,
      temperature: DEFAULT_LOCAL_TEMPERATURE,
    });
    generateTextMock.mockResolvedValue({ text: 'Bonjour' });
    await expect(localProvider.translate(['Hello'], 'en', 'fr')).resolves.toEqual(['Bonjour']);
  });
});

describe('error mapping', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    settingsState.settings = {
      localTranslator: { endpoint: 'http://127.0.0.1:8080/v1', model: 'm1' },
    };
  });

  it('names the endpoint when the server is unreachable', async () => {
    generateTextMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(localProvider.translate(['Hello'], 'en', 'fr')).rejects.toThrow(
      /Local Translator Unavailable.*http:\/\/127\.0\.0\.1:8080\/v1/,
    );
  });

  it('explains a 404 as a missing /v1 suffix', async () => {
    generateTextMock.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    await expect(localProvider.translate(['Hello'], 'en', 'fr')).rejects.toThrow(/\/v1/);
  });

  it('propagates an abort unchanged', async () => {
    const aborted = new DOMException('Aborted', 'AbortError');
    generateTextMock.mockRejectedValue(aborted);
    await expect(localProvider.translate(['Hello'], 'en', 'fr')).rejects.toBe(aborted);
  });
});

describe('normalizeLocalEndpoint', () => {
  it('adds a scheme and /v1 to a bare host', () => {
    expect(normalizeLocalEndpoint('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v1');
  });

  it('strips trailing slashes', () => {
    expect(normalizeLocalEndpoint('http://host:8080/v1/')).toBe('http://host:8080/v1');
  });

  it('returns the default for an empty value', () => {
    expect(normalizeLocalEndpoint('')).toBe(DEFAULT_LOCAL_ENDPOINT);
    expect(normalizeLocalEndpoint(undefined)).toBe(DEFAULT_LOCAL_ENDPOINT);
  });
});

describe('checkLocalEndpoint', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('reports the models served by /v1/models', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'qwen3-4b' }] }) });
    const result = await checkLocalEndpoint('http://127.0.0.1:8080/v1');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen3-4b']);
  });

  it('never throws when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const result = await checkLocalEndpoint('http://127.0.0.1:8080/v1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/fetch failed/);
  });

  it('falls back to native /health on older llama-server builds', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
      .mockResolvedValueOnce({ ok: true });
    const result = await checkLocalEndpoint('http://127.0.0.1:8080/v1');
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[1]![0]).toBe('http://127.0.0.1:8080/health');
  });
});
