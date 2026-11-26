# 01 — Обзор open-source баз для BiliReader (ридер + офлайн-перевод + билингво)

**Дата:** 2026-11-03
**Метод:** структурированные данные GitHub API (`gh api repos/<r>`, дерево файлов, реальный код ключевых файлов), а не README-обещания. README-цифры перепроверены по API. Часть фактов помечена ⚠️ — требует проверки сборкой.

**Продуктовые требования (из task.txt), которые использованы как критерии:**
мобильные Android+iOS + Linux-десктоп → потом Win/macOS · слабое железо · время «выделил → увидел перевод» критично · офлайн-MT · режим билингво с удержанием строки · библиотека · темы · форматы epub/fb2/txt/md · коммерческое будущее (значит лицензия — не последний критерий).

---

## 1. Executive Summary

Готового «ридер + быстрый офлайн-переводчик + билингво» не существует. Максимум, что есть — ридеры с **облачным** переводом по выделению.

**Вердикт: форкать `Anxcye/anx-reader` (MIT, Flutter + foliate-js).**
Причина — не в фичах (Readest богаче), а в трёх вещах одновременно: лицензия MIT (коммерция), архитектура ровно наша (нативный Flutter-шелл + foliate-js в WebView + слой провайдеров перевода) и уже готовый `bilingual`-режим с prefetch по IntersectionObserver (`assets/foliate-js/src/translator.js`).

Запасные: **Readest** (AGPL, богаче всех, но лицензия и 4 590 файлов) и **собственная сборка на `foliate-js`** (MIT-движок, который используют оба лидера).

---

## 2. Сводная таблица

