# Plan: first-class `local` translation provider (llama.cpp @ 127.0.0.1:8080/v1)

Date: 2026-11-05 · Scope: `apps/readest-app` (TS only, no Tauri IPC, no Rust)

## 0. Key discovery (changes the whole shape of the task)

The repo **already contains a full OpenAI-compatible translator over plain HTTP**:
`src/services/translators/custom/openaiCompatible.ts:139` `createOpenAICompatibleTranslator(config)`.
It implements everything requested in point 1: batching with `[n]` block markers (`:173-195`),
a bounded queue (`:197-210`), per-request timeout via `AbortController` (`:152-171`), caller-signal
cancellation (`:261-268`), reasoning-block stripping (`:44-45`), thinking-off dialect params
(`:51-67`), 400-fallback without the thinking param (`:110-118`), and a cache key folding
model + rendered prompt (`:243-246`). Transport is `getAIFetch()`
(`src/services/ai/utils/httpFetch.ts`): `tauriFetch` in the app, `window.fetch` in web.

**Do not duplicate that logic.** `local` = a thin wrapper that feeds this factory a config built
from settings, plus a friendlier error. Required factory change is additive and default-preserving.

`translate()` contract to satisfy: `src/services/translators/types.ts:40-48`.

---

## 1. `localDefaults.ts` (CREATE — leaf module, no store imports)

`src/services/translators/localDefaults.ts`

```ts
export const LOCAL_TRANSLATOR_NAME = 'local';
export const LOCAL_TRANSLATOR_LABEL = 'Local Server';

export const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:8080/v1';
export const DEFAULT_LOCAL_MODEL = 'local';
export const DEFAULT_LOCAL_TEMPERATURE = 0.2;

/** CPU inference is slow: a 3000-char batch must not die at the 60 s default. */
export const LOCAL_REQUEST_TIMEOUT_MS = 180_000;
export const LOCAL_BATCH_ITEMS = 2;
export const LOCAL_BATCH_CHARS = 1200;
export const LOCAL_BATCH_INFLIGHT = 2;

/** '' / missing scheme / bare host → a usable base URL ending in /v1. */
export const normalizeLocalEndpoint = (raw: string | undefined): string => string;
```

`normalizeLocalEndpoint` pseudocode:

1. `let v = (raw ?? '').trim()`; if empty → `return DEFAULT_LOCAL_ENDPOINT`.
2. if `!/^https?:\/\//i.test(v)` → `v = 'http://' + v`.
3. `let u: URL; try { u = new URL(v) } catch { return v }` (a bad URL must not be silently
   replaced — the request then fails with a message that quotes it).
4. if `u.pathname === '' || u.pathname === '/'` → `u.pathname = '/v1'`.
5. `return u.toString().replace(/\/+$/, '')`.

Why a separate file: `services/constants.ts` (imported by the store) must be able to import these
defaults **without** pulling `providers/local.ts` → `store/settingsStore` → `services/constants`
(import cycle). `providers/local.ts` imports this file; `services/constants.ts` imports only this file.

---

## 2. Where endpoint/model live (point 2)

**Top-level `SystemSettings.localTranslator`, not `ReadSettings` and not `ViewSettings`.**

Reasons (verified):
- It is device-local: `127.0.0.1`/a LAN IP is meaningful only on this machine.
- `SETTINGS_WHITELIST` (`src/services/sync/replicaSettingsSync.ts:43-47`, from
  `@/services/sync/adapters/settings`) is a **per-field** list; a key that is not listed never
  syncs. A new top-level group is therefore local-only by construction — but `mergeSettings`
  (`:443-460`) also needs nothing new because it does a top-level shallow merge.
- `BACKUP_SETTINGS_BLACKLIST` (`src/services/backupService.ts:47`) documents exactly this class of
  field ("Device filesystem paths — invalid on another device"); add ours there so a restore on
  another machine does not import a foreign endpoint.

### 2.1 `src/types/settings.ts`

New interface, insert before `SystemSettings` (`:446`):

