# BiliReader — план Фазы 0–1 (форк Readest, офлайн-ядро перевода)

**Дата:** 2026-11-03
**Автор:** Scout
**Статус:** execution contract. Исполнитель (@ivan) выполняет шаги по порядку, без решений и без вопросов.
**База:** форк `readest/readest` (AGPL-3.0), проверено по реальному клону `readest/readest@main` (2026-11-03, `apps/readest-app` версия 0.12.16) и `readest/foliate-js@0c7a0ed`.

---

## 1. Overview

### 1.1 Goal
От `git clone` форка Readest до работающего офлайн-переводчика en→ru (L1 словарь + L2 Marian + L3 llama.cpp) на Linux и Android, с кэшем, очередью с отменой, менеджером моделей и режимом «линейка».

### 1.2 Scope (входит)
1. Бутстрап форка, пины версий, baseline-сборка Linux и Android.
2. Спайки S1–S5 с числовыми порогами приёмки.
3. Rust-модуль `translation_core` в `apps/readest-app/src-tauri/src/`: `trait Engine`, `DictionaryEngine`, `MarianEngine` (ORT), `LlamaEngine` (вендоренный llama.cpp), очередь приоритетов + generation-отмена, SQLite-кэш по sha256.
4. Tauri-команды + записи в `lib.rs`, `build.rs`, `capabilities/default.json`.
5. TS-провайдер `offlineNmt.ts`, регистрация в реестре провайдеров, дефолт провайдера = `offline`.
6. Менеджер моделей (скачивание с докачкой, sha256, удаление) + секция настроек.
7. Sentence index в форке foliate-js (новый файл, без правок существующих) + компонент `SentenceRuler` (long-press + drag).
8. Лицензионная гигиена AGPL и регламент rebase на upstream.

### 1.3 Out of Scope (явно исключено)
- iOS, Windows, macOS, web-деплой (`dev-web`).
- L3-модели на 1.25/2-bit в коммерческую сборку Фазы 1: сборка с патченным llama.cpp вынесена в отдельный шаг 2.3 и не блокирует Фазу 1. Дефолт Фазы 1 — `Q4_K_M` 1.13 ГБ.
- Языковые пары кроме en→ru. Другие пары возвращают ошибку провайдера (см. 1.8).
- TTS, синхронизация, SRS, OCR/PDF, облачный перевод как основной режим.
- Правки существующих файлов foliate-js (`paginator.js`, `view.js`, `epub.js`, `fb2.js`).
- CI-пайплайны, релизные подписи, сторы.
- Изменение UI-дизайна существующих панелей помимо перечисленного в шагах.

### 1.4 Success Criteria (измеримые)
1. `pnpm tauri dev` на Linux открывает окно; EPUB и FB2 открываются, листаются, кегль меняется, позиция сохраняется после перезапуска.
2. `pnpm tauri android build -t aarch64` собирается в APK, приложение открывает EPUB.
3. Спайки S1–S5 пройдены, значения зафиксированы в `output/research/spikes-2026-11.md` (создаёт исполнитель). Пороги — §5.
4. Выделение слова → попап с переводами из словаря (L1) за ≤ 200 мс end-to-end на целевом Android-устройстве.
5. Выделение предложения → перевод L2 за ≤ 400 мс end-to-end; повторный показ того же текста ≤ 20 мс.
6. Long-press по строке → перевод предложения появляется без перелистывания и без нативного меню выделения; точность ≥ 90% на тест-корпусе.
7. `cargo clippy -p Readest --no-deps -- -D warnings` и `pnpm lint` проходят без новых предупреждений.
8. `git diff upstream/main --stat` содержит только файлы из манифеста §3 (Tier 1/2), ни одного файла Tier 3.

---

## 2. Architecture

### 2.1 Компоненты (что реально есть в клоне)

| Компонент | Файл:строка (проверено) | Что делаем |
|---|---|---|
| Интерфейс провайдера | `apps/readest-app/src/services/translators/types.ts:3-49` (`TranslationProvider`), `translate` — `:40-48` | не меняем, реализуем его |
| Реестр провайдеров | `providers/index.ts:21-32` (`availableTranslators`), `:34-48` (`getTranslators`/`getTranslator`), `:58-68` (`isTranslatorAvailable`) | добавляем `offline` |
| Хук перевода + кэш | `src/hooks/useTranslator.ts:64-129` (кэш-первый, затем `activeTranslator.translate`) | не меняем |
| TS-кэш | `services/translators/cache.ts:3-5` (IndexedDB `TranslationCache`), `:156` `getFromCache`, `:202` `storeInCache` | не меняем |
| Попап перевода | `app/reader/components/annotator/TranslatorPopup.tsx:48-80` (props + `useTranslator`) | расширяем под словарную карточку |
| Вызов перевода из UI | `app/reader/components/annotator/Annotator.tsx:1954-1957` (`handleTranslation`), `:2770-2776` (mount `TranslatorPopup`), `:1275` (`case 'translate'`) | не меняем |
| Инлайн-перевод абзацев | `app/reader/hooks/useTextTranslation.ts:49-82` (`createTranslationTargetNode`), `:466` (событие `translation-inserted`), `components/TranslationToggler.tsx:13-43` | используем как есть |
| Регистрация Tauri-команд | `src-tauri/src/lib.rs:661-727` (`generate_handler!`), `:25-59` (список `mod`), `:833-835` (`app.manage`) | добавляем |
| ACL app-команд | `src-tauri/build.rs:34-88` (`AppManifest::new().commands(&[...])`), `capabilities/default.json` (`allow-<kebab-command>`) | добавляем |
| Рендер/пагинатор | `packages/foliate-js/paginator.js:1507` (класс `Paginator`), `:2058` (`#createView`), `:3900-3988` (`load` + `create-overlayer` события), `:4344-4368` (`getContents`), `:3760-3813` (`relocate` detail `{reason, range, index, fraction, size}`) | не меняем |
| Вью | `packages/foliate-js/view.js:224-275` (`View`, подписка на `load`/`relocate`/`create-overlayer`) | не меняем |
| Чанкование секций | `packages/foliate-js/section-chunks.js:1-70` (секция может рендериться несколькими chunk-документами) | учитываем в индексе |
| ReadingRuler (готовый) | `src/app/reader/utils/readingRuler.ts:78-105` (`buildLineBoxes`), `:134-168` (`buildReadingRulerColumns`), `:296-336` (`snapReadingRulerColumns`), `:345-375` (`snapReadingRulerToAnchor`); `components/ReadingRuler.tsx:41-54` (`mapRangeRectsToOverlay`), `:64-95` (`caretRangeAtPoint`) | переиспользуем логику, сам файл не правим |
| Монтирование оверлея | `app/reader/components/BooksGrid.tsx:306-320` (`<ReadingRuler …/>` под `viewState?.inited`) | вставляем `SentenceRuler` рядом |
| Long-press/precedents | `app/reader/hooks/useTextSelector.ts:57-64` (`INSTANT_HOLD_MS=300`, `INSTANT_HOLD_MOVE_PX=10`, `SELECTION_DRAG_SLOP_PX=10`), `:625-669` (`armInstantHold`), `:770-776` (гейт instant annotation); `hooks/useInstantAnnotation.ts:62-68` (гейт `enableAnnotationQuickActions && annotationQuickAction==='highlight'`) | конфликт решаем гейтом |
| Библиотека | `services/libraryService.ts:18-36` → `Books/library.json` (`utils/book.ts` `getLibraryFilename`) | не меняем |
| Прогресс/настройки книги | `utils/book.ts:68` → `Books/<hash>/config.json`, `services/persistence.ts:28-50` (`safeLoadJSON`) | не меняем |
| SQLite (существующий) | `services/database/nativeDatabaseService.ts:1-56` (плагин `tauri-plugin-turso`, схема через `appService.openDatabase(schema, file, base)`; миграции — `services/database/migrations/index.ts:3-15`) | не используем для ядра (ядро в Rust) |
| Нативный плагин-образец | `src-tauri/plugins/tauri-plugin-native-tts/{src/lib.rs,src/commands.rs,android/,ios/,permissions/default.toml}` | образец структуры, не копируем |

### 2.2 Data Flow (Фаза 1)

```
UI (TranslatorPopup | SentenceRuler)
  └─ invoke('translation_translate', {generation, items:[{text, level}]})
        └─ TranslationCore (Rust, managed state)
             ├─ L1 → DictionaryEngine (SQLite, read-only, <10 мс)
             ├─ L2 → очередь CurrentPage → MarianEngine (ORT)
             └─ L3 → очередь Background → LlamaEngine (llama.cpp)
           ключ кэша = sha256(src|dst|level|model|normalize(text))
             └─ SQLite Data/translations.db (WAL)
  ← results: [{text, level, fromCache, senses?, engine, ms}]
```

### 2.3 Dependencies (внешние, с пинами)

| Зависимость | Пин | Источник |
|---|---|---|
| Node | 24.x | `.github/workflows/nightly.yml:116` (`node-version: 24`) |
| pnpm | 11.1.1 | `package.json:25` (`packageManager`) |
| Rust | ≥ 1.95 (stable) | `AGENTS.md:10` (CEF-сборка требует ≥1.95) |
| CEF tauri CLI | `@tauri-apps/cli-cef@3.0.0-alpha.27` | `scripts/tauri.mjs:34` |
| Android NDK | `28.2.13676358`, JDK 17 | `nightly.yml:134` (NDK), `nightly.yml:119` (Java 17) |
| llama.cpp | `8642541b255bfb5dc39cd351a178be09013a55d6` (v0.8.0, 2026-10-28) | GitHub API, проверено 2026-11-03 |
| STQ PR (1.25-bit) | head `1e411d8f5a1e23525fa3265dfb4bd76265465397`, PR #22836 **open** | GitHub API, проверено |
| int2 PR (Q2_0C) | head `2af64dd00a6689a7bfaf69b4768a944d0ec6bade`, PR #19357 **open** | GitHub API, проверено |
| Hy-MT2 GGUF | `tencent/Hy-MT2-1.8B-GGUF` (Q4_K_M 1.13 ГБ), `tencent/Hy-MT2-1.8B-2Bit-GGUF` (572.7 МБ) | `output/research/02-engines.md:49-52` |
| OPUS-MT int8 ONNX | `SashaSobchuk/opus-mt-onnx-int8` (enc 49.1 + dec 86.4 МБ), SP-токенизатор из `Helsinki-NLP/opus-mt-en-ru` | `02-engines.md:100-102` |
| kaikki (Wiktextract) EN | `kaikki.org/dictionary/English/` (3.2 ГБ JSONL), CC-BY-SA | `02-engines.md:175` |

### 2.4 Constraints
- Linux desktop собирается на **CEF**, не на WebKitGTK (`src-tauri/Cargo.toml:19-29`, `scripts/tauri.mjs:49`). `pnpm tauri dev|build` на Linux идут через `cargo --config src-tauri/.cargo/cef.toml`.
- Подмодули обязательны: `packages/foliate-js`, `packages/simplecc-wasm`, `packages/tauri`, `apps/readest-app/src-tauri/plugins/tauri-plugin-turso` (`.gitmodules`; проверка в `Dockerfile:12-14`).
- Секция foliate-js может быть разбита на chunk-документы (`paginator.js:4344-4368`, `section-chunks.js:1-12`): индекс строится **на документ**, а не на секцию.
- В foliate-js нет объекта выделения: `view.js` даёт только `hasSelection` (геттер, `:151`), `deselect()` (`:556`), `renderer.getContents()` (`paginator.js:4344-4368`) и `relocate.detail.range` (`paginator.js:3760-3813`). Всё выделение, long-press и попапы живут в Readest: `useTextSelector.ts` (1430 строк, pointer/selection-машина) и `useInstantAnnotation.ts` (still-hold). Наш SentenceRuler поэтому работает по `getContents()` + `caretRangeFromPoint`, а не через `view.selection`.
- Новые app-команды должны быть в трёх местах: `lib.rs::generate_handler!`, `build.rs::AppManifest::commands`, `capabilities/default.json` (`allow-<kebab>`). Иначе IPC вернёт «not allowed».
- Русские строки UI — только через `_()`/`stubTranslation` (`AGENTS.md:76-78`, `docs/i18n.md`), затем `pnpm i18n:extract`.
- Стиль: Biome (2 пробела, одинарные кавычки, JSX `className` в одинарных), TS strict, `@/*` алиас.

---

## 3. File Manifest

### Tier 1 — CREATE (наши файлы, конфликтов с upstream не дают)

