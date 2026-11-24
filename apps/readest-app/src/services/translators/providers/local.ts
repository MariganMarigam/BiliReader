import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '@/store/settingsStore';
import { getAIFetch } from '@/services/ai/utils/httpFetch';
import { isTauriAppPlatform } from '@/services/environment';
import type { CustomTranslator } from '@/types/translation';
import { createOpenAICompatibleTranslator } from '../custom/openaiCompatible';
import type { TranslationProvider, TranslationContext } from '../types';
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

/** `CoreStatus` from `local_engine_status` in `translation_core`. */
export interface LocalEngineStatus {
  ready: boolean;
  engine: string;
  llama_cpp_commit: string;
  model_path: string | null;
  n_ctx: number;
  threads: number;
  error: string | null;
}

/** `LocalTranslation` from `translate_local` in `translation_core`. */
interface LocalTranslationResult {
  job_id: string;
  text: string;
  tokens: number;
  ms: number;
  cancelled: boolean;
}

/** Models directory passed to the core; '' means its built-in default. */
const readModelsDir = (): string =>
  (useSettingsStore.getState().settings?.localTranslator?.modelsDir ?? '').trim();

/**
 * One status probe per models directory. A rejection is evicted so installing
 * the model later can be picked up without restarting the app.
 */
const engineStatuses = new Map<string, Promise<LocalEngineStatus>>();

const embeddedUnavailable = (detail: string): Error =>
  new Error(
    `${ErrorCodes.LOCAL_TRANSLATOR_UNAVAILABLE}: ${detail}. Install the local ` +
      'translation model (Hy-MT2-1.8B Q4_K_M GGUF), then try again.',
  );

const ensureEmbeddedEngine = (): Promise<LocalEngineStatus> => {
  const modelsDir = readModelsDir();
  const cached = engineStatuses.get(modelsDir);
  if (cached) return cached;
  const pending = invoke<LocalEngineStatus>('local_engine_status', { modelsDir })
    .then((status) => {
      if (!status?.ready) {
        engineStatuses.delete(modelsDir);
        throw embeddedUnavailable(
          `the embedded translation model is not installed${
            status?.error ? ` (${status.error})` : ''
          }`,
        );
      }
      return status;
    })
    .catch((err: unknown) => {
      engineStatuses.delete(modelsDir);
      throw err;
    });
  engineStatuses.set(modelsDir, pending);
  return pending;
};

const abortError = (signal?: AbortSignal): Error =>
  signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');

let jobCounter = 0;

const nextJobId = (): string => {
  const uuid = globalThis.crypto?.randomUUID;
  return typeof uuid === 'function'
    ? uuid.call(globalThis.crypto)
    : `local-${Date.now()}-${++jobCounter}`;
};

/**
 * The core takes a free-form context string that it prepends to the user
 * message; carry the language pair and the book metadata there.
 */
const renderEmbeddedContext = (
  sourceLang: string,
  targetLang: string,
  context?: TranslationContext,
): string => {
  const lines = [`Translate from ${sourceLang} to ${targetLang}.`];
  if (context?.bookTitle?.trim()) lines.push(`Book: ${context.bookTitle.trim()}`);
  if (context?.bookAuthor?.trim()) lines.push(`Author: ${context.bookAuthor.trim()}`);
  return lines.join('\n');
};

const toEmbeddedError = (err: unknown, signal?: AbortSignal): Error => {
  if (signal?.aborted) return abortError(signal);
  const name = (err as { name?: string })?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return err as Error;
  const message = err instanceof Error ? err.message : String(err);
  if (/cancelled/i.test(message)) return abortError(signal);
  if (/engine not loaded/i.test(message)) {
    return embeddedUnavailable(`the embedded translation engine is not loaded (${message})`);
  }
  if (/model missing/i.test(message)) {
    return embeddedUnavailable(`the embedded translation model is missing (${message})`);
  }
  return err instanceof Error ? err : new Error(message);
};

/**
 * Translate one text at a time: the embedded engine is single-threaded, so
 * concurrent IPC calls would only queue behind each other.
 */
const translateEmbedded = async (
  texts: string[],
  sourceLang: string,
  targetLang: string,
  signal?: AbortSignal,
  context?: TranslationContext,
): Promise<string[]> => {
  await ensureEmbeddedEngine();
  const promptContext = renderEmbeddedContext(sourceLang, targetLang, context);
  const results: string[] = [];
  for (const text of texts) {
    if (!text?.trim()) {
      results.push(text);
      continue;
    }
    signal?.throwIfAborted();
    const jobId = nextJobId();
    const onAbort = (): void => {
      void invoke<boolean>('cancel_translation', { jobId }).catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await invoke<LocalTranslationResult>('translate_local', {
        jobId,
        text,
        context: promptContext,
      });
      // Cancellation is a soft result from the core; surface it as an abort.
      if (result?.cancelled) throw abortError(signal);
      results.push(result?.text ?? '');
    } catch (err) {
      throw toEmbeddedError(err, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return results;
};

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
  if (isTauriAppPlatform()) {
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    try {
      const status = await invoke<LocalEngineStatus>('local_engine_status', {
        modelsDir: readModelsDir(),
      });
      // Report no model ids: the settings panel would otherwise copy a GGUF
      // path into the web `model` field.
      return status?.ready
        ? { ok: true, models: [], latencyMs: elapsed() }
        : {
            ok: false,
            models: [],
            latencyMs: elapsed(),
            error: status?.error ?? 'model not installed',
          };
    } catch (err) {
      return {
        ok: false,
        models: [],
        latencyMs: elapsed(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
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
  getCacheKey: (sourceLang, targetLang, context) => {
    const transport = isTauriAppPlatform() ? 'embedded' : 'http';
    const base = getBaseTranslator(readLocalTranslatorConfig()).getCacheKey!(
      sourceLang,
      targetLang,
      context,
    );
    // A paragraph translated by the HTTP server and one translated by the
    // embedded core must never share a cache entry.
    return `${transport}#${base}`;
  },
  translate: async (texts, sourceLang, targetLang, token, useCache, signal, context) => {
    if (isTauriAppPlatform()) {
      // No network fallback: a missing model is an error, not a reason to
      // send the book text to a remote provider.
      return translateEmbedded(texts, sourceLang, targetLang, signal, context);
    }
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