```ts
/** Local OpenAI-compatible translation server (llama.cpp / llama-server). Device-local. */
export interface LocalTranslatorSettings {
  /** Base URL including the API version path, e.g. http://127.0.0.1:8080/v1 */
  endpoint: string;
  model: string;
  /** Sampling temperature; no UI yet, set in settings JSON / future panel. */
  temperature: number;
}
```

Field in `SystemSettings` right after `aiSettings: AISettings;` (`:607`):

```ts
  localTranslator: LocalTranslatorSettings;
```

### 2.2 `src/services/constants.ts`

- import `{ DEFAULT_LOCAL_ENDPOINT, DEFAULT_LOCAL_MODEL, DEFAULT_LOCAL_TEMPERATURE }` from
  `./translators/localDefaults` (next to the existing `DEFAULT_AI_SETTINGS` import, `:40`).
- new export near `DEFAULT_SYSTEM_SETTINGS`, and the field next to `aiSettings: DEFAULT_AI_SETTINGS`
  (`:281`):

```ts
export const DEFAULT_LOCAL_TRANSLATOR_SETTINGS: LocalTranslatorSettings = {
  endpoint: DEFAULT_LOCAL_ENDPOINT,
  model: DEFAULT_LOCAL_MODEL,
  temperature: DEFAULT_LOCAL_TEMPERATURE,
};
```

### 2.3 `src/services/settingsService.ts`

After the `settings.aiSettings = { ... }` block (`:162-165`), add the same shape of merge so installs
created before this change get defaults:

```ts
  settings.localTranslator = {
    ...DEFAULT_LOCAL_TRANSLATOR_SETTINGS,
    ...settings.localTranslator,
  };
```
(import `DEFAULT_LOCAL_TRANSLATOR_SETTINGS` at `:13-25`).

### 2.4 `src/services/backupService.ts`

Add `'localTranslator'` to `BACKUP_SETTINGS_BLACKLIST` (`:47-…`), in the device-path section.

---

## 3. `providers/local.ts` (CREATE)

`src/services/translators/providers/local.ts`

```ts
import { useSettingsStore } from '@/store/settingsStore';
import { createOpenAICompatibleTranslator } from '../custom/openaiCompatible';
import type { TranslationProvider } from '../types';
import type { CustomTranslator } from '@/types/translation';
import { ErrorCodes } from '../types';
import { /* constants above */ } from '../localDefaults';

export interface LocalTranslatorConfig {
  baseUrl: string;
  model: string;
  temperature: number;
}

export const readLocalTranslatorConfig = (): LocalTranslatorConfig => LocalTranslatorConfig;

export interface LocalEndpointCheck {
  ok: boolean;
  models: string[];
  latencyMs: number;
  error?: string;
}

export const checkLocalEndpoint = async (
  endpoint: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<LocalEndpointCheck> => Promise<LocalEndpointCheck>;

export const localProvider: TranslationProvider;
```

### 3.1 `readLocalTranslatorConfig()` (settings read, point 1)

```
const stored = useSettingsStore.getState().settings?.localTranslator;   // may be undefined pre-hydration
return {
  baseUrl: normalizeLocalEndpoint(stored?.endpoint),
  model: (stored?.model ?? DEFAULT_LOCAL_MODEL).trim() || DEFAULT_LOCAL_MODEL,
  temperature: Number.isFinite(stored?.temperature)
    ? stored!.temperature!
    : DEFAULT_LOCAL_TEMPERATURE,
};
```
Read on **every** call (not at module init) so editing the endpoint in Settings takes effect without
a reload. Never throws when settings are not hydrated — falls back to `127.0.0.1:8080/v1`.

### 3.2 Base-translator cache (one instance per endpoint+model)