| Файл | Назначение |
|---|---|
| `tools/dict/build_kaikki_ru.py` | сборка `dict-en-ru.sqlite` из kaikki JSONL |
| `tools/models/build_opus_pack.py` | сборка model-pack OPUS-MT (ONNX + tokenizer.json + license) |
| `tools/models/manifest.json` | реестр моделей: id, url, size, sha256, license |
| `tools/spike/Cargo.toml`, `tools/spike/src/bin/bench_marian.rs`, `bench_llama.rs`, `bench_dict.rs` | спайковые бенчмарки (S2/S3) |
| `apps/readest-app/src-tauri/src/translation_core/mod.rs` | фасад `TranslationCore`, состояние |
| `.../translation_core/config.rs` | `CoreConfig`, `CoreStatus` |
| `.../translation_core/error.rs` | `EngineError`, `CoreError` |
| `.../translation_core/engine.rs` | `trait Engine`, `Level`, `CancelToken`, `TranslateItem/Result` |
| `.../translation_core/cache.rs` | SQLite-кэш по sha256 |
| `.../translation_core/queue.rs` | очередь приоритетов + воркеры + generation-отмена |
| `.../translation_core/dictionary.rs` | `DictionaryEngine` |
| `.../translation_core/marian.rs` | `MarianEngine` (ORT) |
| `.../translation_core/llama.rs` | `LlamaEngine` (обёртка над FFI) |
| `.../translation_core/llama_ffi.rs` | `extern "C"` объявления llama.cpp |
| `.../translation_core/models.rs` | манифест, скачивание с докачкой, sha256, удаление |
| `.../translation_core/commands.rs` | `#[tauri::command]`-функции |
| `apps/readest-app/src/services/translators/providers/offlineNmt.ts` | TS-провайдер |
| `apps/readest-app/src/app/reader/utils/caretPoint.ts` | `caretRangeAtPoint` (общий helper) |
| `apps/readest-app/src/app/reader/utils/sentenceIndex.ts` | TS-обёртка над `foliate-js/sentence-index.js` + кэш |
| `apps/readest-app/src/app/reader/components/SentenceRuler.tsx` | режим «линейка» |
| `apps/readest-app/src/components/settings/OfflineModelsSection.tsx` | UI менеджера моделей |
| `packages/foliate-js/sentence-index.js` | индекс предложений (в форке foliate-js) |
| `apps/readest-app/src/__tests__/services/translators/offlineNmt.test.ts` | тест провайдера |
| `apps/readest-app/src/__tests__/app/reader/utils/sentenceIndex.test.ts` | тест индекса |
| `apps/readest-app/src/__tests__/components/OfflineModelsSection.test.tsx` | тест секции настроек |
| `NOTICE` | уведомление о модификациях AGPL |
| `docs/PROVENANCE.md` | происхождение кода и данных |
| `docs/offline-translation.md` | эксплуатация: пути, модели, лимиты |
| `docs/upstream-sync.md` | регламент merge с upstream и плейбук конфликтов |
| `apps/readest-app/src-tauri/vendor/` | подмодуль llama.cpp (pin) |

### Tier 2 — MODIFY (маленькие точечные вставки, вероятны конфликты при rebase)

| Файл | Что добавляем |
|---|---|
| `apps/readest-app/src-tauri/Cargo.toml` | deps: `rusqlite`, `sha2`, `hex`, `unicode-normalization`, `serde`, `ort`, `tokenizers`, `cmake`(build-dep) |
| `apps/readest-app/src-tauri/src/lib.rs` | `mod translation_core;`, команды в `generate_handler!`, `.manage(...)` |
| `apps/readest-app/src-tauri/build.rs` | имена новых команд в `AppManifest::commands` |
| `apps/readest-app/src-tauri/capabilities/default.json` | `allow-translation-*` |
| `apps/readest-app/src/services/translators/providers/index.ts` | импорт + `createTranslator('offline', …)` + элемент массива |
| `apps/readest-app/src/services/constants.ts` | дефолты: `translationProvider: 'offline'` (2 места), 3 новых поля ViewSettings |
| `apps/readest-app/src/types/book.ts` | 3 поля `ViewSettings` |
| `apps/readest-app/src/app/reader/components/BooksGrid.tsx` | `<SentenceRuler …/>` рядом с `<ReadingRuler/>` |
| `apps/readest-app/src/app/reader/components/annotator/TranslatorPopup.tsx` | рендер `senses` (словарная карточка) |
| `apps/readest-app/src/components/settings/LangPanel.tsx` | `<OfflineModelsSection/>` |
| `.gitmodules` | `packages/foliate-js` → наш форк |

### Tier 3 — DO NOT TOUCH (запрещено планом)
`packages/foliate-js/{paginator,view,epub,fb2,epubcfi,overlayer,text-walker}.js`, `apps/readest-app/src/app/reader/hooks/useTextSelector.ts`, `useInstantAnnotation.ts`, `components/ReadingRuler.tsx`, `app/reader/utils/readingRuler.ts`, `hooks/useTranslator.ts`, `services/translators/cache.ts`, `services/database/**`, `services/sync/**`, `src/context/AuthContext.tsx`, любые `pages/api/**`.

---

## 4. Implementation Steps

> Общие правила для исполнителя: команды выполняются из корня репозитория, если не указано иное. После каждого шага — запустить `Verify`. Если `Verify` не даёт ожидаемого — STOP и GAP REPORT.

### Step 0.1 — Бутстрап репозитория и пины

- **File:** `<project>` (рабочая директория проекта) + `.gitmodules`, `docs/fork.txt`
- **Action:** CREATE (репозиторий) / MODIFY (`.gitmodules`)
- **Target:** git-репозиторий форка, ветки, подмодули
- **Signature:** не применимо (операции git)
- **Logic:**
  1. `cd <project>`
  2. `gh auth status` — если команда возвращает non-zero: STOP, GAP REPORT (нужен токен).
  3. Форк:
     ```bash
     ORG="${BILIREADER_ORG:-}"
     if [ -n "$ORG" ]; then gh repo fork readest/readest --org "$ORG" --clone=false --default-branch-only
     else gh repo fork readest/readest --clone=false --default-branch-only; fi
     OWNER="${ORG:-$(gh api user --jq .login)}"
     mkdir -p docs && printf 'fork=%s/readest\nbootstrap_date=2026-11-03\n' "$OWNER" > docs/fork.txt
     ```
  4. `git init -b main`
  5. `git remote add origin https://github.com/$(sed -n 's/^fork=//p' docs/fork.txt)`
  6. `git remote add upstream https://github.com/readest/readest`
  7. `git fetch upstream main` (полная история, без `--depth`: нужна для merge-политики §8.2)
  8. `git reset --hard upstream/main` — рабочее дерево получает код форка как есть
  9. `git push -u origin main`
  10. `git checkout -b bilireader/main && git push -u origin bilireader/main`
  11. Подмодули: `git submodule update --init --recursive`
  12. Заменить субмодуль foliate-js на наш форк:
      ```bash
      ORG="${BILIREADER_ORG:-}"
      if [ -n "$ORG" ]; then gh repo fork readest/foliate-js --org "$ORG" --clone=false
      else gh repo fork readest/foliate-js --clone=false; fi
      FOLLIATE_OWNER="$(sed -n 's/^fork=//p' docs/fork.txt | cut -d/ -f1)"
      git submodule set-url packages/foliate-js "https://github.com/$FOLLIATE_OWNER/foliate-js"
      git submodule sync packages/foliate-js
      git submodule update --init packages/foliate-js
      ```
  13. Исключить наши артефакты из git: `printf 'output/\ntask.txt\n' >> .git/info/exclude`
  14. Зафиксировать пины в `docs/fork.txt`: `upstream_readest=upstream/main@$(git rev-parse --short upstream/main)`, `foliate=readest/foliate-js@0c7a0ed`.
  15. Коммит: `git add -A && git commit -m "chore: bootstrap BiliReader fork (submodules, pins)"`
- **Edge Cases:**
  - `gh repo fork` отвечает «already exists» → продолжить, форк использовать существующий.
  - Каталог содержит `output/` и `task.txt` (untracked) → `git reset --hard` их не трогает, `.git/info/exclude` шаг 13.
  - `git submodule update` падает на сети → STOP (это блокер сборки, `Dockerfile:12-14`).
- **Error Handling:** любая ошибка git/gh → STOP + вывод команды в GAP REPORT. Ничего не «обходить» вручную.
- **Depends On:** none
- **Test:** не применимо (нет кода). Артефакт: `docs/fork.txt` существует и содержит 4 строки `fork=`, `upstream_readest=`, `foliate=`, `bootstrap_date=2026-11-03`.
- **Verify:** `git remote -v | grep -c upstream` → `1`; `git submodule status | grep -c '^ '` → `0` (все инициализированы, без `-` в начале); `ls packages/foliate-js/view.js packages/simplecc-wasm/dist/web` → оба существуют.

### Step 0.2 — Toolchain и файл версий

- **File:** `docs/toolchain.md`
- **Action:** CREATE
- **Target:** документ с точными версиями + проверочный скрипт
- **Signature:** не применимо
- **Logic:**
  1. Создать `docs/toolchain.md` с таблицей: Node `24.x`, pnpm `11.1.1` (через `corepack prepare pnpm@11.1.1 --activate`), Rust `stable` (минимум 1.95), `rustup target add aarch64-linux-android`, NDK `28.2.13676358`, JDK `17`, `sdkmanager "platform-tools"`.
  2. Установка системных зависимостей Linux (точный список из CI, `nightly.yml:177`):
     `sudo apt-get update && sudo apt-get install -y pkg-config libasound2-dev libclang-dev g++ libfontconfig-dev libgtk-3-dev libwebkit2gtk-4.1 libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1 libjavascriptcoregtk-4.1-dev gir1.2-javascriptcoregtk-4.1 gir1.2-webkit2-4.1 libappindicator3-dev librsvg2-dev patchelf xdg-utils libnss3 libpulse0 libspeechd2 libxkbcommon-x11-0 cmake ninja-build`
     (`cmake`/`ninja` — для сборки llama.cpp, шаг 1.6.)
  3. Добавить в `docs/toolchain.md` блок «проверка»: `node -v`, `pnpm -v`, `rustc -V`, `$ANDROID_NDK_HOME/ndk-build --version`, `java -version`.
  4. Создать файл-проверку `scripts/bilireader-check-toolchain.sh` (новый, Tier 1) с кодом возврата 1 при несовпадении major-версий.
- **Edge Cases:**
  - Ubuntu без `libwebkit2gtk-4.1` в репозитории → установить `libwebkit2gtk-4.0-dev` и зафиксировать отклонение в `docs/toolchain.md` (CEF-сборке WebKit нужен только для webdriver-тестов).
  - `rustc` < 1.95 → STOP (CEF-сборка не соберётся, `AGENTS.md:10`).
- **Error Handling:** отсутствие системного пакета → STOP с именем пакета.
- **Depends On:** Step 0.1
- **Test:** не применимо.
- **Verify:** `bash scripts/bilireader-check-toolchain.sh` → exit 0 и печатает 5 строк `OK <tool> <version>`.

### Step 0.3 — Baseline Linux: сборка и приёмка

- **File:** `docs/baseline.md`
- **Action:** CREATE
- **Target:** зафиксированная процедура baseline-приёмки
- **Signature:** не применимо
- **Logic:**
  1. `pnpm install --frozen-lockfile`
  2. `pnpm --filter @readest/readest-app setup-vendors`
  3. Запуск: `pnpm tauri dev` (Linux → CEF, `scripts/tauri.mjs:49`). Первый запуск скачивает CEF-дистрибутив и `@tauri-apps/cli-cef@3.0.0-alpha.27` через `pnpm dlx`.
  4. В `docs/baseline.md` записать: время холодного `dev`-запуска, версию CEF, версию WebView (Настройки → Misc → WebView Info, команда `get_webview_version`).
  5. Приёмочный сценарий (ручной, 6 пунктов): (a) импорт EPUB из `~/Books`; (b) импорт FB2; (c) 10 перелистываний вперёд/назад; (d) смена кегля 16→22→16; (e) закрытие и повторный запуск — позиция в обеих книгах сохранена; (f) `Books/library.json` содержит 2 записи, в `Books/<hash>/config.json` — `progress`.
  6. Продакшн-сборка: `pnpm --filter @readest/readest-app tauri build` (без `.env.tauri.local`; скрипт `build-linux-x64` из `package.json:67` требует отсутствующий `.env.tauri.local` и не используется). Артефакт — `target/release/bundle/**`.
- **Edge Cases:**
  - `pnpm tauri dev` падает на скачивании CEF → STOP с логом (сеть).
  - Окно пустое на Wayland → запустить `WEBKIT_DISABLE_DMABUF_RENDERER=1` не поможет (CEF); повторить с `--ozone-platform=x11` через `CEF_ARGS`, записать в `docs/baseline.md`. Если не помогло — STOP.
  - FB2 не открывается → это блокер Фазы 1 (критерий приёмки), STOP + GAP REPORT с текстом ошибки.
- **Error Handling:** каждая неудача → STOP; «попробовать ещё раз с другими флагами» запрещено, кроме явно перечисленного Wayland-случая.
- **Depends On:** Step 0.2
- **Test:** `docs/baseline.md` содержит 6 отмеченных пунктов + 2 версии.
- **Verify:** `pnpm --filter @readest/readest-app exec tsc --noEmit` → exit 0 (baseline не сломан); `pnpm --filter @readest/readest-app exec dotenv -e .env -- vitest run src/__tests__/utils/misc.test.ts` → `Tests  1 passed` или более, 0 failed.

### Step 0.4 — Baseline Android