| # | Проект | Стек | Лицензия | Платформы | Форматы | Перевод по выделению | Зрелость | Активность | Форк | Размер |
|---|--------|------|----------|-----------|---------|----------------------|----------|------------|------|--------|
| 1 | **readest/readest** | Next.js 16 + React + Tauri v2 (Rust) | **AGPL-3.0** | mac/Win/Linux/Android/iOS/Web | EPUB, PDF, MOBI, KF8, **FB2**, CBZ, TXT, HTML, **MD** | ✅ попап + перевод всей книги, 5 облачных провайдеров, кэш | ★★★★★ | 25.9k★, push 2026-11-03 | 4/5 | 4 590 файлов (360 MB) |
| 2 | **Anxcye/anx-reader** | Flutter/Dart + flutter_inappwebview + foliate-js | **MIT** | Android, iOS, Win, macOS (+ `linux/`,`ohos/` ⚠️) | EPUB, MOBI, AZW3, **FB2**, TXT, PDF (нет MD) | ✅ 4 режима (off/only/translation/bilingual), перевод всей книги side-by-side, AI-словарь | ★★★★★ | 9.2k★, 2026-10-17 | **3/5** | 915 файлов |
| 3 | **johnfactotum/foliate-js** | чистый ES-modules JS | **MIT** | любая (браузер/WebView) | EPUB, MOBI, KF8, **FB2**, CBZ, PDF(exp.) — TXT/MD дописать | ❌ (нет, движок) | ★★★★☆ (API не стабилен, нет релизов) | 1146★, 2026-05-01 | 2/5 | ~7 MB |
| 4 | **koodo-reader** | Electron 35 + React | **AGPL-3.0** | Win/mac/Linux + web (+мобильные ⚠️ нет android/ios в корне) | EPUB, PDF, MOBI, AZW3, **FB2**, CBZ, TXT, MD | ✅ AI-перевод/словарь/суммаризация | ★★★★☆ | 28.7k★, 2026-11-01 | 4/5 | 95 MB |
| 5 | **koreader** | Lua + C++ (crengine) | **AGPL-3.0** | Linux, Android, e-ink (Kobo/Kindle/PocketBook) | EPUB, **FB2 (эталон)**, MOBI, PDF, DjVu, CBZ | ✅ `readerdictionary.lua` + `dictquicklookup.lua`, sdcv офлайн + Google | ★★★★★ | 30.8k★, 2026-11-03 (1397 issues) | **5/5** | 74 MB |
| 6 | **ttu-ttu/ebook-reader** | SvelteKit (PWA) | **BSD-3** | web/PWA only | EPUB, TXT, HTMLZ | ❌ (словари через Yomitan-расширения) | ★★★★☆ (+SRS/Anki) | 1056★, 2026-11-03 | 3/5 | 525 MB |
| 7 | **readium/{swift,kotlin,ts}-toolkit** | Swift / Kotlin / TS | **BSD-3** | SDK, не приложение | EPUB, PDF (нет FB2) | ❌ | ★★★★★ (стандарт) | 574★/395★/159★, 2026-11 | 3/5 (свой UI с нуля) | 100 MB/91 MB/2 MB |
| 8 | **edrlab/thorium-reader** | Electron + TS + Readium | **BSD-3** | Win/mac/Linux | EPUB, PDF | ❌ | ★★★★☆ | 2930★, 2026-11-03 | 4/5 | 167 MB |
| 9 | **foobnix/LibreraReader** | Java/C Android | **Other (NOASSERTION)** ⚠️ | Android | всё | частично (словари) | ★★★☆☆ | 4998★, 2026-11-02 | 4/5 | 460 MB |
| 10 | **gedoor/legado (阅读)** | Kotlin | **нет лицензии** | Android | epub/txt + веб-источники | ❌ | — | 47.2k★, но в репо только README (код удалён) | — | — |
| 11 | **geometer/FBReader** / **FBReaderJ** | C++ / Java | **нет файла лицензии** | Linux/Android | FB2, epub | ❌ | заморожен | 548★/1850★, 2020, archived | — | — |
| 12 | **kovidgoyal/calibre** | Python/Qt | **GPL-3.0** | all desktop | всё (конвертер) | ❌ | ★★★★★ | 26.3k★, 2026-11-03 | 5/5 | 339 MB |
| 13 | **jzohrab/lute-v3** | Python/Flask | **MIT** | web/desktop (не ридер книг) | текст/главы | ❌ (словарь+SRS) | ★★★☆☆ | 1603★, 2026-09-05 | 3/5 | — |
| 14 | **mengxi-ream/read-frog** | TS (расширение) | **GPL-3.0** | браузер | web-страницы | ✅ инлайн-билингво | ★★★★☆ | 10.3k★, 2026-11-02 | 1/5 (референс UX) | — |
| 15 | **yomidevs/yomitan** | JS (расширение) | **GPL-3.0** | браузер | словари | ✅ popup-словарь | ★★★★★ | 2912★, 2026-11-03 | 1/5 (референс) | — |
| 16 | **yihong0618/bilingual_book_maker** | Python | **MIT** | CLI | epub/txt | батч-перевод книги | ★★★☆☆ | 9923★, 2026-10-30 | 1/5 (референс) | 7 MB |
| 17 | Moon+ Reader / Readlang / LingQ / AnyLang | closed | — | — | — | ✅ (платно) | — | — | нельзя форкать | — |

---

## 3. Ключевые разборы

### 3.1 Readest — `readest/readest` (AGPL-3.0)