```
const instances = new Map<string, TranslationProvider>();   // cap 8, evict instances.keys().next()

const getBaseTranslator = (cfg: LocalTranslatorConfig): TranslationProvider => {
  const key = `${cfg.baseUrl}\n${cfg.model}\n${cfg.temperature}`;
  const cached = instances.get(key);
  if (cached) return cached;
  const config: CustomTranslator = {
    id: LOCAL_TRANSLATOR_NAME,          // factory only uses it for the default name
    type: 'openai-compatible',
    name: LOCAL_TRANSLATOR_LABEL,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    thinking: 'off',                    // llama.cpp ignores the param; Qwen3/Gemma stop thinking
    addedAt: 0,
    updatedAt: 0,
  };
  const provider = createOpenAICompatibleTranslator(config, {
    name: LOCAL_TRANSLATOR_NAME,
    cacheKeySalt: cfg.baseUrl,          // point 5: endpoint change ⇒ new cache namespace
    requestTimeoutMs: LOCAL_REQUEST_TIMEOUT_MS,
    batch: { items: LOCAL_BATCH_ITEMS, chars: LOCAL_BATCH_CHARS, inflight: LOCAL_BATCH_INFLIGHT },
  });
  instances.set(key, provider);
  return provider;
};
```
Reusing the instance matters: the factory's `pending`/`queue` (`:140-142`) batch **across**
`translate()` calls (`BATCH_DELAY_MS = 50`, `:10`). A fresh instance per call would send one request
per paragraph.

### 3.3 Error mapping (llama-server not running)

```
const toLocalError = (err: unknown, baseUrl: string): Error => {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return err;
  const status = (err as { statusCode?: number }).statusCode;
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 404)
    return new Error(`${ErrorCodes.LOCAL_TRANSLATOR_UNAVAILABLE}: ${baseUrl}/chat/completions returned 404 — the endpoint should end with /v1`);
  if (/fetch failed|Failed to fetch|NetworkError|Load failed|ECONNREFUSED|ECONNRESET|timed out|aborted/i.test(msg))
    return new Error(`${ErrorCodes.LOCAL_TRANSLATOR_UNAVAILABLE}: cannot reach ${baseUrl}. Start llama-server or change the endpoint in Settings → Language.`);
  return err instanceof Error ? err : new Error(String(err));
};
```
The 401/403 → `ErrorCodes.UNAUTHORIZED` mapping from the factory (`:133-137`) is preserved for every
other case.

`TranslatorPopup` surfaces the message verbatim in `errorDetail`
(`src/app/reader/components/annotator/TranslatorPopup.tsx:151-158`, rendered at `:232-234`), so this
text is what the user actually sees.

### 3.4 The provider object

```ts
export const localProvider: TranslationProvider = {
  name: LOCAL_TRANSLATOR_NAME,
  label: LOCAL_TRANSLATOR_LABEL,
  authRequired: false,
  premiumRequired: false,
  requiresApp: false,      // web works via window.fetch — CORS/mixed-content caveat, see Risks
  concurrency: 8,          // fill batches; the factory caps in-flight requests
  getCacheKey: (sourceLang, targetLang, context) =>
    getBaseTranslator(readLocalTranslatorConfig()).getCacheKey!(sourceLang, targetLang, context),
  translate: async (texts, sourceLang, targetLang, token, useCache, signal, context) => {
    const cfg = readLocalTranslatorConfig();
    try {
      return await getBaseTranslator(cfg).translate(
        texts, sourceLang, targetLang, token, useCache, signal, context,
      );
    } catch (err) {
      throw toLocalError(err, cfg.baseUrl);
    }
  },
};
```
`preservesMarkup` stays unset (no live verification of tag preservation — `types.ts:10-18` explicitly
forbids guessing).

### 3.5 `checkLocalEndpoint()` (health check for the UI button)

```
const base = normalizeLocalEndpoint(endpoint);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 5_000);
const t0 = performance.now();
try {
  const res = await getAIFetch()(`${base}/models`, { signal: opts?.signal ?? controller.signal });
  if (res.ok) {
    const json = await res.json().catch(() => ({}));
    const models = Array.isArray(json?.data) ? json.data.map((m) => String(m?.id ?? '')).filter(Boolean) : [];
    return { ok: true, models, latencyMs: Math.round(performance.now() - t0) };
  }
  // Older llama-server builds: native /health.
  const health = await getAIFetch()(`${base.replace(/\/v1$/, '')}/health`, { signal: controller.signal });
  if (health.ok) return { ok: true, models: [], latencyMs: Math.round(performance.now() - t0) };
  return { ok: false, models: [], latencyMs: ..., error: `${res.status} ${res.statusText}` };
} catch (err) {
  return { ok: false, models: [], latencyMs: ..., error: err instanceof Error ? err.message : String(err) };
} finally { clearTimeout(timer); }
```
Never throws — the button must not crash the settings panel.