- **File:** `docs/baseline-android.md`
- **Action:** CREATE
- **Target:** процедура сборки/установки APK
- **Signature:** не применимо
- **Logic:**
  1. `export ANDROID_HOME=$HOME/Android/Sdk ANDROID_NDK_HOME=$ANDROID_HOME/ndk/28.2.13676358`
  2. `pnpm --filter @readest/readest-app tauri android build -t aarch64` (эквивалент `dev-android` из `package.json:19` без `adb install`).
  3. `adb install -r apps/readest-app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
  4. Повторить приёмочный сценарий 0.3 (a,b,c,e) на устройстве; записать модель, Android API, размер APK.
- **Edge Cases:**
  - `src-tauri/gen/android` уже в репозитории (проверено) → `tauri android init` не запускать.
  - Ошибка NDK version mismatch → выставить ровно `28.2.13676358` (CI-пин), не «ближайшую».
  - `adb` не видит устройство → STOP.
- **Error Handling:** STOP при любой ошибке сборки; лог в GAP REPORT.
- **Depends On:** Step 0.3
- **Test:** не применимо.
- **Verify:** `adb shell pm list packages | grep -c com.bilingify.readest` → `1`; `unzip -l <apk> | grep -c lib/arm64-v8a/libReadest.so` → `1`.

---

### Step S1 — Tauri + foliate-js: EPUB и FB2 на Linux

- **File:** `output/research/spikes-2026-11.md` (раздел `## S1`)
- **Action:** CREATE
- **Target:** измерения рендера/пагинации
- **Signature:** не применимо
- **Logic:**
  1. Подготовить корпус: 3 EPUB (художественная проза, ≥300 КБ текста), 3 FB2 (включая один `windows-1251`), 1 MD, 1 TXT.
  2. Инструментировать замеры **без правок кода**: запустить `pnpm --filter @readest/readest-app tauri:dev:cdp` (скрипт `package.json:48`, выставляет `READEST_CDP_PORT=9222`; обработка переменной — `lib.rs:626-648`), профилировать через `node scripts/cdp.mjs` (существует).
  3. Замерить на каждом файле по 5 повторов: T_open (от клика до первой отрисованной страницы), T_turn (p95 перелистывания), T_reflow (кегль 16→22, p95), T_restore (перезапуск до первой страницы).
  4. Записать медианы и p95 в таблицу раздела `## S1`.
- **Edge Cases:** FB2 с `windows-1251` открывается «кракозябрами» → зафиксировать как `FAIL-FB2-ENCODING` и отдельным пунктом в GAP REPORT (это влияет на §7 PROPOSAL).
- **Error Handling:** CDP не подключается → STOP, записать попытку.
- **Depends On:** Step 0.3
- **Test:** раздел `## S1` содержит 8 строк × 4 метрики.
- **Verify (порог приёмки):** T_open ≤ 3000 мс (EPUB), ≤ 4000 мс (FB2); T_turn p95 ≤ 150 мс; T_reflow p95 ≤ 400 мс на секции ≤ 30 КБ; T_restore ≤ 5000 мс. Любая метрика выше → `S1 = FAIL` и пометка в `docs/baseline.md`.

### Step S2 — llama.cpp + Hy-MT2 на Linux и Android

- **File:** `tools/spike/` (CREATE), раздел `## S2`
- **Action:** CREATE
- **Target:** bench-бинарь поверх вендоренного llama.cpp
- **Signature:** `bench_llama --model <path.gguf> --threads <n> --prompt-file <f> --n-predict <k> --repeat <r>`
- **Logic:**
  1. `git submodule add https://github.com/ggml-org/llama.cpp apps/readest-app/src-tauri/vendor/llama.cpp`; `git -C apps/readest-app/src-tauri/vendor/llama.cpp checkout 8642541b255bfb5dc39cd351a178be09013a55d6`; записать SHA в `docs/llama-pin.txt`.
  2. `tools/spike/Cargo.toml`: `cmake = "0.1"` (build-dep), `serde_json`, `anyhow`; `build.rs` собирает `vendor/llama.cpp` через `cmake::Config::new(...).define("LLAMA_BUILD_TESTS","OFF").define("LLAMA_BUILD_EXAMPLES","OFF").define("LLAMA_CURL","OFF").build()` и линкует `llama`.
  3. `bench_llama.rs`: 6 функций FFI (load, vocab, context, tokenize, decode, sampler) — сигнатуры копируются **дословно** из `vendor/llama.cpp/include/llama.h` на закреплённом коммите. Структуры параметров — через `llama_model_default_params()`, `llama_context_default_params()` (не собирать вручную).
  4. Модели: `hy-mt2-1.8b-q4_k_m.gguf` (1.13 ГБ) и `hy-mt2-1.8b-q2_0c.gguf` (572.7 МБ, скачивается, но на этом шаге **не** запускается).
  5. Замеры Linux: `cargo run --release --bin bench_llama -- --model <q4> --threads 4 --prompt-file tools/spike/prompts/en-ru-1.txt --n-predict 24 --repeat 10`.
  6. Замеры Android: `cargo build --release --target aarch64-linux-android --bin bench_llama` с
     `CC_aarch64_linux_android=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android28-clang`,
     `CXX_aarch64_linux_android=<…>aarch64-linux-android28-clang++`,
     `CMAKE_TOOLCHAIN_FILE=$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake`, `ANDROID_ABI=arm64-v8a`, `ANDROID_PLATFORM=android-28`;
     `adb push target/aarch64-linux-android/release/bench_llama /data/local/tmp/`, `adb push <gguf> /sdcard/Download/`, затем
     `adb shell /data/local/tmp/bench_llama --model /sdcard/Download/<gguf> --threads 4 --n-predict 24 --repeat 10`
     и `adb shell dumpsys meminfo -s <pid>` во время работы.
  7. Записать: time-to-first-token (p50/p95), decode tok/s, полное время на 24 токена, RSS (VmHWM из `adb shell cat /proc/<pid>/status`).
- **Edge Cases:**
  - `cmake` не находит toolchain для android → проверить `CMAKE_TOOLCHAIN_FILE` (обязателен), не менять ABI.
  - Модель не грузится с ошибкой «unknown quantization type» → это ожидаемо для Q2_0C без PR #19357; записать в S2 как `q2_0c=requires_fork`, продолжить на Q4_K_M.
  - Отсутствие `libc++_shared.so` на устройстве → `adb push $ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so /data/local/tmp/` и `LD_LIBRARY_PATH=/data/local/tmp`.
- **Error Handling:** STOP при ошибке сборки; для ошибки загрузки модели — запись в отчёт + продолжение на Q4_K_M.
- **Depends On:** Step 0.3, Step 0.4
- **Test:** раздел `## S2` содержит 2 платформы × 4 метрики + строку `decision=q4_km|q2_0c`.
- **Verify (порог):** Linux: TTFT p95 ≤ 300 мс, полный перевод 24 токенов ≤ 1500 мс, RSS ≤ 1100 МБ. Android (arm64, ≥4 ГБ RAM): TTFT p95 ≤ 800 мс, 24 токена ≤ 3000 мс, RSS ≤ 1100 МБ. Превышение любого порога → `S2 = FAIL`, L3 остаётся выключенным в Фазе 1 (флаг `offlineL3Enabled=false`).

### Step S3 — OPUS-MT int8 через ONNX Runtime на Linux и Android

- **File:** `tools/spike/src/bin/bench_marian.rs` (CREATE), раздел `## S3`
- **Action:** CREATE
- **Target:** бенчмарк Marian (encoder/decoder greedy)
- **Signature:** `bench_marian --pack <dir> --input <file> --threads <n> --repeat <r>`
- **Logic:**
  1. `cargo add --manifest-path tools/spike/Cargo.toml ort --features download-binaries,ndarray` и `tokenizers`.
  2. `bench_marian.rs`: `Session::builder()?.with_intra_threads(n)?.commit_from_file(enc)`, то же для `decoder_merged.onnx`; токенизация `tokenizers::Tokenizer::from_file(tokenizer.json)`; greedy-цикл до `eos_token_id` из `config.json`, лимит 256 шагов.
  3. Модель: `Data/models/opus-mt-en-ru-int8/` из шага 1.5 (на этом шаге допускается скачать вручную в `tools/spike/assets/`).
  4. Linux: 50 предложений из корпуса S1 (en), замер p50/p95 на предложение; Android — те же команды `adb push/shell`, что в S2, `--threads 2` и `--threads 4`.
  5. Записать размер пака (`du -sb`) и RSS.
- **Edge Cases:**
  - `ort` не находит prebuilt для `aarch64-linux-android` → собрать ORT из исходников (`./build.sh --android --android_abi arm64-v8a --build_shared_lib --minimal_build extended --disable_ml_ops --disable_exceptions`), положить `libonnxruntime.so` в `tools/spike/assets/android/`, собрать с `ORT_LIB_LOCATION` и feature `load-dynamic`. Записать выбранный путь в `## S3` как `ort_android=prebuilt|source`.
  - Decoder требует `encoder_hidden_states` как вход — использовать `decoder_merged.onnx` (он объединяет decoder+LM head и принимает `encoder_attention_mask`/`input_ids`/`encoder_hidden_states`).
- **Error Handling:** STOP при несовпадении входных имён ONNX с ожидаемыми; список входов печатать в лог (`session.inputs`).
- **Depends On:** Step S2 (той же обвязкой adb)
- **Test:** раздел `## S3` содержит 2 платформы × 2 метрики + `ort_android=…` + `pack_size_bytes`.
- **Verify (порог):** фраза 2–6 слов: Linux p95 ≤ 60 мс, Android p95 ≤ 150 мс; размер пака ≤ 140 МБ (ожидается 135.5 МБ); RSS ≤ 350 МБ.

### Step S4 — Sentence index + long-press «строка под пальцем»

- **File:** `packages/foliate-js/sentence-index.js`, `apps/readest-app/src/app/reader/utils/sentenceIndex.ts`, `src/__tests__/app/reader/utils/sentenceIndex.test.ts`, раздел `## S4`
- **Action:** CREATE
- **Target:** индекс и попадание по точке
- **Signature:** см. шаг 2.1 (`buildSentenceIndex`, `sentenceAtOffset`, `rangeForSentence`); тест-харнес — `src/__tests__/app/reader/utils/sentenceIndex.test.ts` + браузерный прогон `pnpm --filter @readest/readest-app test:browser`
- **Logic:**
  1. Реализовать `sentence-index.js` по спецификации шага 2.1 (полная логика там; на спайке — только чтение, сегментация, маппинг offset → Range).
  2. Собрать golden-файлы: для 3 книг (EPUB×2, FB2×1) вручную разметить по 20 точек (x,y в координатах iframe) и ожидаемый номер предложения → `apps/readest-app/src/__tests__/fixtures/sentence-golden.json`.
  3. Прогнать: для каждой точки `caretRangeFromPoint` → offset → `sentenceAtOffset` → сравнить с golden.
  4. Замерить построение индекса на секциях 10/30/100 КБ (`performance.now()` вокруг `buildSentenceIndex`), 20 повторов, p95.
- **Edge Cases:**
  - Точка попадает в `<img>`/пустой блок → ожидаемый результат: `null`, не исключение.
  - Chunk-документ: индекс строится на документ; golden фиксирует документ по `index` из `getContents()`.
  - Сноска/`<sup>` внутри предложения → сегмент не должен разрываться (тест-кейс в golden).
- **Error Handling:** исключение в индексаторе → тест падает; на устройстве индексатор оборачивается в `try/catch` и логирует `console.warn`, возвращая `null`.
- **Depends On:** Step 0.3, Step 2.1
- **Test:** `src/__tests__/app/reader/utils/sentenceIndex.test.ts` — 8 кейсов (пустой док, один текстовый узел, несколько узлов, `<br>`, сноска, аббревиатура `т. е.`, аббревиатура `Mr.`, сегмент < 12 символов).
- **Verify (порог):** точность ≥ 90% (54 из 60 точек), построение индекса p95 ≤ 5 мс на 30 КБ; команда: `pnpm --filter @readest/readest-app exec dotenv -e .env -- vitest run src/__tests__/app/reader/utils/sentenceIndex.test.ts` → `0 failed` и печать `accuracy=…`, `index_ms_p95=…`.

### Step S5 — Кэш SQLite + очередь с отменой

- **File:** `apps/readest-app/src-tauri/src/translation_core/{cache.rs,queue.rs}` (реализация шагов 1.2/1.3 в объёме спайка), раздел `## S5`
- **Action:** CREATE
- **Target:** замер кэша и отмены
- **Signature:** `CacheDb::open(path: &Path) -> Result<Self>`; `QueueHandle::submit(job) -> Result<()>`
- **Logic:**
  1. Спайк-бинарь `bench_dict` (в `tools/spike`) с теми же модулями через `#[path]`-include: 10 000 записей → 10 000 чтений по ключу; замер p50/p95 одного `get`.
  2. Замер «повторный показ»: 200 итераций `get` для одного и того же текста после `put`.
  3. Отмена: поставить 50 L3-задач, вызвать `cancel(generation)` на 5-й, замерить число задач, дошедших до инференса (ожидается ≤ 1) и время до остановки генерации.
- **Edge Cases:** БД заблокирована (второй процесс) → `busy_timeout=5000` и ошибка `CacheBusy` пробрасывается наверх; повтор — на стороне вызывающего (без ретраев внутри).
- **Error Handling:** ошибка открытия БД → `CoreError::Cache(...)`, команда возвращает строку с текстом ошибки.
- **Depends On:** Step S3
- **Test:** не применимо (замер).
- **Verify (порог):** повторный показ p95 ≤ 20 мс; запись+чтение 10 000 записей без ошибок; отменённые задачи до инференса ≤ 1 из 50.

