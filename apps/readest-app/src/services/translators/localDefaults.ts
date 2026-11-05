/** Leaf module: imported by both the settings defaults and the provider. No store imports. */

export const LOCAL_TRANSLATOR_NAME = 'local';
export const LOCAL_TRANSLATOR_LABEL = 'Local Server';

export const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:8080/v1';
export const DEFAULT_LOCAL_MODEL = 'hy-mt2-1.8b';
export const DEFAULT_LOCAL_TEMPERATURE = 0.2;

/** CPU inference is slow: a 3000-char batch must not die at the 60 s default. */
export const LOCAL_REQUEST_TIMEOUT_MS = 180_000;
export const LOCAL_BATCH_ITEMS = 2;
export const LOCAL_BATCH_CHARS = 1200;
export const LOCAL_BATCH_INFLIGHT = 2;

/** '' / missing scheme / bare host → a usable base URL ending in /v1. */
export const normalizeLocalEndpoint = (raw: string | undefined): string => {
  let value = (raw ?? '').trim();
  if (!value) return DEFAULT_LOCAL_ENDPOINT;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/+$/, '');
};