---

## 4. Factory extension (MODIFY, additive, default-preserving)

`src/services/translators/custom/openaiCompatible.ts`

```ts
export interface BatchLimits { items: number; chars: number; inflight: number }

export interface OpenAICompatibleOptions {
  /** Provider name; defaults to `custom:<id>`. */
  name?: string;
  /** Folded into the cache fingerprint so a base-URL change yields fresh translations. */
  cacheKeySalt?: string;
  requestTimeoutMs?: number;
  batch?: Partial<BatchLimits>;
}

export const createOpenAICompatibleTranslator = (
  config: CustomTranslator,
  options: OpenAICompatibleOptions = {},
): TranslationProvider
```

Body edits (no other changes):

| line | change |
|---|---|
| `:139-142` | destructure: `const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;` · `const limits = { items: MAX_BATCH_ITEMS, chars: MAX_BATCH_CHARS, inflight: MAX_INFLIGHT_BATCHES, ...options.batch };` |
| `:157` | `setTimeout(() => controller.abort(), timeoutMs)` |
| `:198` | `while (inflight < limits.inflight && queue.length > 0)` |
| `:225-226` | `batch.items.length >= limits.items \|\| batch.chars + item.text.length > limits.chars` |
| `:240` | `name: options.name ?? \`${CUSTOM_TRANSLATOR_PREFIX}${config.id}\`` |
| `:243-246` | `md5Fingerprint(\`${config.model}\n${options.cacheKeySalt ?? ''}\n${renderSystem(...)}\`)` |

All custom-translator call sites (`custom/index.ts:17`) pass no options → byte-identical behaviour.
Existing test `src/__tests__/services/translators/custom/openaiCompatible.test.ts` must stay green
unchanged.

---

## 5. Registry (MODIFY)

`src/services/translators/providers/index.ts`

1. import (`:4-7` block): `import { localProvider } from './local';`
   and `import { LOCAL_TRANSLATOR_NAME } from '../localDefaults';`
2. `:21-24`: `const localTranslator = createTranslator(LOCAL_TRANSLATOR_NAME, localProvider);`
3. `:26-32` — `local` **first** so every "first available" fallback lands on local:
   `[localTranslator, deeplTranslator, azureTranslator, googleTranslator, yandexTranslator]`.
4. new exported helper (single source for the anti-fallback rule, point 6):

```ts
/**
 * Resolve the provider to actually use. `local` is never silently swapped for a
 * cloud provider: a wrong-endpoint translation would hide the misconfiguration
 * behind a working (billed) network call. Everything else keeps the historical
 * "fall back to the first available" behaviour.
 */
export const resolveTranslator = (
  name: TranslatorName,
  hasToken: boolean,
  hasPremium: boolean,
): TranslationProvider | undefined => {
  const available = getTranslators().filter((t) => isTranslatorAvailable(t, hasToken, hasPremium));
  const exact = available.find((t) => t.name === name);
  if (exact) return exact;
  if (name === LOCAL_TRANSLATOR_NAME) return getTranslator(name);
  return available[0];
};
```

Call sites to switch to it:
- `src/hooks/useTranslator.ts:52-62` — replace lines `56-57` with
  `const selectedTranslator = resolveTranslator(provider, !!token, hasPremium);` and keep
  `setTransltor(selectedTranslator)` guarded (`if (!selectedTranslator) return;` — then `translate`
  throws the explicit "No translator found" error at `:118-120`).
- `src/app/reader/components/annotator/TranslatorPopup.tsx:98-113` (`handleProviderChange`) — same
  substitution; `if (!selectedTranslator) return;` instead of `availableTranslators[0]!`.