---

### Step 1.1 — Каркас `translation_core` + Tauri-команды + ACL

- **File:** `apps/readest-app/src-tauri/src/translation_core/{mod.rs,config.rs,error.rs,engine.rs,commands.rs}`, `apps/readest-app/src-tauri/src/lib.rs`, `apps/readest-app/src-tauri/build.rs`, `apps/readest-app/src-tauri/capabilities/default.json`, `apps/readest-app/src-tauri/Cargo.toml`
- **Action:** CREATE + MODIFY
- **Target:** тип `TranslationCore`, команды, регистрация
- **Signature:**
  ```rust
  pub enum Level { L1, L2, L3 }
  pub struct TranslateItem { pub text: String, pub level: Option<Level>, pub context: Option<String> }
  pub struct TranslateBatchRequest { pub generation: u64, pub items: Vec<TranslateItem>, pub priority: Priority }
  pub struct OfflineSense { pub pos: String, pub glosses: Vec<String> }
  pub struct OfflineItemResult { pub text: String, pub level: String, pub from_cache: bool, pub engine: String, pub ms: u64, pub senses: Option<Vec<OfflineSense>> }
  pub struct TranslateBatchResponse { pub generation: u64, pub results: Vec<OfflineItemResult> }
  pub struct CoreConfig { pub data_dir: PathBuf, pub models_dir: PathBuf, pub src_lang: String, pub dst_lang: String }
  pub struct CoreStatus { pub ready: bool, pub models_dir: String, pub installed: Vec<String>, pub l2: bool, pub l3: bool, pub dictionary: bool }
  pub struct TranslationCore { inner: Arc<CoreInner> }

  #[tauri::command] pub async fn translation_init(app: AppHandle, state: State<'_, TranslationCore>, models_dir: String, data_dir: String) -> Result<CoreStatus, String>;
  #[tauri::command] pub async fn translation_translate(state: State<'_, TranslationCore>, req: TranslateBatchRequest) -> Result<TranslateBatchResponse, String>;
  #[tauri::command] pub fn translation_cancel(state: State<'_, TranslationCore>, generation: u64) -> Result<(), String>;
  #[tauri::command] pub async fn translation_prefetch(state: State<'_, TranslationCore>, req: TranslateBatchRequest) -> Result<u32, String>;
  #[tauri::command] pub async fn translation_models_list(state: State<'_, TranslationCore>) -> Result<Vec<ModelInfo>, String>;
  #[tauri::command] pub async fn translation_model_install(app: AppHandle, state: State<'_, TranslationCore>, model_id: String) -> Result<ModelInfo, String>;
  #[tauri::command] pub async fn translation_model_remove(state: State<'_, TranslationCore>, model_id: String) -> Result<(), String>;
  #[tauri::command] pub async fn translation_cache_stats(state: State<'_, TranslationCore>) -> Result<CacheStats, String>;
  #[tauri::command] pub async fn translation_cache_clear(state: State<'_, TranslationCore>) -> Result<u64, String>;
  ```
- **Logic:**
  1. Создать файлы модуля; `engine.rs` объявляет `pub trait Engine: Send + Sync { fn id(&self) -> &'static str; fn level(&self) -> Level; fn translate(&self, text: &str, ctx: Option<&str>, cancel: &CancelToken) -> Result<EngineOutput, EngineError>; }` и `pub struct EngineOutput { pub text: String, pub senses: Vec<OfflineSense> }`, `pub struct CancelToken(Arc<AtomicBool>)` с `is_cancelled()` и `cancel()`.
  2. `CoreInner { config: RwLock<CoreConfig>, cache: Mutex<Option<CacheDb>>, queue: QueueHandle, engines: RwLock<EngineSet> }`, где `EngineSet { dictionary: Option<Arc<DictionaryEngine>>, marian: Option<Arc<MarianEngine>>, llama: Option<Arc<LlamaEngine>> }`.
  3. `translation_init`: `create_dir_all(models_dir)`, `CacheDb::open(<data_dir>/translations.db)`, `models::scan(&models_dir)` → `installed`; ленивая загрузка движков (dictionary/marian/llama) только если файлы есть; вернуть `CoreStatus`.
  4. `translation_translate`: валидировать `req.items.len() ≤ 64`; вызвать `queue.submit_batch`; `tokio::task::spawn_blocking` вокруг блокирующей работы.
  5. `translation_cancel`: `inner.cancel_generation(generation)`.
  6. Регистрация в `lib.rs`: (a) `mod translation_core;` в блок `mod` (`lib.rs:25-59`, вставить после `mod transfer_file;` строкой 56 → новая строка 57); (b) в `generate_handler!` (`lib.rs:661-727`) добавить 9 строк перед закрывающей `])` на строке 727; (c) в `setup` рядом с `app.manage(...)` (`lib.rs:833-835`) добавить `app.manage(translation_core::TranslationCore::new());`.
  7. `build.rs`: добавить 9 имён в `AppManifest::new().commands(&[...])` (`build.rs:35-87`, перед `])` на строке 88).
  8. `capabilities/default.json`: добавить в `permissions` 9 строк `allow-translation-init`, `allow-translation-translate`, `allow-translation-cancel`, `allow-translation-prefetch`, `allow-translation-models-list`, `allow-translation-model-install`, `allow-translation-model-remove`, `allow-translation-cache-stats`, `allow-translation-cache-clear` (рядом с существующими `allow-parse-epub-metadata`).
  9. `Cargo.toml` deps: версии **не вписывать руками**, добавить командами из `apps/readest-app/src-tauri`:
     `cargo add -p Readest sha2 hex unicode-normalization` и `cargo add -p Readest rusqlite --features bundled`;
     полученные версии фиксируются в `Cargo.lock` и попадают в коммит шага. Добавляемые секции — в `[dependencies]` после `md-5 = "0.10"`.
- **Edge Cases:**
  - `translation_init` вызывается дважды → идемпотентно (повторное открытие БД через `Option`-замену, старый `CacheDb` закрывается).
  - Команда вызвана до `init` (web-платформа, ранний старт) → `Err("translation core is not initialized")`, без паники.
  - `rusqlite` bundled на Android конфликтует с `turso` (чистый Rust, без C-sqlite, `plugins/tauri-plugin-turso/Cargo.toml:20`) → конфликта быть не может; если линковка всё же падает с duplicate symbol — STOP, GAP REPORT (плановый fallback: заменить `rusqlite` на `turso` crate).
- **Error Handling:** все команды возвращают `Result<_, String>`; внутри — `thiserror`-типы конвертируются через `.map_err(|e| e.to_string())`. Паники запрещены.
- **Depends On:** Step 0.3
- **Test:** `apps/readest-app/src-tauri/src/translation_core/tests.rs` (в `#[cfg(test)] mod tests`): `init_is_idempotent`, `translate_before_init_errors`, `cancel_bumps_generation`.
- **Verify:** из `apps/readest-app/src-tauri`: `cargo check -p Readest` → `Finished`; `pnpm --filter @readest/readest-app test:rust` → `test result: ok`; `cargo clippy -p Readest --no-deps -- -D warnings` → 0 warnings; `pnpm --filter @readest/readest-app tauri build --debug` доходит до компиляции Rust без ошибок ACL.

### Step 1.2 — SQLite-кэш по sha256

- **File:** `apps/readest-app/src-tauri/src/translation_core/cache.rs`
- **Action:** CREATE
- **Target:** `CacheDb`
- **Signature:**
  ```rust
  pub struct CacheStats { pub entries: u64, pub bytes: u64, pub hits: u64 }
  pub struct CacheDb { conn: rusqlite::Connection }
  impl CacheDb {
      pub fn open(path: &Path) -> Result<Self, CoreError>;
      pub fn key(level: Level, model_id: &str, src: &str, dst: &str, text: &str) -> String;
      pub fn get(&self, key: &str) -> Result<Option<String>, CoreError>;
      pub fn put(&self, key: &str, level: Level, model_id: &str, src: &str, dst: &str, source_text: &str, target_text: &str) -> Result<(), CoreError>;
      pub fn stats(&self) -> Result<CacheStats, CoreError>;
      pub fn clear(&self) -> Result<u64, CoreError>;
      pub fn prune(&self, max_entries: u64) -> Result<u64, CoreError>;
  }
  ```
- **Logic:**
  1. `open`: `Connection::open(path)`, `pragma_update(None,"journal_mode","WAL")`, `"synchronous","NORMAL"`, `"busy_timeout","5000"`, затем миграция:
     ```sql
     CREATE TABLE IF NOT EXISTS translations (
       key TEXT PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL,
       level TEXT NOT NULL, model_id TEXT NOT NULL,
       source_text TEXT NOT NULL, target_text TEXT NOT NULL,
       created_at INTEGER NOT NULL, hit_count INTEGER NOT NULL DEFAULT 0);
     CREATE INDEX IF NOT EXISTS idx_translations_created ON translations(created_at);
     ```
  2. `key`: `normalize(text) = text.split_whitespace().collect::<Vec<_>>().join(" ")`, затем NFC (`unicode_normalization::UnicodeNormalization::nfc`); строка для хеша — `format!("{level}\u{0}{model_id}\u{0}{src}\u{0}{dst}\u{0}{normalized}")`; результат — `hex::encode(Sha256::digest(bytes))`.
  3. `get`: `SELECT target_text FROM translations WHERE key=?1`; при попадании `UPDATE translations SET hit_count=hit_count+1 WHERE key=?1`.
  4. `put`: `INSERT OR REPLACE`.
  5. `prune(max_entries)`: удалить самые старые `hit_count=0` сверх лимита; вернуть число удалённых.
  6. `stats`: `COUNT(*)`, сумма `length(source_text)+length(target_text)`, сумма `hit_count`.
  7. Периодический `prune(200_000)` вызывается из `translation_translate` после каждой 500-й записи (счётчик в `CoreInner`).
- **Edge Cases:** пустая строка → ключ всё равно считается (`normalize("")=""`), но `put` с пустым `target_text` отклоняется `CoreError::InvalidInput`; текст > 8 КБ → усечение до 8192 символов **до** хеширования (ключ и запись совпадают по усечённому тексту); Unicode-нормализация разных форм даёт один ключ (тест).
- **Error Handling:** `rusqlite::Error` → `CoreError::Cache(e.to_string())`; чтение кэша никогда не фейлит команду — при ошибке логируется `log::warn!` и возвращается `None`.
- **Depends On:** Step 1.1
- **Test:** `cache::tests::{roundtrip, normalization_collapses_whitespace, nfc_key_stable, prune_keeps_hits}`.
- **Verify:** `pnpm --filter @readest/readest-app test:rust` → `4 passed` в модуле `cache::tests`.

### Step 1.3 — Очередь приоритетов + generation-отмена

- **File:** `apps/readest-app/src-tauri/src/translation_core/queue.rs`
- **Action:** CREATE
- **Target:** `QueueHandle`, воркеры L2/L3
- **Signature:**
  ```rust
  #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)] pub enum Priority { Background = 3, Adjacent = 2, CurrentPage = 1, Immediate = 0 }
  struct Job { priority: Priority, seq: u64, generation: u64, item: TranslateItem, reply: tokio::sync::oneshot::Sender<Result<OfflineItemResult, EngineError>> }
  pub struct QueueHandle { tx: std::sync::mpsc::Sender<Job>, generation: Arc<AtomicU64>, cancelled: Arc<Mutex<HashSet<u64>>> }
  impl QueueHandle {
      pub fn new(engines: Arc<RwLock<EngineSet>>, cache: Arc<Mutex<Option<CacheDb>>>) -> Self;
      pub fn submit(&self, priority: Priority, generation: u64, item: TranslateItem) -> oneshot::Receiver<Result<OfflineItemResult, EngineError>>;
      pub fn cancel_generation(&self, generation: u64);
  }
  ```
- **Logic:**
  1. Один поток-диспетчер держит `BinaryHeap<Job>` (порядок: `priority` по возрастанию, затем `seq` по возрастанию) под `Mutex` + `Condvar`.
  2. Два воркера: `worker-l2` (Marian) и `worker-l3` (llama). Диспетчер отдаёт работу воркеру по `Level` задания: L1 обрабатывается синхронно в `submit`-пути вызывающего (словарь, <10 мс).
  3. Перед выдачей задания воркеру диспетчер проверяет: `job.generation < *generation.load()` → задание отбрасывается, `reply` получает `Err(EngineError::Cancelled)`.
  4. `cancel_generation(g)`: `generation.store(g)`, добавить `g` в `cancelled`, разбудить `Condvar`; активный `CancelToken` воркера — это `Arc<AtomicBool>`, который выставляет отдельный `CancelRegistry` (в `CoreInner`) при вызове `cancel`; llama проверяет токен каждые 8 токенов, Marian — на каждом шаге decode.
  5. `submit` возвращает `oneshot::Receiver`; вызывающий (`commands::translation_translate`) собирает все результаты через `futures::future::join_all` и возвращает в порядке входа.
