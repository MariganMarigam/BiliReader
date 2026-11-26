# 03 — Клиентский стек, пагинация, sentence index

**Дата:** ноябрь 2026 · **Автор:** Scout · **Статус:** research + verdict (кода не писал)
**Проверено по:** исходникам foliate-js (main), релизам Tauri 2.12.x, Compose Multiplatform 1.12.x, Readium (Kotlin 3.2.0 / TS 2.14.0), Expo SDK 56, Readest (issues + релизы), caniuse/caniwebview.

---

## 0. TL;DR (вердикт)

1. **Рекомендованный стек: Tauri v2 + React/TS + foliate-js (MIT) как движок рендера.** Не «форк Readest», а **форк foliate-js** + переиспользование *идей и паттернов* Readest. Причина: Readest — **AGPL-3.0**, foliate-js — **MIT** (см. §5.4). Если AGPL приемлем — можно брать Readest целиком, это самый быстрый путь.
2. **Пагинация:** только браузерный движок даёт честный reflow EPUB. foliate-js делает это через CSS multi-column: весь раздел книги раскладывается в колонки шириной `columnWidth`, iframe растягивается на `pageCount * size`, контейнер скроллится ровно на одну колонку. Пересчёт при смене шрифта/кегля/экрана — это `columnize() + expand() + scrollToAnchor(anchorRange)`: DOM **не перезагружается**, позиция держится за `Range`.
3. **Sentence index:** канонический текст раздела + **глобальные char-offsets** (не CFI!), `Intl.Segmenter(granularity:'sentence')` + пост-обработка сокращений, маппинг offset→DOM `Range` бинарным поиском по таблице текст-нод. Long-press: `caretRangeFromPoint` → offset → бинарный поиск предложения → подсветка по `getClientRects()`, попап над первой строкой.
4. **Главный риск:** старый **Android System WebView** (< 108). Readest упёрся в это и сделал апгрейд WebView внутри процесса (#4142) + диалог «WebView устарел» — это подтверждённый, но дорогой симптом. Второй риск — **AGPL** при форке Readest.
5. Confidence: **0.82** (механика пагинации 0.95 — читал код; стек 0.85; sentence index 0.75 — дизайн, не бенчмарк; Tauri mobile 0.85 — Readest в сторах).

---

## 1. Сравнение стеков

### 1.1 Таблица (5 = лучший в классе)

| Критерий | Tauri v2 + React | Flutter | KMP + Compose | RN / Expo | Capacitor / PWA | .NET MAUI |
|---|---|---|---|---|---|---|
| Вёрстка текста и кастомная пагинация | **5** CSS columns + reflow «из коробки» | 2 нет CSS-движка, EPUB → свой layout | 2 нет CSS, свой layout на Skia | 4 (через WebView, 2 слоя) | **5** (тот же WebView) | 2 (WebView внутри, но слабее) |
| Выделение / long-press / попап | 4 DOM Selection + `getClientRects` | 3 `SelectableText`, конфликты с pager | 3 `SelectionContainer`, кастомные ручки — боль | 3 (мост в WebView) | 4 | 3 |
| Нативный инференс (llama.cpp/ONNX) | 4 Rust-крейты / JNI+Swift FFI | **5** `llama_cpp_dart`, `llm_llamacpp` | 3 cinterop, мало библиотек | **5** `llama.rn` (TurboModule) | 1 WASM/WebGPU — не тянет 0.5–1 ГБ | 3 LLamaSharp/ORT на мобиле сырые |
| Размер бандла (без моделей) | 4 ≈10–30 МБ | 3 ≈20–35 МБ | 4 ≈10–15 МБ Android, +9 МБ iOS | 2 ≈35–60 МБ | 4 ≈10 МБ (Electron-десктоп 80–150 МБ) | 2 ≈30–45 МБ |
| Linux-десктоп | **5** WebKitGTK, first-class | **5** | 4 Compose Desktop (JVM) | 1 нет официально | 3 только community-платформа | 1 нет (OpenMaui — превью) |
| Зрелость мобильных сборок | 4 Readest в сторах, но tooling шершавый | **5** | 4 iOS stable c 1.8 | **5** | 5 | 3 |
| Скорость разработки | **5** TS/React + MIT-движок + опыт Readest | 2 пагинатор писать самому | 1 | 3 | 4 | 2 |
| Риск WebView на слабом Android (5 = низкий) | **2** системный WebView, floor ~108 | 5 WebView нет → риск в текстовом движке | 5 то же | 3 WebView всё равно внутри | 2 | 3 |

### 1.2 Почему так

- **Текстовая вёрстка — единственный критерий, который действительно режет.** Требование «пересчёт страниц под шрифт/кегль/интерлиньяж/поля/экран» для EPUB/FB2 — это CSS-пагинация. Движки без CSS (Flutter, Compose, MAUI) вынуждают писать свой layout: переносы, висячая пунктуация, сноски, таблицы, картинки, списки, RTL/вертикальный текст. Это месяцы и всё равно хуже.
- **Flutter** идеален для инференса (`llama_cpp_dart` 0.9: Android/iOS/macOS, worker-isolate, Hexagon NPU; `llm_llamacpp`: + Windows/Linux), но EPUB придётся либо конвертировать в виджеты (потеря CSS), либо затаскивать WebView — и тогда WebView-риск возвращается, только уже без экосистемы веба.
- **KMP + Compose** — iOS Stable с 1.8 (май 2025), 1.12.2 stable (окт 2026), Linux-десктоп стабилен. Но текстовая вёрстка/выделение — самое слабое место Compose, а cinterop с llama.cpp мало обкатан.
- **RN/Expo** — отличный `llama.rn`, но **нет Linux-десктопа**; EPUB всё равно в WebView (примеры: `deinf/ebook_reader` — epub.js в react-native-webview, и там всплыли жёсткие ограничения iOS: нет custom baseUrl → epub.js iframe не грузится, пришлось инлайнить ассеты в data URL). Два слоя моста вместо одного.
- **Capacitor/PWA** — рендер ок, но офлайн-инференс только WASM (нереально для 0.4–1 ГБ модели на 2–3 ГБ RAM), десктоп — community-платформа (Capawesome, июль 2026) поверх Tauri/Electron.
- **.NET MAUI** — Linux официально не поддерживается (OpenMaui/Avalonia — превью 2026), текст — WebView или нативные контролы, выигрыша нет.

---

## 2. Пагинация: как это реально работает

### 2.1 Механика foliate-js (`paginator.js`, main, MIT)

Читал исходник целиком. Ключевые функции:

| Функция | Что делает |
|---|---|
| `View.columnize({width,height,gap,columnWidth})` | на `documentElement` iframe ставит `column-width: trunc(columnWidth)px; column-gap; column-fill:auto; height:<height>px; overflow:hidden`; `padding: 0 (gap/2)px`; сбрасывает `max-width/max-height/margin` |
| `View.expand()` | меряет `#contentRange.getBoundingClientRect()`; `pageCount = ceil(contentSize / size)`; растягивает iframe на `expandedSize = pageCount * size` → браузер **допереливает** текст в новые колонки; дергает `onExpand()` |
| `Paginator.#beforeRender()` | считает `size = container.width|height`, `divisor = min(maxColumnCount, ceil(size / maxInlineSize))`, `columnWidth = size/divisor - gap`. `gap` — процент от `size`, пересчитанный так, чтобы внешние поля и межколоночный зазор совпадали |
| `Paginator.#scrollToPage(page)` | `container.scrollLeft = size * page` (RTL — отрицательный), анимация `easeOutQuad` 300 мс при `animated` |
| `Paginator.#afterScroll(reason)` | вычисляет **видимый Range** (`getVisibleRange` → tree walker + `bisectNode` по `getClientRects`), кладёт в `#anchor`, эмитит `relocate {range, index, fraction, size}` |
| `Paginator.scrollToAnchor(anchor)` | anchor = `Range` | `Element` | доля 0..1 → `#scrollToRect` → `#scrollToPage` |
| `Paginator.snap(vx,vy)` | свайп: по скорости и текущему центру выбирает страницу, доводит; на границе главы уходит в `#adjacentIndex(±1)` |

Итого: **не «split по viewport»**, а CSS multi-column + скролл на одну колонку. Плюсы: браузер сам считает переносы, сноски, картинки, `break-inside`. Минусы (признаны в README): медленно на больших разделах, часть CSS ведёт себя не так, как в печати.

**Смена шрифта/кегля/интерлиньяжа/размера окна:** меняются CSS-переменные в iframe (`setStyles()`), затем `render()` → `#beforeRender()` + `expand()` + `scrollToAnchor(#anchor)`. DOM **не перезагружается**, поэтому сохранённый `Range` остаётся валидным, а номер страницы пересчитывается. Это ровно та UX-механика, которая нужна («пересчёт страниц, но читатель не теряет место»).

**Стоимость:** один reflow раздела на каждое изменение. Для раздела 10–30 КБ — десятки мс; для 200 КБ XHTML на слабом Android — сотни мс. Отсюда правило: **резать книгу на разделы ≤ ~30 КБ** (для TXT/MD/FB2 — синтетические разделы), менять настройки с debounce 150–250 мс, показывать «пересчёт…».

### 2.2 Можно ли переиспользовать вне Readest

**Да.** README прямо говорит: «It is a totally standalone module. You can use it to paginate any content». Зависимости пагинатора: DOM, `Range`, `ResizeObserver`, iframe. Контракт: `open(book)`, `goTo({index, anchor})`, `prev()/next()`, события `load` / `relocate` / `create-overlayer`; книга — объект с `.sections[].load()`, `.sections[].size`, `.toc`, `.resolveHref()`, `.metadata`.

Что даёт форк `readest/foliate-js` сверх upstream: CFI-совместимый прогресс, аннотации/оверлеи, responsive-раскладка, TTS-разметка, PDF-адаптер. Что **нельзя** брать на веру из старого артефакта `task.txt`: там фигурирует `view.selection` (`task.txt:405`) — **такого API в foliate-js нет**. В `view.js` есть `renderer.getContents()` (строка 403) → `{doc, index, overlayer}`, а видимый диапазон живёт в `paginator.#lastVisibleRange` и приходит в `relocate.detail.range`. Выделение берётся из `doc.getSelection()` внутри iframe. Планировать интеграцию по `view.selection` нельзя.

### 2.3 Readium вместо foliate-js?

| | Readium TS (`@readium/navigator` 2.14.0, 23 окт 2026) | Readium Kotlin 3.2.0 (18 мая 2026) | foliate-js (MIT) |
|---|---|---|---|
| Форматы | EPUB + WebPub (манифест обязателен) | EPUB (LCP) | EPUB, MOBI, KF8/AZW3, FB2, CBZ, PDF (эксп.) |
| Пагинация | iframe + Readium CSS + columns | ViewPager + свой WebView + JS-мост | CSS columns, standalone |
| Выделение/аннотации | Decorator API (июль 2026), адресация `Locator`; **issue #231 «Missing text selection anchors for readium locators» (июнь 2026)** | есть, но новый Compose-navigator без JS-моста (issue #830) | `Range` напрямую, `overlayer.js` |
| Один код на всё | TS-навигатор — да, но только EPUB | Kotlin ≠ Swift ⇒ два кода | один JS на все WebView |
| Риск мейнтейна | молодой, 16 контрибьюторов | новый navigator не в alpha; мейнтейнер: «meaningful Kotlin work не раньше mid-2027» (issue #830, 11 сен 2026) | «API нестабилен», но код маленький и форкается |
| Лицензия | BSD-3 | BSD-3 | MIT |

**Вывод:** Readium — правильный выбор, если бы мы писали **нативно на каждой платформе** (Kotlin для Android, Swift для iOS). Для «один код + WebView» foliate-js дешевле и покрывает больше форматов; Readium TS пришлось бы кормить манифестом, а FB2/TXT/MD всё равно писать адаптерами. Берём foliate-js (лучше — форк Readest, но см. AGPL).

---

## 3. Sentence index (для long-press, попапа и префетча)

### 3.1 Принцип: канонические offset'ы, а не CFI

CFI привязан к структуре EPUB и ломается/дорожает на FB2/TXT/MD. Нам нужен якорь, устойчивый к **перепагинации**. Поэтому:

```
Раздел (spine item) → канонический текст + таблица текст-нод → предложения как [start,end) в символах.
```

Перепагинация не меняет DOM-текст ⇒ offsets остаются валидными. Инвалидация — только при выгрузке/перезагрузке раздела (пересборка ~1–5 мс на 30 КБ).

### 3.2 Схема

```ts
// Строится один раз на раздел, кэшируется в памяти + SQLite
interface CanonicalSection {
  sectionIndex: number;
  text: string;                     // конкатенация всех Text-нод в document order
  nodes: Array<{ node: Text; start: number; end: number }>; // start/end — глобальные offset'ы
  sentences: SentenceRec[];
  segVersion: number;               // версия правил сегментации
}
interface SentenceRec {
  idx: number;        // порядковый номер в разделе
  start: number;      // включительно
  end: number;        // исключительно
  blockId: number;    // индекс ближайшего block- ancestor (p/li/h1..h6/div с текстом)
}
```

SQLite:

```sql
CREATE TABLE sentence_index (
  book_id TEXT NOT NULL, section_index INTEGER NOT NULL, idx INTEGER NOT NULL,
  start INTEGER NOT NULL, end INTEGER NOT NULL, block_id INTEGER NOT NULL,
  seg_version INTEGER NOT NULL,
  PRIMARY KEY (book_id, section_index, idx)
);
CREATE TABLE locator (            -- «где читатель остановился»
  book_id TEXT PRIMARY KEY,
  section_index INTEGER NOT NULL,
  char_offset INTEGER NOT NULL,   -- канонический offset = primary
  cfi TEXT,                       -- производное, для экспорта/синка
  updated_at INTEGER NOT NULL
);
```

Объём: роман 500 КБ текста ≈ 6–8 тыс. предложений ≈ < 1 МБ в SQLite. Строить лениво: раздел при первом открытии; фоном — остальные (нужно для префетча через границы страниц).

### 3.3 Построение

1. `TreeWalker(doc.body, SHOW_TEXT)`, пропускать `script/style` и узлы с `[data-bi-ignore]` (наши оверлеи), пустые/пробельные ноды — включать (они разделяют слова), но помечать.
2. `text += node.nodeValue`, `nodes.push({node, start, end})`.
3. `new Intl.Segmenter(lang, {granularity:'sentence'}).segment(text)` — Baseline widely available с окт 2026 (Chrome 87+, Safari/iOS 14.5+, Android WebView = Chromium). Даёт ICU-качество для ru/en/de/CJK.
4. Пост-обработка (обязательна, ICU ломается на сокращениях и инициалах):
   - merge, если предыдущий сегмент оканчивается на `т. е.`, `т. д.`, `г.`, `гг.`, `в.`, `вв.`, `с.`, `стр.`, `№`, `им.`, одиночную заглавную с точкой (`А.`), `Mr.`, `Dr.`, `e.g.`, `i.e.`;
   - merge, если сегмент короче 15 символов и не кончается на `[.!?…]»"')]`;
   - merge через границу блока **только** если предыдущий не кончается терминатором (иначе заголовок склеится с абзацем);
   - не склеивать через `<br>`/`<hr>`.
5. `blockId` — подниматься от `range.startContainer` до первого block-level предка (кэш `Map<Element, number>`).

### 3.4 offset → DOM Range (и обратно)

```ts
function offsetToRange(sec: CanonicalSection, start: number, end: number): Range {
  const a = binSearch(sec.nodes, start);  // последняя нода с node.start <= start
  const b = binSearch(sec.nodes, end - 1);
  const r = sec.nodes[a].node.ownerDocument.createRange();
  r.setStart(sec.nodes[a].node, start - sec.nodes[a].start);
  r.setEnd(sec.nodes[b].node, end - sec.nodes[b].start);
  return r;
}
```

Обратно (точка тапа → offset): `doc.caretRangeFromPoint(x, y)` (WebKit/Safari) или `doc.caretPositionFromPoint(x, y)` (Chromium) → `container` + `offset` → найти ноду в `sec.nodes` → `global = node.start + offset`. Обе функции проверять: в Chromium `caretRangeFromPoint` тоже есть, но `caretPositionFromPoint` точнее; на WebKit — наоборот.

Это тот же приём, что `text-walker.js` (MIT, экспортирует `textWalker`): собрать текст → сделать строковую операцию → вернуть `Range`. Можно не писать своё.

### 3.5 Long-press: подсветка «на всю ширину» + попап

1. `pointerdown` → таймер 350–450 мс + допуск движения 8 px (иначе это свайп/скролл). Важно: в foliate `touchmove` делает `preventDefault()` и скроллит колонку — на время long-press ставить флаг и не скроллить (Readest это чинил: «stop a mid-touch text selection from hijacking the brightness swipe», #5958).
2. По срабатыванию: точка → предложение `i` → `Range` → подсветка.
3. Геометрия: `range.getClientRects()` (тот же приём, что `overlayer.js:20,34`). Сгруппировать прямоугольники по `top` с допуском ±2 px → по одному боксу на строку. Каждую строку расширить до границ колонки: внутри iframe координаты абсолютные по всей полосе колонок, поэтому `colIndex = floor(rect.left / size)`, `x = colIndex*size + gap/2`, `w = size - gap`. Вертикаль — `rect.top/height`. Рисовать в оверлее (div layer поверх iframe, `pointer-events:none`), а не внутри книги — иначе это ломает CFI и выделение.
4. Попап — в host-DOM (вне iframe, чтобы не обрезался колонкой): `x = firstLine.left - scrollLeft + w/2`, `y = firstLine.top - 8`, `transform: translate(-50%,-100%)`; если `y < headerHeight` → показать под последней строкой (`top = lastLine.bottom + 8`). Ширина `min(360px, viewport - 32px)`.
5. Внутри попапа: оригинал (мелко), перевод (крупно), кнопки «сохранить/озвучить», скелетон на время инференса.

### 3.6 Префетч при «медленном сползании»

```
onLongPress(i):  prefetch(i, IMMEDIATE); prefetch(i-1, ADJACENT); prefetch(i+1, ADJACENT)
onDrag(dy):      если |dy| > lineHeight*0.8 → active = i ± 1
                 debounce 120 мс → prefetch(active, IMMEDIATE) + prefetch(active±1, ADJACENT)
                 generation++ (старые задачи с меньшим generation отменяются до инференса)
```

Ключ кэша: `sha256(normalized(text) + src + dst + modelId + params)` — нормализация: NFKC, `\s+`→` `, trim. Повторный тап = 0 мс. Очередь — `BinaryHeap` по приоритету (`Immediate > CurrentPage > Adjacent`), отмена — по `generation`-токену **до** вызова инференса; отмена в середине генерации — `llama.cpp` прерывается по `std::atomic<bool>` (проверка на каждый токен), это уже описано в `task.txt` (prefetch.rs).

Границы страниц/глав: если `i` — последнее предложение раздела, при prefetch подгрузить следующий раздел (`sections[i+1].load()`), построить его индекс (лениво), и только потом переводить. Иначе на границе главы будет дырка.

### 3.7 Прогресс книги (нижняя линия)

`bookProgress = (Σ size разделов до текущего + fraction * current.size) / Σ size` — `fraction` приходит из `relocate`. Для полосы: ширина = `progress`, перпендикулярная метка = `progress`, подпись `Math.round(progress*100)%`. Для «страница X из Y в главе» — `relocate.size` (доля раздела на страницу).

### 3.8 Что проверить бенчмарком (до реализации)

- `Intl.Segmenter` на 30 КБ русского текста: ожидаемо 5–15 мс — измерить на целевом слабом Android.
- Пересборка индекса раздела при повторном открытии: < 10 мс (иначе кэшировать в SQLite обязательно).
- `getClientRects()` на предложении из 3–5 строк: 0.2–1 мс — ок для драга, но не вызывать на каждом `pointermove` без rAF-троттлинга.

---

## 4. Форматы: парсеры и зрелость

| Формат | Решение | Зрелость | Замечания |
|---|---|---|---|
| EPUB 2/3 | `foliate-js/epub.js` + `epubcfi.js`, zip через `zip.js` | Высокая (годы в Foliate, Readest) | random access к `File`, книга не грузится в память целиком; CFI parse/stringify есть |
| FB2 / FB2.zip | `foliate-js/fb2.js` | Средне-высокая (в Foliate стабильно) | **Проверить декодирование**: FB2 часто `windows-1251`/`koi8-r` — читать XML-декларацию и `TextDecoder(charset)`; CSS в FB2 нет → стили даём свои; `<section>` даёт естественные границы разделов |
| TXT | свой конвертер (Readest: детект глав regex + «merge scene-break sections») | Средне | резать на разделы ≤30 КБ по границам абзацев; кодировку определять (chardet-подобно / BOM / эвристика) |
| MD | `markdown-it` 14.x → HTML + наш CSS | Высокая | нужен плагин сносок (`markdown-it-footnote`); Readest уже умеет markdown — можно подсмотреть пайплайн |
| PDF | PDF.js (foliate fixed-layout, экспериментально) | Низкая | вне фазы 1 |
| MOBI/AZW3/CBZ | `foliate-js/mobi.js`, `comic-book.js` | Средне | бонусом бесплатно |

Парсеры-альтернативы: `fb2-parser` (npm) — заброшен; Calibre — Python, не для клиента. Для MD — `markdown-it`/`micromark`, оба зрелые.

---

## 5. Риск: «мобильная сборка Tauri v2» в 2026

### 5.1 Состояние

- **Tauri 2.12.3** (10 окт 2026), 2.12 — крупнейший апдейт 2.x; MSRV 1.90; Android-шаблон на Gradle 9.6 / Kotlin 2.2 / `targetSdk 37` (Android 17). Мобилка — не эксперимент, но и не «как desktop».
- **Existence proof:** Readest (Tauri + Next.js + форк foliate-js) шипится в Google Play, App Store, Linux/Windows/macOS. То есть ровно наш класс приложения на этом стеке уже живёт в продакшене.
- **Плагины:** мобильные реализации есть у части официальных плагинов; `dialog` на Android/iOS **не поддерживает выбор папки**, возвращает `content://` URI. `fs`-плагин читает `content://` (2.6–2.7, окт 2026 — фиксы для content provider'ов). Для «библиотека читает файлы на месте» нужен SAF-tree → community `tauri-plugin-android-fs` (FileUri, tree URI) или свой Kotlin-плагин. На iOS — security-scoped URLs (`startAccessingSecurityScopedResource`).

### 5.2 WebView — главное ограничение

- Движок **не входит в бандл**: Android — системный `Android System WebView` (обновляем через Play, но на e-ink/MTK-устройствах без GMS часто заморожен), iOS — WKWebView (обновляется с ОС), Linux — WebKitGTK.
- Подтверждённый кейс Readest: **#4274** — на WebView < 108 верстка библиотеки складывается в 52 px; тот же баг на iOS < 15.4 и на старых Tauri-хостах. Мера: **#4142** «upgrade in-process WebView on devices stuck on old system WebView» + **#4149** (beta/dev/canary каналы) + диалог «Android System WebView is outdated» в troubleshooting-доках.
- Отсюда политика: **floor = Chromium/WebView 108 (ноя 2022), iOS 15.4+**; детект при старте (`CSS.supports`, `navigator.userAgentData`), предложение обновиться, fallback — `flow: scrolled` (в foliate переключается без перезагрузки).
- Три движка (WebKitGTK / WKWebView / Chromium) = три поведения. Больнее всего Linux (WebKitGTK). Тестировать обязательно на всех трёх; для пагинатора критичны баги `getBoundingClientRect` в WebKit (в коде foliate уже есть обходные пути — `-webkit-line-box-contain`, `uncollapse`, Firefox-фиксы).

### 5.3 Размер и память

- Оболочка Tauri: ≈3–10 МБ «hello world» (Capawesome), реальное приложение с pdf.js/шрифтами — десятки МБ. Модель качается отдельно (150–600 МБ), в APK её класть нельзя (App Store/Play лимиты + обновления).
- На устройстве 2–3 ГБ RAM модель 1.8B/1.25-bit (~440 МБ) + WebView + Rust-ядро — на грани. Нужен `mmap`, `n_ctx` 256–512, 2 потока (так делает `kelegele/ai-offline-translator`: `n_ctx=256`, `n_threads=2`), и graceful fallback на облако/маленькую модель.

### 5.4 Лицензии (критично, легко пропустить)

| Компонент | Лицензия | Следствие |
|---|---|---|
| **Readest** | **AGPL-3.0** (проверено по `LICENSE` в main) | форк/производная → наш код обязан быть AGPL-3.0 и отдаваться пользователям по сети. Для закрытого продукта — **нельзя**. Для открытого — можно. |
| **foliate-js** | **MIT** | форкай, закрывай, продавай — можно. |
| Readium | BSD-3 | можно. |
| llama.cpp | MIT | можно. |

**Практический вывод:** «взять Readest как базу» = принять AGPL. «Взять foliate-js как базу» = MIT, но тогда UI/фичи Readest (аннотации, responsive, TTS, pdf) придётся либо писать, либо портировать вручную (портирование кода — тоже производная → AGPL). Это развилка, которую должен решить владелец продукта, а не Scout.

### 5.5 Нативный инференс на Tauri

- Вариант A: Rust-крейты `llama-cpp-2`/`llama-cpp-sys-2` + `cargo-ndk` (Android) и статические либы (iOS). Плюс: один язык с ядром, без JNI. Минус: сборка под 4 ABI, размер, отставание от upstream.
- Вариант B: C++-движок статической либой + тонкий JNI (Kotlin) и Swift FFI — паттерн `ai-offline-translator` (Hy-MT 1.8B 1.25-bit, `translator_engine.hpp` с `loadModel/translate/cancel`). Проверен на Android/macOS, не зависит от Rust-биндингов.
- Вариант C (для десктопа): CTranslate2/OPUS-MT (~150 МБ RAM, десятки мс) как быстрый движок + Hy-MT как «качественный».
- Рекомендация: **B** как основной путь на мобиле (минимум магии, легко отменять по токену), **A** — если команда уже на Rust. ONNX Runtime — через `ort`, если понадобится второй движок.

---

## 6. Риски и митигации

| # | Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|---|
| R1 | Старый Android WebView (<108) ломает вёрстку | Высокая на бюджетных/e-ink | Блокер для части устройств | floor 108 + детект + диалог; in-process upgrade как у Readest; `scrolled` fallback |
| R2 | AGPL Readest | 100%, если форкаем | Юридический блокер | база — foliate-js (MIT); Readest только как референс поведения |
| R3 | Медленная перепагинация на слабом железе | Средняя | UI-лаги | разделы ≤30 КБ, debounce 150–250 мс, без blur/shadow, `contain: layout paint` |
| R4 | OOM при 0.5–1 ГБ модели | Средняя | Краши | mmap, n_ctx 256–512, 2 потока, fallback на меньшую модель/облако |
| R5 | iOS: WKWebView-квирки, App Store (модели нельзя в бандле) | Средняя | Задержка релиза | скачивание модели в Documents, `isExcludedFromBackup`, тесты на iOS 15.4/16/17/26 |
| R6 | SAF/`content://` на Android | Высокая (уже болит у всех) | «Читать на месте» не работает | `plugin-fs` для content://, `tauri-plugin-android-fs` для tree URI, либо копирование в app-dir |
| R7 | Сегментация предложений на сокращениях | Средняя | Кривой перевод/подсветка | пост-правила + таблица сокращений ru/en/de + юнит-тесты на корпусе |
| R8 | Расхождение Chromium/WebKit в `caretRangeFromPoint` | Средняя | long-press мимо | два пути + fallback `elementFromPoint`+offset-эвристика; e2e на обоих движках |
| R9 | foliate-js API нестабилен | Средняя | Боль при обновлении | форк-пин (submodule), свои тесты, минимум правок в upstream-файлах |

---

## 7. Рекомендация (по шагам)

1. **Стек:** Tauri v2 (2.12.x) + React 19 + TS + **форк foliate-js (MIT)**. Ядро на Rust (команды `translate`, `prefetch`, `cache`), движок перевода — C++/llama.cpp статической либой через JNI/Swift FFI.
2. **Читалка:** `foliate-view` как есть; сверху — свой слой: tap-зоны/свайпы (у paginator уже есть `next/prev/snap`), прогресс-бар из `relocate.fraction` + `sections[].size`, темы — CSS-переменные в iframe (`setStyles`) + `filter` на `::part(filter)` для инверсии обложек.
3. **Sentence index:** модуль `src/reader/sentences/` — `buildSectionIndex`, `offsetToRange`, `sentenceAtPoint`, `highlightSentence`, `prefetchAround`; персист в SQLite рядом с кэшем переводов (`task.txt:1187` — схема кэша уже описана, добавить `sentence_index`/`locator`).
4. **Форматы:** EPUB/FB2/TXT/MD в фазе 1; EPUB через `epub.js`, FB2 через `fb2.js` (+ charset fix), TXT/MD — в HTML + синтетические разделы.
5. **Порядок работ:** (a) прототип пагинатора на 3 реальных книгах (ru epub, fb2 cp1251, txt 1 МБ) на целевом слабом Android — замерить reflow/пересчёт/память; (b) sentence index + long-press на одной книге; (c) инференс в Rust/C++ с кэшем; (d) библиотека + SAF; (e) темы/кастомизация.
6. **Стоп-гейт:** если (a) даёт reflow > 400 мс на разделе 30 КБ или WebView < 108 у > 15% целевой аудитории — пересмотреть выбор (Flutter + WebView-остров только для текста, либо нативный Readium Kotlin/Swift).

---

## 8. Открытые вопросы (нужны решения владельца)

1. **AGPL или MIT?** Форк Readest (быстро, AGPL) vs foliate-js (MIT, больше своей работы). Это влияет на всё остальное.
2. **Минимальные версии:** Android + WebView 108? iOS 15.4+? От этого зависит CSS (`:has`, container queries, `dvh`).
3. **iOS в фазе 1?** Нужен Mac + Xcode + review; Tauri iOS-сборка работает, но tooling самый слабый.
4. **RAM-бюджет и модель:** Hy-MT 1.8B/1.25-bit (~440 МБ) на 2 ГБ устройствах — риск OOM. Нужен ли OPUS-MT (~150 МБ) как «эконом» и какой порог переключения?
5. **Библиотека:** «читать на месте» (SAF/bookmarks, сложнее) или копировать в app-dir (проще, но дубль файла)?
6. **Локатор:** канонический offset как primary (моя рекомендация) vs CFI как primary (совместимость с Readest/KOReader-синком). Предлагаю dual-write.
7. **TTS/read-aloud** в scope? Если да — plan Piper/Web Speech + подсветка по sentence index (переиспользуется 1:1).

---

## 9. Источники (проверяемо)

- foliate-js: `paginator.js` (columnize/expand/scrollToPage/afterScroll/snap), `view.js:403` `renderer.getContents()`, `text-walker.js:30` `textWalker`, `overlayer.js:20,34` `getClientRects`, README (форматы, статус API, MIT) — https://github.com/johnfactotum/foliate-js
- Tauri: Webview Versions (обновл. 17 мая 2026) https://v2.tauri.app/reference/webview-versions/ · Tauri 2.12 (26 сен 2026) https://v2.tauri.app/blog/tauri-2.12/ · v2.12.3 (10 окт 2026) https://v2.tauri.app/release/tauri/all-versions/ · Dialog (content:// на Android, нет folder picker) https://v2.tauri.app/plugin/dialog/ · FS (content://, oct 2026) https://v2.tauri.app/plugin/file-system/ и https://v2.tauri.app/release/fs/ · `tauri-plugin-android-fs` FileUri/SAF https://docs.rs/tauri-plugin-android-fs
- Readest: `LICENSE` = AGPL-3.0 (raw.githubusercontent.com/readest/readest/main/LICENSE) · issue #4274 (WebView <108) · PR #4142/#4149 (in-process WebView upgrade) · troubleshooting «Android System WebView is outdated» https://readest.com/docs/troubleshooting · релизы 0.11.x
- Compose Multiplatform: 1.12.2 stable (15 окт 2026), iOS Stable с 1.8 (май 2025) — https://blog.jetbrains.com/kotlin/2026/05/compose-multiplatform-1-11-0/ , https://www.highcircl.com/en/blog/compose-multiplatform
- Readium: Kotlin 3.2.0 (18 мая 2026) https://blog.readium.org/release-note-kotlin-toolkit-version-3-2-0/ · issue #830 (новый Compose-navigator, «mid-2027») https://github.com/readium/kotlin-toolkit/issues/830 · TS 2.14.0 (23 окт 2026), Decorator API (июль 2026) https://blog.readium.org/release-note-readium-typescript-toolkit-july-2026/ , issue #231
- Инференс: `llama_cpp_dart` 0.9 (Android/iOS/macOS, Hexagon NPU) https://github.com/netdur/llama_cpp_dart · `llm_llamacpp` (Android/iOS/macOS/Win/Linux) https://pub.dev/packages/llm_llamacpp · `llama.rn` ≥0.10 (New Architecture) https://github.com/mybigday/llama.rn · `kelegele/ai-offline-translator` (Hy-MT 1.8B 1.25-bit, n_ctx=256) https://github.com/kelegele/ai-offline-translator
- RN/Expo: SDK 56 = RN 0.85, New Arch обязательна, `llama.rn` 0.13-rc (сен 2026) https://mursalinsdesk.com/blog/on-device-llm-react-native-expo-2026 · `deinf/ebook_reader` (epub.js в WebView: нет baseUrl на iOS) https://github.com/deinf/ebook_reader · `@prose-reader/react-native`
- Capacitor/MAUI: Capawesome Capacitor Electron (июль 2026, 80–150 МБ) и Capacitor Tauri (3–10 МБ) https://capawesome.io/docs/sdks/capacitor/electron/ · MAUI: Linux официально нет (9 апр 2026), OpenMaui-превью https://www.michaelblaess.de/en/blog/quo-vadis-dotnet-desktop/
- Intl.Segmenter: Baseline widely available (16 окт 2026), Chrome 87+, Safari 14.1/iOS 14.5+ # [caniuse](https://caniuse.com/wf-intl-segmenter), https://caniwebview.com/features/web-feature-intl-segmenter/

---

*Артефакт: `<project>/docs/planning/04-research-stack.md`. Предыдущий разбор Readest лежит в `task.txt:69-595`; его API-предположение `view.selection` (`task.txt:405`) неверно — см. §2.2.*
