# Архитектура BiliReader

Документ описывает, как устроен код в `bilireader/main`, какие слои за что
отвечают и какие контракты нельзя ломать. История решений — в
[DECISIONS.md](DECISIONS.md), состояние — в [STATUS.md](STATUS.md).

## 1. Слои

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ UI: Next.js 16 + React + zustand                                             │
│  Library · Reader · Settings · TranslatorPopup · карточка словаря            │
└──────────────┬───────────────────────────────────────────────┬───────────────┘
               │ Tauri invoke / events                        │ DOM + postMessage
┌──────────────▼──────────────────────────┐   ┌───────────────▼───────────────┐
│ Tauri shell (Rust; на Linux — CEF)      │   │ foliate-js (git-подмодуль)     │
│  translation_core                       │   │  paginator.js (CSS columns)    │
│   ├─ TranslationCore (состояние)        │   │  text-index.js (offsets)      │
│   ├─ commands.rs (IPC-контракт)         │   │  overlayer.js (подсветка)     │
│   └─ поток llama-l3 → llama.cpp         │   └───────────────────────────────┘
└──────────────┬──────────────────────────┘
               │ mmap GGUF
┌──────────────▼──────────────────────────┐
│ Hy-MT2-1.8B-Q4_K_M.gguf в каталоге данных│
└─────────────────────────────────────────┘
```

| Слой | Технология | Где | Ответственность |
|---|---|---|---|
| Tauri-шелл | Rust, Tauri v2 | `apps/readest-app/src-tauri/` | окно, IPC, capabilities, updater, CEF на Linux |
| UI | Next.js 16, React, zustand, Tailwind | `apps/readest-app/src/` | библиотека, читалка, настройки, попапы |
| Рендер книги | `foliate-js` (подмодуль) | `packages/foliate-js/` | разбор EPUB/FB2, CSS-пагинация, DOM-текст |
| Ядро перевода | Rust, `llama-cpp-2` 0.1.161 | `apps/readest-app/src-tauri/src/translation_core/` | загрузка GGUF, инференс, отмена, стриминг токенов |
| Провайдер `local` | TypeScript | `apps/readest-app/src/services/translators/providers/local.ts` | выбор транспорта, сериализация абзацев, ошибки |
| Кэш | IndexedDB | `apps/readest-app/src/services/translators/cache.ts` | ключ → перевод, TTL, очистка |
| Менеджер моделей | TypeScript | `apps/readest-app/src/services/models/` | манифест, докачка, SHA-256, удаление |
| Словарь | TypeScript + StarDict | `apps/readest-app/src/services/dictionaries/` | точная форма, лемма, карточка |
| Шрифты | OFL 1.1, `@font-face` | `apps/readest-app/public/fonts/`, `src/styles/` | PT Serif/Sans без сети |

Linux-сборка идёт на CEF, а не на WebKitGTK; Windows и macOS — обычный wry.
CEF добавляет ~256 МиБ (`libcef.so`) и требует X11, но сохраняет паритет с
upstream. Это решение зафиксировано в [DECISIONS.md](DECISIONS.md).

## 2. Поток данных

### 2.1 Выделение слова

```
pointerdown/move/up → useTextSelector → normalizeSingleWord
   → lookupLocalDictionaryWord → buildLookupCandidates (exact → case → lemma)
   → lookupFreedictEntries → StarDictReader (.idx) → DictZip-чанк
   → hit: карточка словаря; miss/фраза: путь переводчика
```

1. `Annotator.tsx` вешает pointer-события на документ iframe и передаёт
   выделение в `useTextSelector.ts`.
2. `normalizeSingleWord` снимает пунктуацию и кавычки, сохраняя апострофы и
   дефисы внутри слова (`don't`, `well-known`); фраза возвращает `null`.
3. `lookupLocalDictionaryWord` перебирает кандидатов: точная форма, варианты
   регистра, затем леммы (`ran` → `run`).
4. `StarDictReader` ищет по `.idx` и распаковывает один DictZip-чанк, а не
   весь `.dict`.