- **Edge Cases:** очередь пуста → `Condvar` ждёт; закрытие канала (`tx` упал) → воркеры завершаются, `submit` возвращает `Err(EngineError::Closed)`; задание пришло с `generation` больше текущей → принимается (это новая генерация, `store` не откатывается назад); одинаковые тексты в батче → дедуп по ключу кэша до постановки в очередь (один инференс, результат копируется всем позициям).
- **Error Handling:** паника внутри движка ловится `std::panic::catch_unwind` в воркере → `EngineError::Panic`, воркер перезапускает цикл (модель перезагружается в следующем задании).
- **Depends On:** Step 1.2
- **Test:** `queue::tests::{priority_order, cancel_drops_queued, dedup_same_text}` — на фейковом движке (`FakeEngine` со `sleep(20ms)`).
- **Verify:** `pnpm --filter @readest/readest-app test:rust` → `3 passed` в `queue::tests`; S5-порог подтверждён (`≤1` инференс после отмены).

### Step 1.4 — `DictionaryEngine` (L1) + сборщик словаря

- **File:** `apps/readest-app/src-tauri/src/translation_core/dictionary.rs`, `tools/dict/build_kaikki_ru.py`
- **Action:** CREATE
- **Target:** `DictionaryEngine`, `build_kaikki_ru.py`
- **Signature:**
  ```rust
  pub struct DictionaryEngine { conn: rusqlite::Connection, max_glosses: usize }
  impl DictionaryEngine {
      pub fn open(db_path: &Path) -> Result<Self, EngineError>;
      pub fn lookup(&self, word: &str, limit: usize) -> Result<Vec<OfflineSense>, EngineError>;
  }
  impl Engine for DictionaryEngine { /* level() = L1, translate() -> EngineOutput { text: joined_glosses, senses } */ }
  ```
  ```python
  # tools/dict/build_kaikki_ru.py
  def main(src_jsonl: Path, out_db: Path) -> None
  ```
- **Logic (Rust):**
  1. `open`: `Connection::open_with_flags(db_path, SQLITE_OPEN_READ_ONLY)`, `pragma_update(None,"query_only","1")`.
  2. `lookup`: (a) точное совпадение `SELECT lemma,pos FROM forms WHERE form=?1 LIMIT 8`; (b) если пусто — `WHERE form=lower(?1)`; (c) собрать `(lemma,pos)` и выбрать `SELECT sense_no, gloss_ru FROM entries WHERE lemma=?1 AND pos=?2 ORDER BY sense_no LIMIT ?3`; (d) вернуть `Vec<OfflineSense>` (по одному элементу на `pos`, `glosses` — до 4 значений).
  3. `translate`: если `senses` пуст — `EngineError::NoEntry`; иначе `text` = склейка `"{pos}: {glosses.join("; ")}"` через `\n`.
- **Logic (Python):**
  1. Читает kaikki JSONL построчно (`json.loads`), берёт записи `lang_code == "en"` и `pos in {"noun","verb","adj","adv","pron","prep","conj","det","num","phrase"}`.
  2. Для каждой записи: `forms` (все `form` из `senses[*].form_of`/`forms[]`) → таблица `forms`; переводы — `senses[*].translations` где `lang_code == "ru"` либо `sense == "ru"`; обрезает до 4 глосс на sense.
  3. Пишет `dict-en-ru.sqlite` с таблицами `forms(form TEXT, lemma TEXT, pos TEXT)` (индекс по `form`), `entries(lemma TEXT, pos TEXT, sense_no INTEGER, gloss_ru TEXT, PRIMARY KEY(lemma,pos,sense_no))`; в конце: `VACUUM`, `PRAGMA optimize`.
  4. Пишет рядом `ATTRIBUTION.txt` с текстом «Wiktionary data via kaikki.org (Wiktextract), CC BY-SA 3.0; generated by tools/dict/build_kaikki_ru.py on <date>» и считает `sha256` файла, дописывая запись в `tools/models/manifest.json` (`id="dict-en-ru"`).
- **Edge Cases:** слово в верхнем регистре в начале предложения → пробуется `lower`; слово с апострофом/дефисом → пробуется как есть, затем `lower`; несколько `pos` для одной леммы → разные элементы `senses`; пустая БД → `EngineError::NoEntry`; отсутствующий файл → `EngineError::ModelMissing("dict-en-ru")`.
- **Error Handling:** ошибка SQL → `EngineError::Backend(e.to_string())`; `NoEntry` не логируется как ошибка (обычный `None` в UI).
- **Depends On:** Step 1.2
- **Test:** Rust `dictionary::tests::{lookup_exact, lookup_lowercase_fallback, lookup_missing_returns_empty, senses_grouped_by_pos}` на фикстурной БД, созданной в тесте (`Connection::open_in_memory` + те же DDL).
- **Verify:** `pnpm --filter @readest/readest-app test:rust` → `4 passed` в `dictionary::tests`; `python3 tools/dict/build_kaikki_ru.py --src /dev/null --out /tmp/dict.sqlite` завершается кодом 0 и создаёт файл размером > 0 (пустой вход — валидный кейс).

### Step 1.5 — `MarianEngine` (L2, ONNX) + сборщик model-pack

- **File:** `apps/readest-app/src-tauri/src/translation_core/marian.rs`, `tools/models/build_opus_pack.py`
- **Action:** CREATE
- **Target:** `MarianEngine`
- **Signature:**
  ```rust
  pub struct MarianEngine { encoder: ort::session::Session, decoder: ort::session::Session, tokenizer: tokenizers::Tokenizer, eos_id: u32, max_len: usize }
  impl MarianEngine { pub fn open(pack_dir: &Path) -> Result<Self, EngineError>; }
  impl Engine for MarianEngine { /* level() = L2 */ }
  ```
- **Logic:**
  1. `open`: читает `config.json` (`eos_token_id`, `max_length` default 256), `tokenizer.json`, `encoder.onnx`, `decoder_merged.onnx`; `Session::builder()?.with_intra_threads(num_cpus().min(4))?.commit_from_file(...)`.
  2. `translate`: `tokenizer.encode(text, true)` → `ids`; encoder run с `input_ids`+`attention_mask`; затем цикл до 256 шагов: decoder run(`input_ids`, `encoder_attention_mask`, `encoder_hidden_states`) → argmax последнего шага; стоп на `eos_id` или `cancel.is_cancelled()`; detokenize (`tokenizer.decode(&out_ids, true)`).
  3. `ort` API: `ort::inputs![ "input_ids" => Tensor::from_array((shape, data))?, ... ]`; имена входов брать из `session.inputs` (в лог при `open`, `log::debug!`).
  4. `build_opus_pack.py`: `huggingface_hub.snapshot_download("SashaSobchuk/opus-mt-onnx-int8", allow_patterns=["*en-ru*"])`, `snapshot_download("Helsinki-NLP/opus-mt-en-ru", allow_patterns=["source.spm","target.spm","vocab.json","config.json"])`, конвертация SP → `tokenizer.json` (`tokenizers.SentencePieceUnigramTokenizer` + `add_special_tokens`), копирование `LICENSE`, расчёт `sha256` каталога (по отсортированному списку файлов: `sha256(name + "\0" + file_sha256)`), запись в `tools/models/manifest.json`.
- **Edge Cases:** вход пустой/пробельный → возвращается исходный текст без инференса; текст > 400 символов → режется по границам предложений (`splitTextIntoChunks`-эквивалент на Rust: `text.char_indices()` + поиск `. ` / `! ` / `? `), результаты склеиваются; отсутствует `decoder_merged.onnx` → `EngineError::ModelMissing`.
- **Error Handling:** ошибки `ort` → `EngineError::Backend(e.to_string())`; OOM-ошибка сессии → движок остаётся `None` в `EngineSet`, `CoreStatus.l2=false`, команды возвращают `EngineError::ModelNotLoaded`.
- **Depends On:** Step 1.3, Step S3
- **Test:** `marian::tests::{pack_missing_errors, empty_text_passthrough}` (реальный инференс не в unit-тесте — он в S3).
- **Verify:** `pnpm --filter @readest/readest-app test:rust` → `2 passed`; `cargo build -p Readest --release` собирается для `aarch64-linux-android` и `x86_64-unknown-linux-gnu` (команда — шаг 0.4 и 0.3).

### Step 1.6 — `LlamaEngine` (L3) на вендоренном llama.cpp

- **File:** `apps/readest-app/src-tauri/src/translation_core/llama.rs`, `llama_ffi.rs`, `apps/readest-app/src-tauri/build.rs`, `apps/readest-app/src-tauri/Cargo.toml`
- **Action:** CREATE + MODIFY
- **Target:** `LlamaEngine`, FFI, сборка C++
- **Signature:**
  ```rust
  pub struct LlamaEngine { model: *mut LlamaModel, vocab: *const LlamaVocab, ctx: *mut LlamaContext, n_ctx: u32 }
  unsafe impl Send for LlamaEngine {}
  unsafe impl Sync for LlamaEngine {}
  impl LlamaEngine { pub fn open(gguf_path: &Path, ctx_size: u32) -> Result<Self, EngineError>; }
  impl Engine for LlamaEngine { /* level() = L3 */ }
  ```
- **Logic:**
  1. `llama_ffi.rs`: `#[repr(C)]` структуры `LlamaModelParams`, `LlamaContextParams`, `LlamaBatch`, `LlamaSampler`; `extern "C"` функции — **скопировать сигнатуры дословно** из `apps/readest-app/src-tauri/vendor/llama.cpp/include/llama.h` (pin `docs/llama-pin.txt`). Перечень нужных: загрузка модели, получение vocab, создание контекста, токенизация, `llama_decode`, цепочка сэмплеров (greedy), `llama_sampler_sample`, `llama_token_to_piece`, освобождение.
  2. `build.rs`: перед вызовом `tauri_build::try_build` добавить блок `#[cfg_attr(target_os = "android", ...)]`, который собирает vendor через `cmake::Config::new("vendor/llama.cpp")` с `-DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF`, `println!("cargo:rustc-link-search=native={}/build/bin", dst.display())`, `println!("cargo:rustc-link-lib=static=llama")`. Признак `rerun-if-changed=vendor/llama.cpp/include/llama.h`.
  3. `open`: `llama_model_default_params()` (mmap=true, n_gpu_layers=0), `llama_model_load_from_file`, `llama_model_get_vocab`, `llama_context_default_params()` (n_ctx = `ctx_size`, n_threads = `num_cpus().min(4)`, n_batch = 512).
  4. `translate`: промпт из `context` (если есть) + `text`, в формате `<|im_start|>system\nTranslate the following English text to Russian. Output translation only.<|im_end|>\n<|im_start|>user\n{text}<|im_end|>\n<|im_start|>assistant\n` (шаблон хранится в `config.json` model-pack, поле `chat_template`; если поле отсутствует — использовать эту строку); токенизация, `llama_decode` батчем, затем цикл до `max_new_tokens = 128` или EOS, проверка `cancel` каждые 8 токенов.
  5. Модель по умолчанию Фазы 1: `hy-mt2-1.8b-q4_k_m.gguf`. Ветка 1.25/2-bit — отдельный шаг 2.3, требует заменить commit подмодуля `vendor/llama.cpp` на ветку с PR #22836 + #19357; код не меняется.
- **Edge Cases:** нет модели → `EngineError::ModelMissing("hy-mt2")`; модель квантована неизвестным типом (`Q2_0C` на upstream-сборке) → `llama_model_load_from_file` вернёт NULL → `EngineError::Backend("unknown quantization type")`, движок остаётся `None`, `CoreStatus.l3=false`; текст > 120 токенов → обрезка до 120 токенов с сохранением последнего предложения; отмена в середине → возврат частичного текста с `EngineError::Cancelled` (не сохраняется в кэш).
- **Error Handling:** все указатели проверяются на NULL сразу после создания; `Drop` освобождает контекст, модель, сэмплер; двойное освобождение невозможно (владение в `LlamaEngine`).
- **Depends On:** Step 1.3, Step S2
- **Test:** `llama::tests::{missing_model_errors, null_load_propagates}` (без реального инференса).
- **Verify:** `cargo build -p Readest --release` (x86_64) → `Finished`; `BIN=$(ls target/release | grep -iE '^readest$|^Readest$' | head -1); ldd "target/release/$BIN" | grep -c libstdc++` → `0`. Если `1` — добавить `println!("cargo:rustc-link-arg=-static-libstdc++")` в `build.rs` и повторить.

### Step 1.7 — Менеджер моделей (скачивание, sha256, удаление)

- **File:** `apps/readest-app/src-tauri/src/translation_core/models.rs`, `tools/models/manifest.json`
- **Action:** CREATE
- **Target:** `ModelInfo`, `scan`, `install`, `remove`, `Progress`
- **Signature:**
  ```rust
  #[derive(Serialize, Clone)] pub struct ModelInfo { pub id: String, pub kind: String, pub size_bytes: u64, pub installed: bool, pub license: String, pub url: String, pub sha256: String }
  #[derive(Serialize, Clone)] pub struct Progress { pub model_id: String, pub downloaded: u64, pub total: u64 }
  pub fn scan(models_dir: &Path) -> Vec<ModelInfo>;
  pub async fn install(app: &AppHandle, models_dir: &Path, model_id: &str) -> Result<ModelInfo, CoreError>;
  pub fn remove(models_dir: &Path, model_id: &str) -> Result<(), CoreError>;
  ```