- `src/components/settings/LangPanel.tsx:185-193` (`getCurrentTranslationProviderOption`) — keep
  `'local'` selected even when it reports unavailable, i.e.
  `const currentProvider = resolveTranslator(value, !!token, hasPremium)?.name ?? value;`.

**Hard rule:** never set `disabled: true` on `local` as a "down" signal — `isTranslatorAvailable`
(`providers/index.ts:63`) would make it invisible to the fallback logic and the dropdown, and the
`disabled` path in `getTranslatorDisplayLabel` (`:83-87`) labels it "App only". Down-ness is a
translate-time error only.

---

## 6. `types.ts` (MODIFY)

`src/services/translators/types.ts:70-75`, add to `ErrorCodes`:

```ts
  LOCAL_TRANSLATOR_UNAVAILABLE: 'Local Translator Unavailable',
```

---

## 7. Minimal UI in `LangPanel` (point 3)

`src/components/settings/LangPanel.tsx`

### 7.1 imports
- `primitives` block (`:28-34`): add `SettingsInput`.
- `@/services/translators` block (`:12-16`): add `resolveTranslator` (only if 5.3 is applied here).
- `@/services/translators/localDefaults`: `LOCAL_TRANSLATOR_NAME, DEFAULT_LOCAL_ENDPOINT`.
- `@/services/translators/providers/local`: `checkLocalEndpoint`.
- `@/types/settings`: `LocalTranslatorSettings`.
- store hook (`:47-48`): `const { settings, setSettings, saveSettings, ... } = useSettingsStore();`
  (`saveSettings(envConfig, settings)` is the established pattern — `TTSPanel.tsx:39,162`).

### 7.2 state + handlers (place after `:59-63`)

```ts
const [localEndpoint, setLocalEndpoint] = useState(settings.localTranslator?.endpoint ?? DEFAULT_LOCAL_ENDPOINT);
const [localModel, setLocalModel] = useState(settings.localTranslator?.model ?? DEFAULT_LOCAL_MODEL);
const [localCheck, setLocalCheck] = useState<{ status: 'idle' | 'checking' | 'ok' | 'error'; detail?: string }>({ status: 'idle' });

const saveLocalTranslatorSettings = async (patch: Partial<LocalTranslatorSettings>): Promise<void> => {
  const store = useSettingsStore.getState();
  const current = store.settings.localTranslator ?? DEFAULT_LOCAL_TRANSLATOR_SETTINGS;
  const newSettings = { ...store.settings, localTranslator: { ...current, ...patch } };
  store.setSettings(newSettings);
  await store.saveSettings(envConfig, newSettings);
};

const handleCheckLocalConnection = async (): Promise<void> => { /* set checking → await checkLocalEndpoint(localEndpoint) → ok/error; on ok with models, adopt models[0] into localModel + saveLocalTranslatorSettings({model}) when the current value is not in the list */ };
```
Save on `onBlur` (not per keystroke) so a half-typed URL is never persisted; `checkLocalEndpoint`
normalises anyway.

### 7.3 render

Insert **between the prompt row and the "Translate To" row** — i.e. after the
`{isLLMProvider && ( ... )}` block that ends at `:521`, before `<SettingsRow label={_('Translate To')} ...>` at `:522`:

```tsx
{translationProvider === LOCAL_TRANSLATOR_NAME && (
  <>
    <SettingsRow label={_('Endpoint')} data-setting-id='settings.language.localEndpoint'>
      <SettingsInput
        value={localEndpoint}
        placeholder={DEFAULT_LOCAL_ENDPOINT}
        spellCheck={false}
        autoCapitalize='off'
        aria-label={_('Endpoint')}
        onChange={(e) => setLocalEndpoint(e.target.value)}
        onBlur={() => saveLocalTranslatorSettings({ endpoint: localEndpoint })}
      />
    </SettingsRow>
    <SettingsRow label={_('Model')} data-setting-id='settings.language.localModel'>
      <SettingsInput
        value={localModel}
        placeholder={DEFAULT_LOCAL_MODEL}
        spellCheck={false}
        aria-label={_('Model')}
        onChange={(e) => setLocalModel(e.target.value)}
        onBlur={() => saveLocalTranslatorSettings({ model: localModel })}
      />
    </SettingsRow>
    <SettingsRow label={_('Connection')} data-setting-id='settings.language.localTest'>
      <div className='flex items-center gap-2'>
        <span className='text-xs text-base-content/60'>
          {localCheck.status === 'ok' ? _('Connected') : localCheck.status === 'error' ? (localCheck.detail ?? _('Unreachable')) : ''}
        </span>
        <button
          type='button'
          className='btn btn-sm btn-contrast eink-bordered'
          onClick={handleCheckLocalConnection}
          disabled={localCheck.status === 'checking'}
        >
          {localCheck.status === 'checking' ? _('Checking...') : _('Test')}
        </button>
      </div>
    </SettingsRow>
  </>
)}
```