5. Промах, фраза, выключенный словарь или битый ассет возвращают `null`;
   вызывающий код уходит в переводчик. Облако само по себе не подставляется:
   провайдер выбирает пользователь.

### 2.2 Предложение из режима линейки

```
hold 0.4 s → useSentenceHold → sentenceAt(offset)
   → rangeFromOffsets → overlayer.add('sentence-hold') + TranslatorPopup
   → useTranslator → localProvider.translate → cache → invoke('translate_local')
   → поток llama-l3 → translation://token → результат абзаца → попап
```

1. `useSentenceHold` вооружается на удержание строки (0.4 с) и берёт точку из
   `caretRangeFromPoint`; движение вверх/вниз переводит соседнюю строку.
2. `getDocIndex` строит `buildTextIndex` по отрендеренному документу:
   канонический текст, карта `(node, offset) ↔ flat offset`, границы предложений.
3. `sentenceAt` находит предложение по offset, `rangeFromOffsets` превращает
   его в DOM `Range`, `sentenceHighlight` рисует подсветку через `overlayer`.
4. `TranslatorPopup` вызывает `useTranslator.translate`; тот сначала читает
   IndexedDB-кэш и только при промахе идёт в провайдер.
5. `localProvider` на десктопе выбирает embedded-транспорт и вызывает
   `translate_local` по одному тексту за раз; на web — OpenAI-совместимый
   `llama-server`.
6. Rust-команда уходит в `spawn_blocking`, `LlamaEngine` генерирует токены и
   эмитит `translation://token`; провайдер ждёт финальный `LocalTranslation`.
7. `AbortSignal` вызывает `cancel_translation`; результат с `cancelled: true`
   превращается в `AbortError`, а не в перевод.

## 3. Ключевые файлы

| Путь | Роль |
|---|---|
| `apps/readest-app/src/services/translators/providers/local.ts` | провайдер `local`, embedded/web транспорт, ключ кэша |
| `apps/readest-app/src/services/translators/types.ts` | интерфейс `TranslationProvider` |
| `apps/readest-app/src/services/translators/cache.ts` | IndexedDB-кэш переводов |
| `apps/readest-app/src/hooks/useTranslator.ts` | кэш → провайдер → запись в кэш |
| `apps/readest-app/src-tauri/src/translation_core/engine.rs` | трейт `Engine`, `CancelToken`, `TokenSink` |
| `apps/readest-app/src-tauri/src/translation_core/llama.rs` | `LlamaEngine`, поток `llama-l3`, генерация |
| `apps/readest-app/src-tauri/src/translation_core/commands.rs` | Tauri-команды и событие токенов |
| `apps/readest-app/src-tauri/src/translation_core/mod.rs` | состояние, пути модели, `CoreStatus` |
| `apps/readest-app/src/services/models/manifest.ts` | разбор и валидация `manifest.json` |
| `apps/readest-app/src/services/models/modelManager.ts` | скачивание, `Range`, SHA-256, удаление |
| `apps/readest-app/src/services/dictionaries/wordLookup.ts` | маршрут «слово → словарь или переводчик» |
| `apps/readest-app/src/services/dictionaries/dictionaryService.ts` | оркестрация словарных провайдеров |
| `apps/readest-app/src/services/dictionaries/providers/freedictProvider.ts` | встроенный FreeDict EN–RU |
| `apps/readest-app/public/models/manifest.json` | манифест модели |
| `packages/foliate-js/text-index.js` | канонический текст, offsets, предложения |

## 4. Контракты

### 4.1 Tauri-команды

| Wire-имя | Rust-сигнатура | Аргументы `invoke` | Результат |
|---|---|---|---|
| `local_engine_status` | `local_engine_status(models_dir: String) -> Result<CoreStatus, String>` | `{ modelsDir }` | `CoreStatus` |
| `translate_local` | `translate_local(job_id: String, text: String, context: Option<String>) -> Result<LocalTranslation, String>` | `{ jobId, text, context? }` | `LocalTranslation` |
| `cancel_translation` | `cancel_translation(job_id: String) -> Result<bool, String>` | `{ jobId }` | `true`, если job был активен |