- **Logic:**
  1. `manifest.json` вшивается в бинарь через `include_str!("../../../../../tools/models/manifest.json")` (путь от `src-tauri/src/translation_core/models.rs` до корня репозитория; проверить сборкой шага 1.1).
  2. `scan`: для каждой записи манифеста — `installed = <models_dir>/<id>` существует и (для файла-gguf) его размер == `size_bytes`; для каталога — маркер `.ok` с sha256.
  3. `install`: `reqwest::Client` → `GET url` с заголовком `Range: bytes=<len>-` при наличии `<models_dir>/.tmp/<id>.part`; поток в файл; `app.emit("translation://download-progress", Progress{...})` каждые 256 КБ; по завершении — `sha256` файла, сравнение; при совпадении `fs::rename` в `<models_dir>/<id>` (для gguf) или распаковка zip в `<models_dir>/<id>/` + запись `<id>/.ok` (для паков); при несовпадении — удалить `.part`, вернуть `CoreError::Checksum(expected, actual)`.
  4. `remove`: удалить каталог/файл и `.ok`.
  5. `Progress` эмитится только для `install`.
- **Edge Cases:** сервер не поддерживает `Range` (ответ 200 вместо 206) → перезаписать `.part` с нуля; обрыв сети → `.part` остаётся, повторный вызов продолжает; диск заполнен → `CoreError::Io`; `model_id` отсутствует в манифесте → `CoreError::UnknownModel`.
- **Error Handling:** ошибки сети → `CoreError::Network(e.to_string())`; после 3 неуспешных попыток подряд — не ретраить (ретрай инициирует UI).
- **Depends On:** Step 1.1, Step 1.4, Step 1.5
- **Test:** `models::tests::{scan_empty_dir, unknown_model_errors, checksum_mismatch_removes_part}` (сеть не используется: `install` тестируется через локальный `file://`-провайдер, `reqwest` с `file://` не работает — поэтому тестируется только `scan`/`remove`/`checksum`-логика на подготовленных файлах).
- **Verify:** `pnpm --filter @readest/readest-app test:rust` → `3 passed`; `translation_models_list` в ручном прогоне возвращает 3 записи (`dict-en-ru`, `opus-mt-en-ru-int8`, `hy-mt2-1.8b-q4_k_m`) с `installed=false`.

### Step 1.8 — TS-провайдер `offlineNmt.ts` + регистрация + дефолты

- **File:** `apps/readest-app/src/services/translators/providers/offlineNmt.ts` (CREATE), `providers/index.ts` (MODIFY), `services/constants.ts` (MODIFY)
- **Action:** CREATE + MODIFY
- **Target:** `offlineNmtProvider`
- **Signature:**
  ```ts
  export const offlineNmtProvider: TranslationProvider;
  // внутри:
  // translate(texts: string[], sourceLang: string, targetLang: string,
  //   token?: string | null, useCache?: boolean, signal?: AbortSignal,
  //   context?: TranslationContext) => Promise<string[]>
  ```
- **Logic:**
  1. Объявить интерфейсы ответа, зеркально Rust: `OfflineSense { pos: string; glosses: string[] }`, `OfflineItemResult { text: string; level: 'L1'|'L2'|'L3'; fromCache: boolean; engine: string; ms: number; senses?: OfflineSense[] }`, `OfflineBatchResponse { generation: number; results: OfflineItemResult[] }`.
  2. Модульная переменная `let generation = 0;` — инкремент на каждый вызов `translate`.
  3. `translate`:
     1. `if (!isTauriAppPlatform()) throw new Error('offline translation requires the desktop or Android app')` (`isTauriAppPlatform` из `@/services/environment`).
     2. `const src = sourceLang === 'AUTO' ? 'en' : normalizeToShortLang(sourceLang)`; `const dst = normalizeToShortLang(targetLang)`.
     3. `if (src !== 'en' || dst !== 'ru') throw new Error(\`offline: unsupported pair ${src}->${dst}\`)`.
     4. `generation += 1; const gen = generation;`
     5. `signal?.addEventListener('abort', () => { void invoke('translation_cancel', { generation: gen }); }, { once: true });`
     6. `const resp = await invoke<OfflineBatchResponse>('translation_translate', { req: { generation: gen, priority: 'CurrentPage', items: texts.map((text) => ({ text, level: null, context: context?.bookTitle ?? null })) } });`
     7. Кэшировать последнюю «богатую» выдачу в модульную переменную `lastResults` (для `TranslatorPopup`, см. шаг 1.9) и вернуть `resp.results.map((r) => r.text)`.
  4. Поля провайдера: `name: 'offline'`, `label: stubTranslation('Offline (on-device)')`, `authRequired: false`, `requiresApp: true`, `concurrency: 1`, `getCacheKey: () => 'offline'`.
  5. `providers/index.ts`: `import { offlineNmtProvider } from './offlineNmt';`, `const offlineTranslator = createTranslator('offline', offlineNmtProvider);`, добавить `offlineTranslator` в `availableTranslators` (`:26-32`) **первым** элементом.
  6. `services/constants.ts`: `DEFAULT_READSETTINGS.translationProvider: 'deepl'` → `'offline'` (`:331`) и `DEFAULT_TRANSLATOR_CONFIG.translationProvider: 'deepl'` → `'offline'` (`:544`).
- **Edge Cases:** `texts` пустой массив → вернуть `[]` без IPC; строка из одних пробелов → вернуть её как есть (провайдер не вызывает ядро); `invoke` отклонён (`translation core is not initialized`) → пробросить ошибку наверх, попап покажет текст; `signal` уже aborted до вызова → сразу `translation_cancel`, затем всё равно выполнить вызов и вернуть результат (отмена влияет только на очередь).
- **Error Handling:** любое исключение IPC → `throw new Error(\`offline: ${message}\`)`; никаких `console.error` вместо выброса.
- **Depends On:** Step 1.1
- **Test:** `src/__tests__/services/translators/offlineNmt.test.ts` — 5 кейсов с `vi.mock('@tauri-apps/api/core')`: `maps_batch_results`, `rejects_unsupported_pair`, `empty_input_no_ipc`, `whitespace_passthrough`, `abort_calls_cancel`.
- **Verify:** `pnpm --filter @readest/readest-app exec dotenv -e .env -- vitest run src/__tests__/services/translators/offlineNmt.test.ts` → `5 passed`; `pnpm --filter @readest/readest-app exec tsc --noEmit` → exit 0.

### Step 1.9 — Словарная карточка в `TranslatorPopup`

- **File:** `apps/readest-app/src/app/reader/components/annotator/TranslatorPopup.tsx`, `apps/readest-app/src/services/translators/providers/offlineNmt.ts`
- **Action:** MODIFY
- **Target:** компонент `TranslatorPopup`, экспорт `getLastOfflineResults`
- **Signature:** `export const getLastOfflineResults = (): OfflineItemResult[];` (в `offlineNmt.ts`); в `TranslatorPopup` — новый локальный стейт `const [senses, setSenses] = useState<OfflineSense[] | null>(null);`
- **Logic:**
  1. В `offlineNmt.ts` добавить `let lastResults: OfflineItemResult[] = [];` (уже есть по шагу 1.8), экспортировать геттер.
  2. В `TranslatorPopup`, в колбэке, который вызывает `translate(...)` (найти существующий вызов внутри компонента; он получает массив текстов — вход один `text`), после успешного перевода: если `name === 'offline'`, взять `getLastOfflineResults()[0]?.senses ?? null` и `setSenses(...)`.
  3. Рендер: перед блоком с переводом, если `senses` не `null` и длина > 0 — `<ul className='mb-2 space-y-1 text-sm'>` с `senses.map((s) => <li key={s.pos}><span className='opacity-60'>{s.pos}</span> {s.glosses.join('; ')}</li>)`.
  4. Строки-подписи не добавлять (позиции частей речи приходят из данных, локализация не требуется для MVP).
- **Edge Cases:** `senses` есть, а `translation` пустой → карточка показывается, основной блок перевода скрыт условием `translation &&`; повторное открытие попапа на другом слове → `setSenses(null)` в начале загрузки; провайдер не `offline` → `senses` всегда `null`.
- **Error Handling:** ошибка чтения геттера невозможна (массив в модуле); при пустом массиве — `null`.
- **Depends On:** Step 1.8
- **Test:** `src/__tests__/app/reader/annotator/TranslatorPopup.test.tsx` (существующий файл — дополнить одним кейсом `renders_senses_for_offline_provider`): мок `useTranslator` возвращает `translator={ name: 'offline' }`, мок геттера — `[{ pos: 'noun', glosses: ['дом', 'здание'] }]`; ассерт `screen.getByText('дом; здание')`.
- **Verify:** `pnpm --filter @readest/readest-app exec dotenv -e .env -- vitest run src/__tests__/app/reader/annotator/TranslatorPopup.test.tsx` → все тесты файла passed.

### Step 1.10 — Секция менеджера моделей в настройках

- **File:** `apps/readest-app/src/components/settings/OfflineModelsSection.tsx` (CREATE), `apps/readest-app/src/components/settings/LangPanel.tsx` (MODIFY)
- **Action:** CREATE + MODIFY
- **Target:** `OfflineModelsSection`
- **Signature:** `const OfflineModelsSection: React.FC<{ envConfig: EnvConfigType }>`; внутри — `useEffect` с `invoke<ModelInfo[]>('translation_models_list')` и подписка `listen<Progress>('translation://download-progress', handler)`.
- **Logic:**
  1. При монтировании: `const modelsDir = await appService.resolveFilePath('models', 'Data'); const dataDir = await appService.resolveFilePath('', 'Data'); await invoke('translation_init', { modelsDir, dataDir });`
  2. `models.map(...)` → `SettingsRow` (примитив из `src/components/settings/primitives/`) с названием, размером (`(size_bytes/1048576).toFixed(0) MB`), лицензией, кнопкой `Install`/`Remove`/прогресс-баром.
  3. `Install` → `invoke('translation_model_install', { modelId: m.id })`; прогресс из события обновляет локальный `Record<string, number>`.
  4. `Remove` → `invoke('translation_model_remove', { modelId: m.id })`, затем повторный `translation_models_list`.
  5. Вставить `<OfflineModelsSection envConfig={envConfig} />` в `LangPanel` под блоком выбора провайдера перевода (в JSX, после элемента с `data-setting-id='settings.language.translationProvider'`, `LangPanel.tsx:503`).
  6. Все подписи — через `_()`.
- **Edge Cases:** не-tauri платформа (`isTauriAppPlatform()` false) → секция рендерит одну строку `_('Available in the app only')` и не вызывает `invoke`; ошибка `invoke` → строка ошибки в секции, кнопки остаются активны; отписка от `listen` в `useEffect` cleanup (вернуть `unlisten`).
- **Error Handling:** `try/catch` вокруг каждого `invoke`; ошибка отображается текстом, не выбрасывается.
- **Depends On:** Step 1.7
- **Test:** `src/__tests__/components/OfflineModelsSection.test.tsx` — 3 кейса: `renders_models`, `install_calls_invoke`, `hides_on_web` (мок `isTauriAppPlatform`).
- **Verify:** `pnpm --filter @readest/readest-app exec dotenv -e .env -- vitest run src/__tests__/components/OfflineModelsSection.test.tsx` → `3 passed`; `pnpm --filter @readest/readest-app lint` → 0 ошибок.

---

### Step 2.1 — Sentence index в форке foliate-js

- **File:** `packages/foliate-js/sentence-index.js` (CREATE, в нашем форке foliate-js), `apps/readest-app/src/app/reader/utils/sentenceIndex.ts` (CREATE), `apps/readest-app/src/app/reader/utils/caretPoint.ts` (CREATE)
- **Action:** CREATE
- **Target:** `buildSentenceIndex`, `sentenceAtOffset`, `rangeForSentence`, `caretRangeAtPoint`
- **Signature:**
  ```js
  // packages/foliate-js/sentence-index.js
  export const BLOCK_TAGS = new Set([...]);
  export const buildSentenceIndex = (doc, { language = 'en', minSegmentChars = 12 } = {}) => ({
    text,            // string, конкатенация текстовых узлов с '\n' на границах блоков
    nodes,           // Array<{ node: Text|null, start: number, end: number }>
    sentences,       // Array<{ start: number, end: number, text: string }>
    index:           // SortedArray по start
  });
  export const sentenceAtOffset = (built, offset) => number | -1;
  export const rangeForSentence = (doc, built, sentenceIdx) => Range | null;
  export const lineBoxesForRange = (range) => Array<{ left, top, right, bottom }>;
  ```
  ```ts
  // apps/readest-app/src/app/reader/utils/sentenceIndex.ts
  import { buildSentenceIndex, sentenceAtOffset, rangeForSentence, lineBoxesForRange } from 'foliate-js/sentence-index.js';
  export interface BuiltSentenceIndex { text: string; nodes: { node: Text | null; start: number; end: number }[]; sentences: { start: number; end: number; text: string }[] }
  export const getSentenceIndex = (doc: Document, language: string) => BuiltSentenceIndex;  // WeakMap-кэш
  export const sentenceAtPoint = (doc: Document, node: Node, offset: number, language: string) => { idx: number; range: Range; boxes: DOMRect[] } | null;
  export const offsetOf = (doc: Document, node: Node, offset: number) => number;
  ```