Note `data-setting-id` is required by the settings search / scroll-to (`:118` comment).

`SettingsInput` is `src/components/settings/primitives/SettingsInput.tsx` — chromeless trailing-edge
input, `value`+`onChange` are plain React props; `className` is merged last if a wider field is
needed (`max-w-[60%]` default is fine for a URL).

### 7.4 prompt row for local

`:204-211` — local uses the same prompt library, so it should show the Prompt row without a
premium gate:

```ts
const isLLMProvider =
  translationProvider === LOCAL_TRANSLATOR_NAME ||
  (hasPremium &&
    isCustomTranslatorName(translationProvider) &&
    customTranslators.some((t) => `custom:${t.id}` === translationProvider && t.type === 'openai-compatible'));
```

---

## 8. Making `local` the default (point 4)

| file:line | now | after |
|---|---|---|
| `src/services/constants.ts:331` (`DEFAULT_READSETTINGS.translationProvider`) | `'deepl'` | `'local'` |
| `src/services/constants.ts:544` (`DEFAULT_TRANSLATOR_CONFIG.translationProvider`) | `'deepl'` | `'local'` |
| `providers/index.ts:26-32` array order | deepl first | `local` first |

Why this does not break anyone (verified): `loadSettings` builds
`{ ...DEFAULT_READSETTINGS, ...settings.globalReadSettings }` (`settingsService.ts:141-157`) —
a persisted value always wins, so an existing user keeps `deepl`/`google`. Per-book configs are
created from `DEFAULT_TRANSLATOR_CONFIG` only in `settingsService.ts:55` (`{ ...DEFAULT_TRANSLATOR_CONFIG, ... }`),
so **new books** start on `local` while existing book configs keep their stored provider.

Consequence of the array reorder: a user whose stored provider is unavailable (e.g. `deepl` without a
token) now falls back to `local` instead of `google`. That is the fork's intent; the local provider
still appears unavailable-free, so they get a clear "cannot reach …" message rather than a silent
cloud call.

**Current, already-persisted session:** switch once in Settings → Language → Translation Service →
`Local Server` (it persists via `saveGlobalSettings`, `LangPanel.tsx:195-201`). Deliberately **no
migration** that overwrites a stored `translationProvider` — that is the "ломка" to avoid. If a
forced rollout is ever required, do it as an explicit `SYSTEM_SETTINGS_VERSION` bump in
`settingsService.ts:123-140` with a visible changelog line, not silently.

---

## 9. Cache key (point 5)

`getCacheKey` of the base factory (`openaiCompatible.ts:243-246`) already folds **model** and the
**rendered system prompt**. With `cacheKeySalt: cfg.baseUrl` inside the same `md5Fingerprint`, the
resulting namespace is `local#<md5(model\nendpoint\nprompt)>`:

- switching model → different hash → old translations are not returned;
- switching endpoint (same model name on another server) → different hash;
- temperature changes do not invalidate (intentional: it does not change meaning).
- The namespace contains no `:` (hex + `local#`), so `getCacheKey`
  (`src/services/translators/cache.ts:147-154`) and the `provider`-prefix parsing in `clearCache`
  (`:271-275`) keep working exactly like `custom:<id>#<hash>` does today.

No change to `cache.ts` is needed.

---

## 10. Blocking silent fallback (point 6)