Tauri v2 принимает camelCase-аргументы и маппит их в snake_case поля Rust.
Ответы сериализуются как есть, поэтому JSON-поля — snake_case.

```jsonc
// CoreStatus
{ "ready": true, "engine": "llama-cpp-2 0.1.161",
  "llama_cpp_commit": "8642541b...", "model_path": "/path/model.gguf",
  "n_ctx": 2048, "threads": 4, "error": null }

// LocalTranslation
{ "job_id": "uuid", "text": "…", "tokens": 42, "ms": 1234, "cancelled": false }
```

Команды зарегистрированы в пяти местах: `mod translation_core;`,
`generate_handler!`, `app.manage(TranslationCore::new())`, `build.rs`
(`AppManifest::commands`) и `capabilities/default.json`. Пропуск любого места
даёт IPC-ответ «not allowed».

### 4.2 Интерфейс `TranslationProvider`

```ts
interface TranslationProvider {
  name: string;
  label: string;
  authRequired?: boolean;
  premiumRequired?: boolean;
  disabled?: boolean;
  concurrency?: number;
  requiresApp?: boolean;
  getCacheKey?: (
    sourceLang: string,
    targetLang: string,
    context?: TranslationContext,
  ) => string;
  translate: (
    texts: string[],
    sourceLang: string,
    targetLang: string,
    token?: string | null,
    useCache?: boolean,
    signal?: AbortSignal,
    context?: TranslationContext,
  ) => Promise<string[]>;
}
```

Провайдер `local` добавляет к ключу транспорт: `embedded` или `http`.

### 4.3 Манифест модели

`apps/readest-app/public/models/manifest.json`:

```jsonc
{
  "version": 1,
  "models": [{
    "id": "hy-mt2-1.8b-q4_k_m",
    "kind": "translation",          // translation | dictionary
    "lang_pair": "en-ru",
    "urls": ["https://huggingface.co/.../resolve/<sha>/Hy-MT2-1.8B-Q4_K_M.gguf"],
    "size_bytes": 1133080448,
    "sha256": "<64 hex>",
    "license": "Apache-2.0",
    "min_ram_mb": 3072,
    "display_name": "Hy-MT2 1.8B (Q4_K_M)"
  }]
}
```

Имя файла в `urls` обязано совпадать с `MODEL_FILENAME`
(`Hy-MT2-1.8B-Q4_K_M.gguf`): Rust ищет ровно его. Битый манифест отвергается
до загрузки; `sha256` — 64 hex-символа; URL — абсолютные `http(s)`.

### 4.4 Событие `translation://token`

```jsonc
{ "job_id": "<строка>", "delta": "<кусок текста>" }
```

Событие эмитится на каждый сгенерированный токен. Оно нужно для отладки и
будущего стриминга в UI; текущий провайдер ждёт финальный ответ команды.
Событие не является ошибкой при отмене: отмена приходит как
`cancelled: true` в `LocalTranslation`.

## 5. Инварианты

| Инвариант | Как обеспечен |
|---|---|
| Нет silent fallback в облако | `localProvider` не вызывает другие провайдеры; ошибка модели — `Local Translator Unavailable`, а не Google/DeepL |
| Кэш включает модель и транспорт | ключ `embedded#…`/`http#…` + endpoint + модель + промпт; смена конфигурации не переиспользует старый перевод |
| Движок однопоточный | модель и контекст живут в одном потоке `llama-l3`; снаружи только `mpsc::Sender<Job>`; TS шлёт абзацы по одному |
| Offsets вместо CFI | индекс предложений — UTF-16 offset в каноническом тексте; перепагинация не меняет DOM-текст и не ломает якоря |
| Модель не в бандле | манифест + загрузка по кнопке; SHA-256 и размер проверяются до `rename` |
| Две транспорта — два кэша | `getCacheKey` префиксует `embedded` или `http`; HTTP-сервер и встроенное ядро не делят записи |