- **Logic (foliate-js):**
  1. `TreeWalker(doc.body, NodeFilter.SHOW_TEXT)`; `acceptNode`: `FILTER_REJECT` для предков `script, style, rt, rp, head, [cfi-inert], [data-foliate-chunk]` (пустые плейсхолдеры чанков из `section-chunks.js:13`), а также для узлов с `closest('[data-br-overlay]')`.
  2. Для каждого принятого узла: `start = acc.length`, `acc += node.data`, `end = acc.length`, пушим `{node, start, end}`.
  3. Между блоками: при переходе от узла к следующему — если ближайший общий предок изменился и `closestBlock(prev) !== closestBlock(next)` по `BLOCK_TAGS`, добавить `'\n'` в `acc` и запись `{node: null, start, end: start+1}`. `BLOCK_TAGS = ['p','div','br','li','h1'..'h6','blockquote','td','th','tr','pre','figure','figcaption','section','article','header','footer','aside','hr','table']`.
  4. Сегментация: `new Intl.Segmenter(language, { granularity: 'sentence' })` по `acc`; для каждого сегмента — `{start: seg.index, end: seg.index + seg.segment.length, text: seg.segment.trim()}`.
  5. Пост-обработка (в этом порядке):
     a. Склейка, если `text.length < minSegmentChars` и есть следующий сегмент.
     b. Склейка, если `text` оканчивается на `/(\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|т\.\s?е|т\.\s?д|г|гг|ул|д|стр|рис|табл|см)\.)$/i`.
     c. Склейка, если следующий сегмент начинается со строчной буквы (`/^[a-zа-яё]/`) и текущий не оканчивается на `[.!?…]["»”']?`.
     d. Склейка через `\n` (сегмент-переход) — если сегмент состоит только из пробелов/`\n`, присоединить к предыдущему.
  6. `sentenceAtOffset`: бинарный поиск по `sentences` (последний элемент с `start <= offset`), вернуть его индекс; `offset` вне текста → `-1`.
  7. `rangeForSentence`: найти узлы, пересекающие `[start,end)`; для частичного попадания — `detachNode`/`startOffset`; вернуть `Range`.
  8. `lineBoxesForRange`: `Array.from(range.getClientRects())`, отфильтровать `width>0 && height>0`, сгруппировать по `top` с допуском 2 px, вернуть по одному прямоугольнику на группу (`left = min`, `right = max`).
- **Logic (TS):** `getSentenceIndex` кэширует в `WeakMap<Document, {built, language}>`; при `language` не равном сохранённому — перестроить. `offsetOf` — бинарный поиск по `built.nodes` (найти узел с `start <= globalOffset <= end`, вернуть `start + (offset - start)`).
- **Edge Cases:** документ без текста → `sentences: []`, `sentenceAtOffset` → `-1`; узел длиной 0 → пропускается; `Intl.Segmenter` отсутствует (WebView < 87) → fallback-регекс `/[^.!?…]+[.!?…]+["»”']?|[^.!?…]+$/g` и `console.warn` один раз; `range.setStart` вне текстового узла → `null`; чанк-документ (`data-foliate-chunk`) не индексируется как текст; RTL (арабский) → индекс строится (offset-модель не зависит от направления).
- **Error Handling:** любое исключение в `buildSentenceIndex` ловится вызывающим (`sentenceAtPoint` возвращает `null`); сам модуль не глотает ошибки.
- **Depends On:** Step S4, Step 0.1 (форк foliate-js)
- **Test:** `src/__tests__/app/reader/utils/sentenceIndex.test.ts` — 8 кейсов из S4 + `chunk_placeholders_skipped`, `block_boundary_inserts_newline`, `segmenter_fallback_regex`.
- **Verify:** `pnpm --filter @readest/readest-app exec dotenv -e .env -- vitest run src/__tests__/app/reader/utils/sentenceIndex.test.ts` → `11 passed`; `pnpm --filter @readest/readest-app exec tsc --noEmit` → exit 0; `git -C packages/foliate-js status --porcelain` → только `?? sentence-index.js` (существующие файлы не тронуты).

### Step 2.2 — Режим «линейка»: long-press + drag

- **File:** `apps/readest-app/src/app/reader/components/SentenceRuler.tsx` (CREATE), `apps/readest-app/src/app/reader/components/BooksGrid.tsx` (MODIFY), `apps/readest-app/src/types/book.ts` (MODIFY), `apps/readest-app/src/services/constants.ts` (MODIFY)
- **Action:** CREATE + MODIFY
- **Target:** компонент `SentenceRuler`, поля `ViewSettings`
- **Signature:**
  ```tsx
  const SentenceRuler: React.FC<{
    bookKey: string;
    isVertical: boolean;
    rtl: boolean;
    bookFormat: BookFormat;
    viewSettings: ViewSettings;
    gridInsets: Insets;
  }>;
  ```
  ```ts
  // types/book.ts, после строки 433 (readingRulerColor)
  sentenceRulerEnabled: boolean;
  sentenceRulerHoldMs: number;
  offlineL3Enabled: boolean;
  ```
  ```ts
  // services/constants.ts, DEFAULT_VIEW_CONFIG после строки 524
  sentenceRulerEnabled: false,
  sentenceRulerHoldMs: 400,
  offlineL3Enabled: false,
  ```
- **Logic:**
  1. Рендер: `null`, если `!viewSettings.sentenceRulerEnabled`. Иначе корневой `<div className='pointer-events-none absolute inset-0 z-40' data-br-overlay='1'>` с (a) слоем подсветки — по одному `<div>` на line box; (b) `Popup` (`src/components/Popup.tsx`, props `width/height/position/trianglePosition/isOpen`) с результатом.
  2. Подписки: `useEffect` навешивает на `document` (host) `pointerdown`/`pointermove`/`pointerup`/`pointercancel` в **capture** (`{ capture: true, passive: false }`); при `!enabled` эффект ничего не навешивает.
  3. `pointerdown`: если `event.pointerType === 'mouse'` — не engage (только touch/pen); запомнить `{x, y, pointerId, docIndex}`; запустить `setTimeout(holdMs)`; `preventDefault` **не вызывать**.
  4. `pointermove` до engage: если `Math.hypot(dx,dy) > 8` → `clearTimeout`, выйти (это свайп/перелистывание).
  5. По таймеру (`holdMs = viewSettings.sentenceRulerHoldMs`): найти документ через `view.renderer.getContents()` (проверка попадания точки в `doc.defaultView.frameElement.getBoundingClientRect()`, как `ReadingRuler.tsx:64-95`), затем `caretRangeAtPoint([doc], x, y)` из `utils/caretPoint.ts`; `offsetOf(doc, node, offset)` → `sentenceAtPoint` → `{idx, range, boxes}`.
  6. Engage: `containerEl.setPointerCapture(pointerId)`, `doc.documentElement.style.userSelect='none'` (сохранить прежнее значение), обновить слой подсветки (по одному `div` на `lineBoxesForRange`, `left/width` по колонке: `right` расширяется до правого края колонки, который берётся из `gridInsets`/`columnCount`, как `buildReadingRulerColumns` в `utils/readingRuler.ts:134-168`), открыть `Popup` над первым прямоугольником (`trianglePosition.dir='down'` если сверху места нет).
  7. Запрос перевода: `generationRef.current += 1`, `invoke('translation_translate', { req: { generation, priority: 'Immediate', items: [{ text: sentenceText, level: null, context: null }] } })`, префетч ±1 предложения — `invoke('translation_prefetch', { req: { generation, priority: 'Adjacent', items: [prev, next] } })`.
  8. `pointermove` после engage: если `|dy| > 0.8 * lineHeight` (`lineHeight` = `viewSettings.lineHeight * viewSettings.defaultFontSize`) → debounce 120 мс → пересчёт предложения в новой точке → новый `generation`, новый запрос.
  9. Выход за пределы видимого документа: если точка вне `contentRect` по вертикали и `renderer.atEnd/atStart` позволяют — `await view.renderer.next()`/`prev()`, затем пересчёт индекса для нового документа и повторный запрос.
  10. `pointerup`/`pointercancel`: вернуть `userSelect`, снять capture, `clearTimeout`, оставить попап открытым; клик вне попапа (`pointerdown` вне `Popup`) — закрыть и очистить подсветку.
  11. Монтирование в `BooksGrid.tsx`: сразу после блока `{viewSettings.readingRulerEnabled && viewState?.inited && (<ReadingRuler …/>)}` (строки 306-320) добавить `{viewSettings.sentenceRulerEnabled && viewState?.inited && (<SentenceRuler bookKey={bookKey} isVertical={viewSettings.vertical} rtl={viewSettings.rtl} bookFormat={book.format} viewSettings={viewSettings} gridInsets={gridInsets} />)}`.
  12. Конфликт с instant annotation: в UI-переключателе (секция настроек `ReadingRulerSettings` **не трогаем**; переключатель добавляется в `OfflineModelsSection` шага 1.10 отдельной строкой `Sentence ruler`) при включении вызывать `saveViewSettings(envConfig, bookKey, 'enableAnnotationQuickActions', false, false, false)`; при этом если `viewSettings.annotationQuickAction === 'highlight'` — сначала выставить `'translate'`.
- **Edge Cases:** `caretRangeAtPoint` вернул `null` (картинка/поле) → попап не открывается, подсветка не рисуется, таймер снимается; предложение не найдено (`-1`) → ничего не происходит; `selection` уже активна на момент engage → вызвать `doc.getSelection()?.removeAllRanges()` и `view.deselect()`; fixed-layout книга (`FIXED_LAYOUT_FORMATS`) → компонент рендерит `null` (offset-модель на PDF/фиксе не работает); попап не влезает сверху → `trianglePosition.dir='up'`; быстрый второй long-press → предыдущий `generation` отменяется, новый запрос стартует после `pointerup`.
- **Error Handling:** `invoke` отклонён → в попапе текст ошибки `offline: …`, подсветка остаётся; исключение в обработчике указателя — `try/catch` с `console.warn`, жест сбрасывается.
- **Depends On:** Step 2.1, Step 1.8
- **Test:** `src/__tests__/app/reader/utils/sentenceIndex.test.ts` (покрывает 2.1); для компонента — `src/__tests__/components/SentenceRuler.test.tsx`: `renders_null_when_disabled`, `long_press_engages_after_hold`, `move_before_hold_cancels`. Моки: `useReaderStore`/`useBookDataStore` по образцу существующих тестов.
- **Verify:** `pnpm --filter @readest/readest-app exec dotenv -e .env -- vitest run src/__tests__/components/SentenceRuler.test.tsx` → `3 passed`; ручной прогон на устройстве: точность ≥ 90% из S4 сохранена, нативное меню выделения не появляется (`userSelect:'none'`).

---

### Step 3.1 — AGPL-артефакты: `NOTICE`, `docs/PROVENANCE.md`, license-поля

- **File:** `NOTICE` (CREATE), `docs/PROVENANCE.md` (CREATE), `apps/readest-app/src-tauri/Cargo.toml` (MODIFY), `docs/offline-translation.md` (CREATE)
- **Action:** CREATE + MODIFY
- **Target:** юридические файлы форка
- **Signature:** не применимо
- **Logic:**
  1. Создать `NOTICE` с текстом из §8.1 п.2, подставив `<owner>` из `docs/fork.txt` и `<sha>` = `git rev-parse upstream/main`.
  2. Создать `docs/PROVENANCE.md` — таблица из §8.1 п.3 (ровно 8 строк компонентов).
  3. В `apps/readest-app/src-tauri/Cargo.toml` строку 6 (`license = ""`) заменить на `license = "AGPL-3.0-or-later"`.
  4. Создать `docs/offline-translation.md`: путь к `Data/models`, формат `manifest.json`, команды `tools/dict/build_kaikki_ru.py` и `tools/models/build_opus_pack.py`, лимиты (текст ≤ 8 КБ на запись кэша, батч ≤ 64 элемента, L3 ≤ 120 токенов), пары языков (только en→ru).
  5. `LICENSE` не трогать: проверить `head -1 LICENSE` = `                    GNU AFFERO GENERAL PUBLIC LICENSE`.
- **Edge Cases:** `NOTICE` уже существует (upstream добавит) → дописать наш блок в конец файла, не заменять; `Cargo.toml` изменился у upstream (строка 6 сместилась) → искать по regex `^license = ""` и заменять единственное совпадение.
- **Error Handling:** если `LICENSE` не AGPL-3.0 → STOP (база не та).
- **Depends On:** Step 0.1
- **Test:** не применимо.
- **Verify:** `grep -c 'AGPL' NOTICE` → `≥ 2`; `grep -n 'license = "AGPL-3.0-or-later"' apps/readest-app/src-tauri/Cargo.toml` → 1 совпадение; `test -f docs/PROVENANCE.md && test -f docs/offline-translation.md` → exit 0.

### Step 3.2 — Регламент upstream-синхронизации