**Факты (проверено по API/дереву):**
- 25 895★, 1 813 форков, push **2026-11-03** (живее всех), 111 open issues, репо 360 MB, **4 590 blob'ов**.
- `apps/readest-app/README`: Next.js 16 + Tauri v2; macOS, Windows, Linux, **Android, iOS**, Web, PWA; App Store + APK.
- Форматы (README:50): EPUB, PDF, MOBI, KF8(AZW3), **FB2**, CBZ, TXT, HTML, **MD**.
- Перевод (`src/services/translators/`): `providers/{azure,deepl,google,yandex}.ts` + `custom/{deepl,openaiCompatible}.ts` + `cache.ts` (15.6 KB) + `dailyUsage.ts` + `preprocess.ts` + `polish.ts`. **Всё сетевое**; офлайна нет. `openaiCompatible` = можно нацелить на локальный llama.cpp-сервер (desktop), но на мобиле сервера нет.
- UI: `annotator/TranslatorPopup.tsx` (10.1 KB), `TranslationToggler.tsx` (перевод всей книги on/off), `annotator/Annotator.tsx` (**119 KB** — движок выделения), `FoliateViewer.tsx` (67.7 KB), `ReadingRuler.tsx` (**52 KB** — «линейка»!), `FootnotePopup.tsx` (44 KB), `ReaderContent.tsx` (22 KB), `ProgressBar.tsx` (22.9 KB).
- Словари: `annotator/DictionaryPopup.tsx` + `DictionaryResultsView.tsx` (25.9 KB) + `scripts/convert-yomitan-dictionary.ts` → Yomitan/StarDict попап-словарь уже есть.
- **Нативные плагины Tauri:** `src-tauri/plugins/tauri-plugin-native-tts/` с реальными `android/src/main/java/NativeTTSPlugin.kt` и `ios/Sources/NativeTTSPlugin.swift` → **готовый образец моста JS→Kotlin/Swift**. Это ровно та конструкция, в которую вставляется llama.cpp/ORT для офлайн-MT.
- Ещё: `ReadingStatsTracker.tsx`, `DuoBookModeToggler` (две книги рядом), KOReader-sync, autoscroll, темы.

**Плюсы:** максимальное покрытие фич; единственный, кто даёт Linux+Android+iOS+FB2+MD «из коробки»; ежедневная активность; паттерн нативного плагина уже отлажен.
**Минусы:** AGPL-3.0 (см. §5); 4 590 файлов и Next.js-стек → дорогой онбординг, тяжёлый редизайн; WebView-рендер на слабом железе — риск; SRS/словаря-тренажёра нет.
**Сложность форка: 4/5.**

### 3.2 Anx Reader — `Anxcye/anx-reader` (MIT) ← рекомендуемая база

**Архитектура (проверено по коду):**
- Flutter 1.15.0 (SDK ≥3.5.2), 915 файлов, `provider` + `riverpod`, `sqflite` (SQLite) для библиотеки/метаданных, `flex_color_scheme` (темы), `fl_chart`+`graphview` (статистика), `flutter_tts` (форк), `webdav_client` (синк).
- **Рендер книги:** `assets/foliate-js/` — вендоренный **foliate-js** внутри WebView (`flutter_inappwebview`, форк автора). То есть Flutter = быстрый нативный UI/библиотека/настройки, foliate-js = reflow-вёрстка, пагинация по CFI, поиск.
- **Перевод:** `lib/service/translate/{index,ai,deepl,google_api,microsoft_api,web_view}.dart` — абстракция провайдеров + `lib/enums/translation_mode.dart`:
  ```
  off | translationOnly | originalOnly | bilingual
  ```
  Плюс «Full-book translation with side-by-side view» (README:39) и AI-словарь по запросу.
- **Механика bilingual в JS** (`assets/foliate-js/src/translator.js`, 11.9 KB) — самое ценное:
  - `IntersectionObserver` с `rootMargin: '1280px'` → переводит блоки **заранее, до появления на экране**;
  - на каждый блок — `window.flutter_inappwebview.callHandler('translateText', text)` → Dart;
  - `#translatedElements` (WeakMap) = дедуп; режимы переключаются на живом документе.
  Это ровно «подготовь следующую/предыдущую строку», но на уровне абзаца.
- Форматы: EPUB/MOBI/AZW3/**FB2**/TXT/PDF. MD — нет (дописать модуль в foliate-js — тривиально).
- Платформы: `android/ ios/ macos/ windows/ linux/ web/ ohos/` присутствуют в дереве; README-бейдж Linux не заявляет → ⚠️ сборку под Linux проверить (Flutter Linux + inappwebview_linux — главный неизвестный).

**Плюсы:** **MIT** (коммерция свободна); нативный UI = предсказуемая производительность на слабом железе; уже есть 4 режима перевода и prefetch; FB2; SQLite; темы; 9.2k★ и живой мейнтейнер.
**Минусы:** перевод только сетевой; нет SRS/словарного тренажёра; нет «линейки»/удержания строки пальцем; нет MD; bus factor = 1 основной автор; 100 open issues.
**Сложность форка: 3/5.** Единственная база, где форк = «заменить слой перевода + добавить 2 жеста + SRS», а не переписывание.

