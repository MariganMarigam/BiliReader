# BiliReader — состояние на 2026-11-26

Снимок форка Readest: офлайн-читалка с встроенным переводом, словарём и линейкой.
План оставшихся работ — [ROADMAP.md](ROADMAP.md), перенос окружения — [PORTING.md](PORTING.md).

## Оглавление

1. [Версия и ревизия](#1-версия-и-ревизия)
2. [Что готово](#2-что-готово)
3. [Что не готово](#3-что-не-готово)
4. [Артефакты](#4-артефакты)
5. [Проверка за 5 минут](#5-проверка-за-5-минут)
6. [Ограничения и известные проблемы](#6-ограничения-и-известные-проблемы)
7. [Тесты](#7-тесты)

## 1. Версия и ревизия

| | |
|---|---|
| Что это | Форк Readest (Tauri v2 + Next.js 16): чтение EPUB/FB2 и др., офлайн-перевод EN→RU на llama.cpp, словарь, офлайн-шрифты; Linux-сборки на CEF |
| Версия | **0.1.0** — `apps/readest-app/package.json` (единственный источник; `tauri.conf.json` читает `../package.json`) |
| Ветка | `bilireader/main`, remote `origin` = `MariganMarigam/BiliReader` |
| HEAD | `5bcd65bb7` — `docs(manual-test): 0.1.0 release, dictionary and model download checks` |
| Платформа снимка | Linux x86_64, CEF-рантайм (не WebKitGTK) |

## 2. Что готово

| Возможность | Состояние | Где смотреть |
|---|---|---|
| Чтение | EPUB 3 (nav + NCX) и FB2 (windows-1251) проверены вручную; PDF, MOBI/KF8, CBZ, TXT, HTML, MD наследуются от Readest | `samples/sample.epub`, `samples/sample-1251.fb2`, `docs/manual-test.md` B1–B2, B9 |
| Пагинация | Постраничный и прокручиваемый режимы; клавиатура (`→`/`Space`/`l`, `←`/`Shift+Space`/`h`, `PageUp/PageDown`), свайп | B2–B4 |
| Темы и кегль | Light / Dark / Sepia; смена кегля перевёрстывает книгу без потери позиции | B5–B7 |
| Прогресс | Полоса и проценты, клик по полосе, восстановление позиции после перезапуска | B8, B11–B12 |
| Встроенный перевод | llama.cpp в процессе Tauri: `llama-cpp-2` 0.1.161, vendored llama.cpp `8642541b255bfb5dc39cd351a178be09013a55d6`, модель Hy-MT2-1.8B Q4_K_M (1.13 ГБ), `n_ctx=2048` | `docs/local-engine.md` |
| Провайдер `local` | Desktop — IPC `translate_local`; web — OpenAI-совместимый `llama-server` на `127.0.0.1:8080/v1` | `docs/local-provider.md` |
| Кэш и отмена | Потоковые дельты `translation://token`, отмена флагом на каждый токен (`cancelled: true`, не ошибка IPC), кэш переводов предложений | `docs/local-engine.md`, B16 |
| Режим линейки | Line-aware ruler: шаг по реальной геометрии строк; удержание строки 0.4 с переводит предложение, движение вверх/вниз — соседнее | B16, `apps/readest-app/docs/superpowers/specs/2026-05-29-line-aware-reading-ruler-design.md` |
| Менеджер моделей | Манифест, докачка `Range`, SHA-256, удаление; ошибки `network/checksum/disk/cancelled/unsupported` | `docs/models.md`, B13–B15 |
| Словарь | FreeDict EN–RU 2025.11.23 (WikDict), 62 181 статьи, ~6.5 МБ; точная форма → лемма → переводчик | `docs/dictionary.md`, B17 |
| Офлайн-шрифты | PT Serif и PT Sans, по 4 начертания, ~3.1 МБ, OFL 1.1 | `docs/fonts.md` |
| Сборки Linux | `.AppImage`, `.deb`, `.rpm`; CEF-рантайм; скрипт сборки с проверкой свободного места | `docs/baseline.md`, `scripts/bilireader-build-linux.sh` |

## 3. Что не готово

| Пункт | Факт |
|---|---|
| Android | Тулчейн и сборка не запускались; `gen/android` есть, NDK не ставился. План — [ROADMAP.md](ROADMAP.md#c-android) |
| Релиз на GitHub | Тега `v0.1.0` и релиза нет (`gh release list` пуст); артефакты лежат только локально в `dist/` |
| Зеркало модели | Второй источник (GitHub Release) не опубликован; в манифесте один URL — Hugging Face, закреплённая ревизия `a0c709d9` |
| SRS | Не начат |

## 4. Артефакты

`dist/` в git не входит (`.git/info/exclude`), поэтому файлы нужно переносить отдельно.

| Файл | Байт | МиБ | SHA-256 |
|---|---:|---:|---|
| `BiliReader_0.1.0_amd64.AppImage` | 277 514 423 | 264.7 | `ff7484cc075801b10e02a5cc59e823941b858f0673c825ceecbf316a98f71faa` |
| `BiliReader_0.1.0_amd64.deb` | 189 448 792 | 180.7 | `410e8316da3c9403019e82b63fe66f58e894bfd82e3e49e43e15b93ca57f8987` |

Проверка целостности (из каталога с файлами):

```sh
sha256sum -c SHA256SUMS
```

Сборка заново: `scripts/bilireader-build-linux.sh` (25–45 мин, нужно ≥ 8 ГБ свободно;
`df -h /` перед запуском). Готовые бандлы — `target/release/bundle/{appimage,deb,rpm}/`.

## 5. Проверка за 5 минут

```sh
# 1. Запуск без установки (окно библиотеки за 5–10 с)
chmod +x dist/BiliReader_0.1.0_amd64.AppImage && ./dist/BiliReader_0.1.0_amd64.AppImage

# 2. Или из исходников, только UI в браузере (5–15 с, без Rust)
scripts/bilireader-run.sh        # http://localhost:3000
```

| Что смотреть | Ожидаемо |
|---|---|
| Библиотека → «+» → Import Books → `samples/sample.epub` | Книга на полке, открывается, 3 главы |
| `samples/sample-1251.fb2` | Русский текст без кракозябр |
| Панель **Aa**: Light → Dark → Sepia, кегль 16 → 22 → 16 | Тема и вёрстка меняются, позиция не теряется |
| Закрыть и открыть книгу | Позиция сохранена, `~/.local/share/com.bilireader.app/Readest/Books/*/config.json` содержит `progress` |
| Двойной клик по слову `dog` | Карточка словаря офлайн, без сети |
| Settings → Language → Offline engine | Статус `Not installed` (модель в бандл не входит) |

## 6. Ограничения и известные проблемы

| Проблема | Детали |
|---|---|
| Манифест модели «застревает» в старых сборках | `public/models/manifest.json` компилируется в бандл: смена URL/ревизии требует пересборки; уже установленное приложение продолжает видеть старый манифест (`docs/models.md`, шаг 6) |
| Размер CEF | `libcef.so` — 268 561 560 Б (≈256 МиБ); распаковывается из CEF-дистрибутива, отсюда основной вес AppImage |
| RSS перевода | 1.87–1.90 ГиБ после загрузки модели (вес 1.0 ГиБ + compute buffer 258 МиБ + KV-кэш `n_ctx=2048`) |
| Скорость на телефоне | 10–20 tok/s — **оценка**, не измерение; на десктопе 29 tok/s на длинном предложении |
| Одиночное слово через LLM | Если слова нет в FreeDict, запрос уходит в переводчик (локальный или облачный) — это фолбэк, не ошибка |
| Модель не входит в бандл | 1.13 ГБ скачиваются из Settings → Language → Offline engine, нужен интернет |
| Web-сборка без движка | В браузере встроенного llama.cpp нет; панель Offline engine скрыта, перевод — через `llama-server` |
| AppImage и память | Упаковка `mkdwarfs` по умолчанию съедает ~8.9 ГБ RSS и была убита OOM; рабочий обход — симлинк `mkdwarfs` → `dwarfs-universal` с флагами `-N 4 --num-scanner-workers 4 --num-segmenter-workers 4 -L 4g` и `appimagetool` по готовому `AppDir` |
| Подпись апдейтера | `bundle.createUpdaterArtifacts: true` и вшитый публичный ключ: локальная сборка идёт с `--no-sign`, обновления по ней не проверяются |

## 7. Тесты

| | |
|---|---|
| Полный прогон (pre-push) | **15110 passed, 16 skipped, 0 failed** на `dac22085a` |
| JS/TS | `pnpm -C apps/readest-app test:pr:web:unit` (неинтерактивный `vitest run`) |
| Полный, как в хуке | `pnpm -C apps/readest-app test` |
| Rust-ядро | `pnpm --filter @readest/readest-app test:tauri` (нужен дисплей) |
| Только переводчик | `cd apps/readest-app/src-tauri && cargo test -p Readest translation_core -- --nocapture` (без `BIREADER_MODEL_PATH` реальные тесты печатают `SKIP`) |
| Известное | 3 теста `plugins/integration.test.ts` падают в этом окружении с «File format is not recognized»; затронутые пути не менялись |