Covered by `resolveTranslator` (§5.4) at the three selection sites. Explicitly out of scope and
verified as non-existent today: the reader never retries a failed `translate()` with another
provider (`useTranslator.ts:117-150` has one `try/catch` that rethrows; `useTextTranslation.ts:468`
is the only catch upstream and it reports the error). So a dead llama-server produces an error
message, never a Google translation.

Additional guard to keep it that way: the `local` provider must never be marked `disabled`
(§5, hard rule) — `useTranslator.ts:53-57` and `TranslatorPopup.tsx:102-105` treat `disabled` as
"pick something else".

---

## 11. Tests (point 7)

### CREATE `src/__tests__/services/translators/local.test.ts`

Mirror the mocking style of `src/__tests__/services/translators/custom/openaiCompatible.test.ts:3-11`
(`vi.mock('ai')` with `generateText` spy, `vi.mock('@/services/ai/utils/httpFetch')`), plus
`vi.mock('@/store/settingsStore')` returning a mutable `getState()`.

`describe('localProvider')`
1. `name === 'local'`, `authRequired === false`, `premiumRequired === false`, `requiresApp === false`,
   `concurrency > 0`, `label` non-empty.
2. `translate(['Hello'], 'en', 'fr')` → one `generateText` call whose `system` contains the rendered
   default prompt and `temperature === DEFAULT_LOCAL_TEMPERATURE`.
3. multi-text call → one request containing `[1]\n…\n\n[2]\n…` (batching reaches the factory).
4. `getCacheKey` differs when `settings.localTranslator.model` changes; differs when `endpoint`
   changes; identical for the same endpoint+model+prompt.
5. settings undefined (`getState()` → `{ settings: undefined }`) → still calls the default
   `http://127.0.0.1:8080/v1`, no throw.

`describe('error mapping')`
6. reject with `new TypeError('fetch failed')` → message contains `Local Translator Unavailable` and
   the endpoint.
7. reject with `{ statusCode: 404 }` → message mentions `/v1`.
8. reject with `new DOMException('Aborted', 'AbortError')` → same error instance propagated (not
   reworded).

`describe('normalizeLocalEndpoint')`
9. `'127.0.0.1:8080'` → `'http://127.0.0.1:8080/v1'`; `'http://host:8080/v1/'` → no trailing slash;
   `''` → `DEFAULT_LOCAL_ENDPOINT`.

`describe('checkLocalEndpoint')`
10. `fetch` resolving `{ ok: true, json: () => ({ data: [{ id: 'qwen3-4b' }] }) }` → `{ ok: true, models: ['qwen3-4b'] }`.
11. `fetch` rejecting `TypeError('fetch failed')` → `{ ok: false, error: /fetch failed/ }`, no throw.
12. `res.ok === false` and `/health` 200 → `{ ok: true }` (older llama-server path).

### MODIFY `src/__tests__/services/translators/custom/openaiCompatible.test.ts`

13. `options.name` overrides the `custom:<id>` name.
14. `options.cacheKeySalt` changes the key; two providers with the same config but different salts
   differ.
15. `options.batch: { chars: 50 }` splits two texts into two requests (`generateText` called twice).
16. Existing cases pass untouched (defaults unchanged — the regression guard for §4).

### MODIFY `src/__tests__/hooks/useTranslator.test.tsx`

17. `settings.translationProvider = 'local'` (mock settings store) + a `generateText` mock →
   `translate(['x'])` reaches the local provider.
18. `local` provider unusable → `translator.name === 'local'` and `translate` throws
   `Local Translator Unavailable`; assert **no** `generateText`/fetch call to a cloud provider
   (this is the anti-fallback test).
19. regression: `provider: 'deepl'` with `token: null` still falls back to the first available
   built-in (now `local`) — documents the intentional behaviour change.

### MODIFY `src/__tests__/app/reader/annotator/TranslatorPopup.test.tsx`

20. Provider select lists `Local Server`.
21. Selecting `local` keeps `provider === 'local'` in `settings.globalReadSettings.translationProvider`.

### MODIFY `src/__tests__/services/constants.test.ts` (optional, cheap)

