import { useSettingsStore } from '@/store/settingsStore';
import { getAIFetch } from '@/services/ai/utils/httpFetch';
import type { CustomTranslator } from '@/types/translation';
import { createOpenAICompatibleTranslator } from '../custom/openaiCompatible';
import type { TranslationProvider } from '../types';
import { ErrorCodes } from '../types';
import {
  DEFAULT_LOCAL_MODEL,
  DEFAULT_LOCAL_TEMPERATURE,
  LOCAL_BATCH_CHARS,
  LOCAL_BATCH_INFLIGHT,
  LOCAL_BATCH_ITEMS,
  LOCAL_REQUEST_TIMEOUT_MS,
  LOCAL_TRANSLATOR_LABEL,
  LOCAL_TRANSLATOR_NAME,
  normalizeLocalEndpoint,
} from '../localDefaults';

export interface LocalTranslatorConfig {
  baseUrl: string;
  model: string;
  temperature: number;
}

/** Read on every call so a settings edit takes effect without a reload. */
export const readLocalTranslatorConfig = (): LocalTranslatorConfig => {
  const stored = useSettingsStore.getState().settings?.localTranslator;
  return {
    baseUrl: normalizeLocalEndpoint(stored?.endpoint),
    model: (stored?.model ?? DEFAULT_LOCAL_MODEL).trim() || DEFAULT_LOCAL_MODEL,
    temperature: Number.isFinite(stored?.temperature)
      ? stored!.temperature!
      : DEFAULT_LOCAL_TEMPERATURE,
  };
};

export interface LocalEndpointCheck {
  ok: boolean;
  models: string[];
  latencyMs: number;
  error?: string;
}

const LOCAL_INSTANCE_CAP = 8;
const instances = new Map<string, TranslationProvider>();

const getBaseTranslator = (config: LocalTranslatorConfig): TranslationProvider => {
  const key = `${config.baseUrl}\n${config.model}\n${config.temperature}`;
  const cached = instances.get(key);
  if (cached) return cached;

  const translatorConfig: CustomTranslator = {
    id: LOCAL_TRANSLATOR_NAME,
    type: 'openai-compatible',
    name: LOCAL_TRANSLATOR_LABEL,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    thinking: 'off',
    addedAt: 0,
    updatedAt: 0,
  };
  const provider = createOpenAICompatibleTranslator(translatorConfig, {
    name: LOCAL_TRANSLATOR_NAME,
    cacheKeySalt: config.baseUrl,
    requestTimeoutMs: LOCAL_REQUEST_TIMEOUT_MS,
    batch: { items: LOCAL_BATCH_ITEMS, chars: LOCAL_BATCH_CHARS, inflight: LOCAL_BATCH_INFLIGHT },
  });
  if (instances.size >= LOCAL_INSTANCE_CAP) {
    const oldest = instances.keys().next().value;
    if (oldest) instances.delete(oldest);
  }
  instances.set(key, provider);
  return provider;
};

const toLocalError = (err: unknown, baseUrl: string): Error => {
  const name = (err as { name?: string })?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return err as Error;
  }
  const status = (err as { statusCode?: number }).statusCode;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 404) {
    return new Error(
      `${ErrorCodes.LOCAL_TRANSLATOR_UNAVAILABLE}: ${baseUrl}/chat/completions returned 404 — the endpoint should end with /v1`,
    );
  }
  if (
    /fetch failed|Failed to fetch|NetworkError|Load failed|ECONNREFUSED|ECONNRESET|timed out|aborted/i.test(
      message,
    )
  ) {
    return new Error(
      `${ErrorCodes.LOCAL_TRANSLATOR_UNAVAILABLE}: cannot reach ${baseUrl}. Start llama-server or change the endpoint in Settings → Language.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
};

/** Health check for the settings button. Never throws. */
export const checkLocalEndpoint = async (
  endpoint: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<LocalEndpointCheck> => {
  const base = normalizeLocalEndpoint(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 5_000);
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  try {
    const res = await getAIFetch()(`${base}/models`, {
      signal: opts?.signal ?? controller.signal,
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      const models = Array.isArray(json?.data)
        ? (json.data as { id?: unknown }[]).map((m) => String(m?.id ?? '')).filter(Boolean)
        : [];
      return { ok: true, models, latencyMs: elapsed() };
    }
    // Older llama-server builds: native /health.
    const health = await getAIFetch()(`${base.replace(/\/v1$/, '')}/health`, {
      signal: controller.signal,
    });
    if (health.ok) return { ok: true, models: [], latencyMs: elapsed() };
    return {
      ok: false,
      models: [],
      latencyMs: elapsed(),
      error: `${res.status} ${res.statusText}`,
    };
  } catch (err) {
    return {
      ok: false,
      models: [],
      latencyMs: elapsed(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
};

export const localProvider: TranslationProvider = {
  name: LOCAL_TRANSLATOR_NAME,
  label: LOCAL_TRANSLATOR_LABEL,
  authRequired: false,
  premiumRequired: false,
  requiresApp: false,
  concurrency: 8,
  getCacheKey: (sourceLang, targetLang, context) =>
    getBaseTranslator(readLocalTranslatorConfig()).getCacheKey!(sourceLang, targetLang, context),
  translate: async (texts, sourceLang, targetLang, token, useCache, signal, context) => {
    const config = readLocalTranslatorConfig();
    try {
      return await getBaseTranslator(config).translate(
        texts,
        sourceLang,
        targetLang,
        token,
        useCache,
        signal,
        context,
      );
    } catch (err) {
      throw toLocalError(err, config.baseUrl);
    }
  },
};