### 3.3 foliate-js — `johnfactotum/foliate-js` (MIT)

- 1 146★, 296 форков, последний push 2026-05-01, 69 issues, ~7 MB, **нет релизов**, README прямо: *«this library itself is not stable. Expect it to break and the API to change»*.
- Реально умеет: `epub.js`, `fb2.js`, `mobi.js` (MOBI + KF8), `comic-book.js` (CBZ), `pdf.js`, `paginator.js` (reflow-пагинация), `fixed-layout.js`, `epubcfi.js`, `overlayer.js` (аннотации), `search.js`, `progress.js`, `dict.js`, `tts.js`, `text-walker.js`.
- **TXT/MD нет**, но «add support for other formats yourself by implementing the book interface» — это ~100 строк на формат (MD → HTML через `marked`).
- Мобильность: чистый ES-модульный JS без Node-зависимостей → работает в WebView (Tauri 2 mobile, Capacitor, `flutter_inappwebview`). Ограничение — не грузить файл целиком в память (заявлено) → хорошо для слабых устройств.
- Используется и Readest, и Anx Reader → де-факто стандарт reflow-движка для JS-ридеров.

### 3.4 KOReader — `koreader/koreader` (AGPL-3.0)

- 30 842★, push 2026-11-03, **1 397 open issues**, Lua + C++.
- Эталон по нашей проблеме №1 — «пересчитать страницы под шрифт/экран»: **crengine** даёт лучший в отрасли reflow FB2/EPUB (сноски, hyphenation, встроенные стили).
- Перевод/словарь: `frontend/apps/reader/modules/readerdictionary.lua` + `frontend/ui/widget/dictquicklookup.lua` — long-press → попап; **офлайн через sdcv (StarDict)** + Google Translate для слов/предложений. Плагин `vocabbuilder.koplugin` — словарь + повторение (SRS-зачаток).
- Как база — **нет**: Lua 5.1/LuaJIT, собственный UI-тулкит под e-ink и кнопки, C++-сборка под 8 платформ, отсутствие современной мобильной эргономики. Форк = переписывание UI. **Сложность 5/5.**
- Как референс — **да**: парсинг FB2-крайностей, пагинация, форматы словарей StarDict/Dictd, механика попапа.

### 3.5 ttu ebook-reader — `ttu-ttu/ebook-reader` (BSD-3)

- 1 056★, SvelteKit PWA, 525 MB (с тестами/ассетами), EPUB/TXT/HTMLZ, офлайн-PWA, очень качественный UX чтения (вертикальный текст, ruby, grid-режим, кэш глав).
- Перевод встроенного нет — словари подключаются **внешними расширениями Yomitan**; зато есть **свой SRS** + экспорт в Anki, и «dictionary extension» API.
- Как база — нет (нет мобильной оболочки, нет FB2/MD, нет перевода). Как референс — да: SRS-модель, UX настроек чтения.

### 3.6 Koodo Reader (AGPL-3.0)

- 28 706★, Electron 35 + React (`package.json`), 95 MB, форматы широкие включая FB2 и MD, AI-перевод/словарь/суммаризация, локальные MDX-словари, синк с KOReader/Readwise/Notion.
- В корне **нет** `android/`/`ios/`/Capacitor → мобильные сборки в этом репо не собираются (⚠️ магазинные версии, вероятно, отдельная webview-обёртка или другой репозиторий).
- Electron на слабом железе — главный минус (RAM/старт). **4/5**, не рекомендуется как база.

### 3.7 Readium SDK (BSD-3)

- `swift-toolkit` 574★, `kotlin-toolkit` 395★, `ts-toolkit` 159★; активны (2026-10/11). Это **не приложение**: парсинг, навигация, CFI/locator, рендер-вьюхи, a11y.
- FB2 нет, перевода нет, UI нет. Имеет смысл только при стратегии «полностью нативный клиент (Swift+Kotlin) со своим UI» — это +6–9 месяцев против форка Anx.