22. `DEFAULT_READSETTINGS.translationProvider === 'local'` and
    `DEFAULT_TRANSLATOR_CONFIG.translationProvider === 'local'`.

Verify:
```
cd apps/readest-app
pnpm test --run src/__tests__/services/translators/local.test.ts \
  src/__tests__/services/translators/custom/openaiCompatible.test.ts \
  src/__tests__/hooks/useTranslator.test.tsx \
  src/__tests__/app/reader/annotator/TranslatorPopup.test.tsx
pnpm lint
```

---

## 12. Commit order (each commit leaves the app working)

| # | commit | contents | why it is independently green |
|---|---|---|---|
| 1 | `refactor(translators): let the OpenAI-compatible factory take name, timeout and batch options` | §4 + tests 13-16 | all defaults identical; no call site changes |
| 2 | `feat(settings): add device-local localTranslator settings` | §2.1-2.4 + test 22 | nothing reads the field yet; load merges defaults |
| 3 | `feat(translators): add the local OpenAI-compatible provider` | §1, §3, §6, §5.1-5.3 (registered **last** in the array), tests 1-12 | provider selectable and functional; default still `deepl` |
| 4 | `feat(translators): default to local and never silently fall back to a cloud provider` | §8 (`:331`, `:544`, array order → first), §5.4 + `resolveTranslator` in `useTranslator`/`TranslatorPopup`/`LangPanel:185-193`, tests 17-19, 21 | behaviour change isolated; tests pin both directions |
| 5 | `feat(settings): endpoint, model and connection test for the local translator` | §7.1-7.4, test 20 | pure UI on top of working settings + provider |
| 6 | `docs: llama-server setup for the local translator` (optional) | 5-line note in `apps/readest-app/AGENTS.md` or `docs/` with the CORS/mixed-content caveat | docs only |

Each step: `pnpm lint` + the touched test files before committing.

---

## 13. Risks (ranked)

1. **Web build cannot reach `http://127.0.0.1` from an HTTPS origin.** `getAIFetch` only bypasses
   CORS in the Tauri app; in web it is `window.fetch` (`services/ai/utils/httpFetch.ts:26-31`).
   Mixed content blocks an `http:` target from a `https:` page *before* CORS is consulted, so
   `requiresApp: false` is honest only for `http://localhost` dev serving. llama-server must also
   emit `Access-Control-Allow-Origin` for the web case. Mitigation: keep `requiresApp: false`, log
   the exact failure text (`toLocalError` quotes the endpoint), document it in commit 6. Manual
   check with `pnpm dev-web` over plain HTTP.
2. **Timeout / batch sizing against CPU inference is guesswork until smoke-tested.** A 3000-char,
   4-item batch at the factory's 60 s default would abort mid-translation; the plan lowers it to
   2 items / 1200 chars / 180 s / 2 in-flight. Too-small batches make each paragraph its own request
   (slow); too-large ones hit the timeout, and the per-item fallback (`:185-194`) multiplies traffic.
   Must be validated against a real llama-server with the target model before commit 5.
3. **Default change + array reorder re-routes users whose previous provider is unavailable.**
   Existing installs keep their explicit choice (`settingsService.ts:141-157`, verified), but a
   `deepl` user without a token now lands on `local`, and if llama-server is not running they lose
   translations they previously got from Google. Mitigation: the error names the endpoint and the
   fix, the popup's own provider select stays usable, and commit 4 is revertible on its own.

Secondary: import cycle `services/constants ↔ providers/local` — avoided by keeping
`localDefaults.ts` import-free (no store, no registry); do not inline these constants into
`providers/local.ts`.

## 14. Out of scope

- Rust/`reqwest` transport for localhost (HTTP via `tauriFetch` is the transport for now).
- Endpoint/model UI for mobile-specific layouts, temperature UI, per-book endpoint overrides.
- `preservesMarkup` for local models (needs live verification of tag repositioning).
- Cancellation of in-flight reader translations (`useTranslator.ts:127` passes `undefined` as the
  signal — pre-existing, unchanged here).
- Streaming responses.