- **File:** `docs/upstream-sync.md` (CREATE)
- **Action:** CREATE
- **Target:** playbook §8.2 в виде файла
- **Signature:** не применимо
- **Logic:** перенести §8.2 (пункты 1–8) в файл; добавить в конец два готовых скрипта-фрагмента: merge-каденс (`git fetch upstream && git merge upstream/main`) и проверку границ (`git diff --stat upstream/main | grep -cE 'paginator|view\.js|useTextSelector'` → `0`).
- **Edge Cases:** не применимо.
- **Error Handling:** не применимо.
- **Depends On:** Step 3.1
- **Test:** не применимо.
- **Verify:** `grep -c 'Tier 2' docs/upstream-sync.md` → `≥ 1`; `grep -c 'paginator' docs/upstream-sync.md` → `≥ 1`.

---

## 5. Test Plan

### 5.1 Unit (Rust) — `pnpm --filter @readest/readest-app test:rust`
| Модуль | Тесты |
|---|---|
| `translation_core::tests` | `init_is_idempotent`, `translate_before_init_errors`, `cancel_bumps_generation` |
| `translation_core::cache` | `roundtrip`, `normalization_collapses_whitespace`, `nfc_key_stable`, `prune_keeps_hits` |
| `translation_core::queue` | `priority_order`, `cancel_drops_queued`, `dedup_same_text` |
| `translation_core::dictionary` | `lookup_exact`, `lookup_lowercase_fallback`, `lookup_missing_returns_empty`, `senses_grouped_by_pos` |
| `translation_core::marian` | `pack_missing_errors`, `empty_text_passthrough` |
| `translation_core::llama` | `missing_model_errors`, `null_load_propagates` |
| `translation_core::models` | `scan_empty_dir`, `unknown_model_errors`, `checksum_mismatch_removes_part` |

### 5.2 Unit (TS) — `pnpm --filter @readest/readest-app test`
| Файл | Кейсы |
|---|---|
| `src/__tests__/services/translators/offlineNmt.test.ts` | 5 |
| `src/__tests__/app/reader/utils/sentenceIndex.test.ts` | 11 |
| `src/__tests__/components/OfflineModelsSection.test.tsx` | 3 |
| `src/__tests__/components/SentenceRuler.test.tsx` | 3 |
| `src/__tests__/app/reader/annotator/TranslatorPopup.test.tsx` | существующие + `renders_senses_for_offline_provider` |

### 5.3 Integration (ручная приёмка, фиксируется в `docs/baseline.md`)
1. Linux: EPUB + FB2 → выделение слова → карточка L1 ≤ 200 мс.
2. Linux: выделение предложения → перевод L2; повтор ≤ 20 мс.
3. Android (≥4 ГБ RAM): то же; L3 включается флагом `offlineL3Enabled` и даёт ≤ 3 с на 24 токена.
4. Режим «линейка»: 20 точек × 3 книги, точность ≥ 90%, нативное меню выделения не появляется.
5. Отмена: быстро вести палец по строкам → в логах ≤ 1 инференс на «покоящееся» предложение.
6. Менеджер моделей: установка `opus-mt-en-ru-int8` с прогрессом, отключение сети на середине, повтор — докачка с того же байта.

### 5.4 Edge cases → шаги
`normalize`-ключ (1.2), пустой вход провайдера (1.8), неизвестный квант (1.6), chunk-плейсхолдеры (2.1), fixed-layout (2.2), instant-annotation конфликт (2.2), докачка модели (1.7).

---

## 6. Verification (полный прогон после всех шагов)

```bash
# 1. Типы и линт
pnpm --filter @readest/readest-app lint                     # ожидается: 0 errors
# 2. Rust
(cd apps/readest-app/src-tauri && cargo clippy -p Readest --no-deps -- -D warnings)   # либо pnpm --filter @readest/readest-app clippy:check; ожидается: Finished, 0 warnings
pnpm --filter @readest/readest-app test:rust                # ожидается: test result: ok, все тесты translation_core passed (21), 0 failed
# 3. TS-тесты (по файлам плана)
pnpm --filter @readest/readest-app exec dotenv -e .env -- vitest run \
  src/__tests__/services/translators/offlineNmt.test.ts \
  src/__tests__/app/reader/utils/sentenceIndex.test.ts \
  src/__tests__/components/OfflineModelsSection.test.tsx \
  src/__tests__/components/SentenceRuler.test.tsx \
  src/__tests__/app/reader/annotator/TranslatorPopup.test.tsx   # ожидается: 0 failed
# 4. Сборка Linux (CEF)
pnpm --filter @readest/readest-app tauri build              # ожидается: Finished `release` profile, бандл в target/release/bundle
# 5. Сборка Android
(cd apps/readest-app && pnpm tauri android build -t aarch64) # ожидается: BUILD SUCCESSFUL, APK в gen/android/app/build/outputs/apk
# 6. Границы вмешательства
git diff --stat upstream/main | grep -E 'paginator\.js|view\.js|useTextSelector\.ts|readingRuler' | wc -l   # ожидается: 0
```

Регрессия: `git diff --stat upstream/main` — только файлы Tier 1/2 из §3.

---

## 7. Rollback

| Шаг | Откат |
|---|---|
| 0.1 | `rm -rf .git` + удалить `docs/fork.txt` (рабочее дерево восстанавливается повторным клонированием) |
| 1.1–1.7 | `git revert <commit шага>` — модуль `translation_core` изолирован; при откате 1.1 снимаются записи в `lib.rs`/`build.rs`/capabilities тем же revert |
| 1.8–1.10 | `git revert` — единственная точка входа в upstream-коде: `providers/index.ts` (3 строки) и `constants.ts` (2 значения) |
| 2.1 | `git -C packages/foliate-js revert <commit>` + удаление `sentence-index.js`; `git submodule update` возвращает пин |
| 2.2 | revert `BooksGrid.tsx` (12 строк) + удаление `SentenceRuler.tsx`; 3 новых поля `ViewSettings` остаются и безвредны (флаг `false`) |
| Полный | `git reset --hard upstream/main && git submodule update --init --recursive` (наши коммиты остаются в `bilireader/main`) |

---

## 8. Лицензионная гигиена AGPL-3.0 (отдельный блок)

### 8.1 Что обязаны сделать (Step 3.1)
1. **Сохранить `LICENSE`** без изменений (AGPL-3.0, файл в корне). Никогда не заменять на MIT/Apache.
2. **`NOTICE`** (CREATE, корень):
   ```
   BiliReader
   This product is a modified version of Readest (https://github.com/readest/readest),
   Copyright (C) Bilingify LLC, licensed under the GNU Affero General Public License v3.0.
   Modifications Copyright (C) 2026 <владелец форка>, licensed under AGPL-3.0.
   Modifications begin 2026-11-03. Source: https://github.com/<owner>/readest
   ```
3. **`docs/PROVENANCE.md`** (CREATE): таблица «компонент → лицензия → где взят»:
   | Компонент | Лицензия | Источник |
   |---|---|---|
   | Readest (база) | AGPL-3.0 | `readest/readest@<sha из docs/fork.txt>` |
   | foliate-js (наш форк) | MIT | `readest/foliate-js@0c7a0ed` + `sentence-index.js` (наш, AGPL-3.0) |
   | tauri, плагины | Apache-2.0/MIT | crates.io |
   | llama.cpp | MIT | `vendor/llama.cpp@<docs/llama-pin.txt>` |
   | Hy-MT2-1.8B GGUF | Apache-2.0 | `tencent/Hy-MT2-1.8B-GGUF` |
   | OPUS-MT en-ru | CC-BY-4.0 (атрибуция) | `Helsinki-NLP/opus-mt-en-ru`, `SashaSobchuk/opus-mt-onnx-int8` |
   | kaikki/Wiktionary данные | CC-BY-SA 3.0 | `kaikki.org`, скрипт `tools/dict/build_kaikki_ru.py` |
   | turso, rusqlite, ort, tokenizers | MIT/Apache-2.0 | crates.io |
4. **Публикация исходников**: репозиторий форка публичный с первого коммита; каждый релизный тег содержит полный исходник + `NOTICE`. Для сетевого использования (если появится web-версия) — пункт «Source code» в UI со ссылкой на тег.
5. **Файлы моделей**: `ATTRIBUTION.txt` внутри каждого model-pack (генерируется `tools/models/build_opus_pack.py` и `tools/dict/build_kaikki_ru.py`). Для kaikki — обязательная ссылка на CC-BY-SA и указание, что производная БД распространяется под CC-BY-SA (не под AGPL): `dict-en-ru.sqlite` — отдельный артефакт данных.
6. **`apps/readest-app/src-tauri/Cargo.toml:6`** сейчас содержит `license = ""` → заменить на `license = "AGPL-3.0-or-later"`.
7. **Запрет**: не добавлять код из проектов без лицензии (FBReader, Legado, Librera) и из Hy-MT1.5 (Tencent HY Community License, исключает EU/UK/KR).

### 8.2 Стратегия rebase/merge на upstream (Step 3.2 → `docs/upstream-sync.md`)
1. **Модель ветвления:** `main` = зеркало `upstream/main` (только fast-forward); `bilireader/main` = наша ветка (merge-коммиты upstream → bilireader). Rebase **не используется** для главной ветки: опубликованная история AGPL-совместима и не переписывается.
2. **Каденс:** раз в 2 недели `git fetch upstream && git checkout bilireader/main && git merge upstream/main`. Merge-конфликты только в Tier 2.
3. **Файлы, которые мы трогаем (Tier 2, 11 файлов):** `src-tauri/{Cargo.toml,src/lib.rs,build.rs,capabilities/default.json}`, `src/services/translators/providers/index.ts`, `src/services/constants.ts`, `src/types/book.ts`, `src/app/reader/components/BooksGrid.tsx`, `src/app/reader/components/annotator/TranslatorPopup.tsx`, `src/components/settings/LangPanel.tsx`, `.gitmodules`. Все правки — **аддитивные** (новые строки/элементы массивов).
4. **Файлы, которые мы не трогаем (Tier 3):** §3. Любой diff в них при merge → отклонить нашу сторону и разбираться отдельно (это признак случайной правки).
5. **Плейбук конфликта:** (a) `git checkout --theirs` — взять upstream-версию файла; (b) вручную вернуть наши аддитивные блоки из `git show <наш прошлый merge>:<file>`; (c) прогнать `pnpm lint` + `test:rust`; (d) коммит `merge: upstream <date>`. Запрещено «разруливать» конфликт в `paginator.js`/`view.js` — таких правок у нас нет.
6. **Субмодули:** `packages/foliate-js` указывает на наш форк. При каждом upstream-мерже, если upstream поднял пин foliate-js — ребейзить нашу ветку форка: `git -C packages/foliate-js fetch upstream`, `git -C packages/foliate-js rebase upstream/main`, force-push в наш форк, обновить пин в родителе. Наш вклад в форк — ровно один новый файл `sentence-index.js`, конфликтов не даёт.
7. **llama.cpp:** подмодуль `vendor/llama.cpp` — наш, upstream его не знает. Обновление = смена pin + `docs/llama-pin.txt` + повторный прогон S2.
8. **Проверка «мы не разъехались»:** в конце каждого merge — `git diff --stat upstream/main | grep -cE 'paginator|view\.js|useTextSelector'` → `0`.

---

## 9. Риски и открытые вопросы

| # | Риск | Влияние | Митигация в плане |
|---|---|---|---|
| R1 | `ort` не даёт prebuilt для Android arm64 | Блокер L2 на Android | S3 фиксирует `ort_android=prebuilt|source`; fallback — сборка ORT из исходников с `load-dynamic` |
| R2 | Linux-сборка требует CEF (`tauri-runtime-cef`) и Rust ≥1.95 | Блокер baseline | Step 0.2/0.3 с точными версиями; webdriver/WebKit путь не используем |
| R3 | `rusqlite bundled` конфликт линковки с `turso` | Блокер сборки | `turso` — чистый Rust (`apps/readest-app/src-tauri/plugins/tauri-plugin-turso/Cargo.toml:20-21`), C-sqlite в графе отсутствует; fallback — заменить кэш на `turso` crate |
| R4 | Q2_0C/STQ GGUF не грузится на upstream llama.cpp | L3-дефолт отличается от PROPOSAL | Дефолт Фазы 1 — Q4_K_M 1.13 ГБ; 2-bit вынесен в шаг 2.3 с двумя пинами PR |
| R5 | Конфликт long-press с instant annotation | UX-регресс | Гейт по `useInstantAnnotation.ts:62-68`, выключение при включении линейки |
| R6 | Rebase-долг: 11 файлов Tier 2 | Замедление обновлений | Аддитивные правки, плейбук §8.2, `main` зеркалит upstream |
| R7 | Kaikki CC-BY-SA на производную БД | Юридический | Отдельный data-артефакт + атрибуция (§8.1 п.5) |
| R8 | Android убивает процесс с моделью | L3 «холодный» | Префетч + удержание контекста; Foreground Service — Фаза 2 |

Открытые вопросы (не блокируют Фазу 1): (1) нужен ли 1.25-bit вместо 2-bit после мержа PR #22836 — решается по S2; (2) имя владельца форка (`docs/fork.txt`); (3) устройство-эталон для Android-замеров (S2/S3 требуют ≥4 ГБ RAM, arm64).