### 3.8 Остальное — почему «нет»

| Проект | Причина отказа |
|---|---|
| Thorium (BSD-3, 2930★) | Только EPUB/PDF, десктоп-Electron, перевода нет |
| Librera (4998★) | Лицензия `Other/NOASSERTION` — юридически неясно; легаси Java/C; только Android |
| Legado (47.2k★) | **В репозитории только README** (исходники удалены), лицензии нет, заточен под китайские веб-источники |
| FBReader / FBReaderJ | Архив/заморозка (2020), файла лицензии нет → нельзя копировать код |
| Calibre (GPL-3.0) | Не ридер для нашей задачи; брать только `ebook-convert` как внешний конвертер FB2/MD→EPUB в пайплайне импорта |
| Lute v3 (MIT, 1603★) | Не рендерит книги (текст/главы), нет мобильного клиента; брать модель данных «слово → статус изучения → SRS» |
| read-frog (GPL-3.0) | Лучший референс инлайн-билингво и LLM-промптов; код под GPL — только идеи, не копипаст |
| Yomitan (GPL-3.0) | Эталон popup-словаря; формат словарей использовать через конвертер (в Readest уже есть `convert-yomitan-dictionary.ts`) |
| bilingual_book_maker (MIT) | Батч-перевод книг; MIT → можно переиспользовать сегментацию/промпты для «перевести всю книгу» |

---

## 4. Вердикт

### 🥇 База №1: **Anx Reader (MIT)** — форк
Почему: (1) MIT — единственная зрелая база без AGPL-долга; (2) архитектура = нативный Flutter UI + foliate-js, то есть быстрый UI и лучший JS-reflow одновременно; (3) 4 режима перевода и prefetch-механика уже написаны — мы меняем **только** транспорт перевода (сеть → on-device) и добавляем жесты/SRS; (4) FB2/TXT уже есть, MD — модуль на день.

Что делаем внутри форка:
1. `lib/service/translate/` → добавляем `ondevice.dart` (реализация того же интерфейса), остальное не трогаем.
2. Нативный мост Flutter→C++ (llama.cpp/ORT) — Android JNI + iOS C-interop; desktop — FFI/DynamicLibrary.
3. `assets/foliate-js/src/translator.js` → режим `line-follow` (см. §6).
4. SQLite: `translations_cache`, `vocab`, `reading_sessions`.

### 🥈 База №2: **Readest (AGPL-3.0)** — если открытый исходник приемлем
Самый быстрый путь к «всё уже есть»: 6 платформ, FB2+MD, попап+книжный перевод, словарь, статистика, готовый нативный Tauri-плагин (TTS) как шаблон для MT. Цена: AGPL (весь продукт открыт, включая сетевой сервис) и 4 590 файлов Next.js.

### 🥉 База №3: **собственная сборка на `foliate-js` (MIT)** + Flutter (или Tauri 2)
Фактически «повторить архитектуру Anx, но без чужого кода»: foliate-js как git-submodule (README сам это советует), свой слой перевода, свои жесты. Дороже на 3–5 недель, зато нулевой лицензионный риск, полный контроль над WebView-мостом и маленький бандл. Это же — план B, если Anx-форк упрётся в Linux/WebView или в bus factor.

### Главные риски форка

| # | Риск | Влияние | Митигация |
|---|------|---------|-----------|
| R1 | **AGPL-заражение** (Readest/Koodo/KOReader/read-frog/Yomitan). Один скопированный файл → весь продукт AGPL | Высокое (бизнес-модель) | База = только MIT/BSD (Anx, foliate-js, ttu). GPL-проекты — читать, не копировать. Зафиксировать в `docs/licensing.md` + CI-проверка заголовков |
| R2 | **Латентность WebView-цикла** JS→native→MT→JS на слабом железе: у Anx каждый абзац = отдельный `callHandler` | Высокое (ядро требования) | Очередь с приоритетом «под пальцем», abort ушедших с экрана запросов, батчинг 3–5 сегментов, SQLite-LRU кэш переводов, прогрев модели при открытии книги |
| R3 | **On-device MT не встроен ни в один ридер** — интеграция целиком на нас. Hy-MT-1.25bit: 440 MB, GGUF зависит от **незамерженного** STQ-ядра llama.cpp (PR #22836) ⚠️ | Высокое (сроки) | Спайк в первую очередь (см. §7). Fallback: OPUS-MT/Marian int8 per-pair (десятки MB, CPU) или Bergamot; iOS — отдельный путь (CoreML/MLX), иначе ANE не задействуется |
| R4 | **FB2 в foliate-js слабее, чем в crengine** (KOReader). Крайние случаи: вложенные секции, `<image>` в base64, сноски, стили | Среднее | Тест-корпус 10–15 реальных FB2 (включая русские librusec/flibusta-выгрузки), дифф-тест против KOReader-рендера |
| R5 | **Bus factor / churn**: Anx — 1 основной автор, 100 открытых issues; foliate-js API нестабилен | Среднее | Форк фиксируем на теге, foliate-js — submodule с пиннингом; собственные тесты рендера/пагинации |
| R6 | **Linux-десктоп в Anx не подтверждён** (`linux/` есть, README не заявляет) | Среднее | Проверить `flutter build linux` + inappwebview_linux на целевых дистрибутивах на 1-й неделе |

---

## 5. Лицензионная карта (для коммерческого будущего)

| Лицензия | Проекты | Что можно |
|---|---|---|
| **MIT** | Anx Reader, foliate-js, Lute v3, bilingual_book_maker | форк, закрытый код, продажа — свободно (сохранить copyright notice) |
| **BSD-3** | ttu ebook-reader, Readium, Thorium | то же + запрет использовать имя в рекламе |
| **GPL-3.0** | Foliate (GTK), calibre, read-frog, Yomitan | только производные под GPL → в закрытый продукт нельзя |
| **AGPL-3.0** | Readest, Koodo, KOReader | как GPL + сетевое использование = распространение; закрытый SaaS тоже нельзя |
| **Нет лицензии / NOASSERTION** | Legado, FBReader(J), Librera | **нельзя** использовать (по умолчанию all rights reserved) |

---

## 6. Что придётся дописывать в любом случае (нет ни у кого)

1. **Режим «удержание → строка под пальцем»** с плавным переходом к соседним строкам. У Anx — абзац + `IntersectionObserver(rootMargin 1280px)`; у Readest — `ReadingRuler.tsx` (52 KB) как близкий, но другой механизм. Нужен `text-walker`/`Range`-хак в foliate-js: определить строку по `getClientRects()` от точки касания → расширить до предложения → prefetch [i-1, i, i+1] с приоритетом.
2. **Офлайн-MT движок + мост** (ffi/JNI/C-interop) + менеджер моделей (скачивание, кэш, warm-up, выбор пары языков). Ни один ридер этого не имеет.
3. **Билингво для FB2/TXT/MD** — существующие реализации работают на EPUB-абзацах; для FB2 нужна та же инъекция в `fb2.js`-документ, для TXT/MD — предварительная сегментация в параграфы при импорте (иначе билингво вставится в одну гигантскую строку).
4. **MD-парсер** (Readest: `marked`; Anx/Koodo-подобным — нет) + нормализация в HTML-документ для пагинатора.
5. **Пагинация под параметры** — в foliate-js `paginator.js` уже считает по CSS-columns; дописать hyphenation (RU/EN), «widows/orphans», поведение при смене шрифта/размера без потери позиции (CFI-якорь), и **прогресс-бар с %** из task.txt.
6. **SRS/словарь-тренажёр**: `vocab(word, lemma, context_sentence, book_id, status, due_at)` + экспорт в Anki. Референсы: Lute v3 (модель), ttu (UX + Anki), KOReader `vocabbuilder`.
7. **Сегментация + контекстный промпт** («перевод, адаптированный под смысл предложения» — anylang.net-эффект): предложение как единица перевода, слово — с предложением-контекстом; кэш по `hash(text+lang+model)`.
8. **Метрики/задел на аналитику** (время чтения, число переводов, «выучено слов») — у Anx есть `reading_sessions`/heatmap, у Readest `ReadingStatsTracker`; схему расширить сразу, чтобы не мигрировать.

---

## 7. Рекомендуемые следующие шаги (спайки, до архитектуры)

| # | Спайк | Критерий успеха | Время |
|---|-------|-----------------|-------|
| S1 | `flutter build linux` + `flutter_inappwebview` на Linux в форке Anx | окно открывает EPUB и FB2, выделение работает | 1–2 дня |
| S2 | llama.cpp + Hy-MT1.5-1.8B-1.25bit GGUF (STQ-патч) на среднем Android | первый токен ≤ 300 мс, предложение ≤ 1.5 с, RSS ≤ 700 MB | 2–4 дня |
| S3 | Альтернатива: OPUS-MT/Marian int8 (ONNX Runtime Mobile) RU↔EN | тот же бюджет латентности при 10× меньшем размере | 1–2 дня |
| S4 | Прототип `line-follow` в foliate-js (Range + `getClientRects`) | строка определяется под пальцем с точностью ≥ 90 % на 3 книгах | 2–3 дня |
| S5 | Кэш переводов в SQLite + очередь/abort | повторный показ строки < 20 мс | 1 день |

После S1–S4 решение «Anx-форк vs foliate-js-с-нуля» фиксируется окончательно.

---

## 8. Источники (проверено 2026-11-03)

- https://github.com/readest/readest — README:50 (форматы), :101–113 (платформы), LICENSE AGPL-3.0; дерево `apps/readest-app/src/services/translators/`, `src-tauri/plugins/tauri-plugin-native-tts/{android,ios}`
- https://github.com/Anxcye/anx-reader — LICENSE MIT; `assets/foliate-js/src/translator.js`; `lib/enums/translation_mode.dart`; `lib/service/translate/*`; `pubspec.yaml` (1.15.0+6358)
- https://github.com/johnfactotum/foliate-js — README (форматы, «not stable»)
- https://github.com/koodo-reader/koodo-reader — README:41–61, `package.json` (electron ^35)
- https://github.com/koreader/koreader — `frontend/apps/reader/modules/readerdictionary.lua`, `frontend/ui/widget/dictquicklookup.lua`, `plugins/vocabbuilder.koplugin`
- https://github.com/ttu-ttu/ebook-reader — README (EPUB/TXT/HTMLZ, Yomitan, офлайн)
- https://github.com/readium/{swift,kotlin,ts}-toolkit · https://github.com/edrlab/thorium-reader
- https://github.com/foobnix/LibreraReader (license: NOASSERTION) · https://github.com/gedoor/legado (только README) · https://github.com/geometer/FBReader (archived 2020, нет license)
- https://github.com/jzohrab/lute-v3 (MIT) · https://github.com/mengxi-ream/read-frog (GPL-3.0) · https://github.com/yomidevs/yomitan (GPL-3.0) · https://github.com/yihong0618/bilingual_book_maker (MIT)
- https://huggingface.co/AngelSlim/Hy-MT1.5-1.8B-1.25bit — 440 MB, 33 языка / 1056 направлений, GGUF, Android-demo; STQ-ядро = llama.cpp PR #22836 (не смержен)
- https://huggingface.co/AngelSlim/Hy-MT1.5-1.8B-1.25bit-GGUF — «This gguf depends on our STQ kernel»

### ⚠️ Непроверенное (требует действий, не веры)
- Anx Reader: собирается ли `linux/` и работает ли `flutter_inappwebview` на Linux/Windows.
- Koodo: откуда берутся магазинные Android/iOS сборки (в репо нет `android/`/`ios/`).
- Readest: реальная производительность Tauri-WebView на устройствах уровня Snapdragon 6xx / 3 GB RAM.
- Числа латентности Hy-MT на мобильных — маркетинговые графики, нужен собственный замер (S2).
