# A2 — Индекс предложений + режим удержания строки

План для @ivan. Всё проверено по коду на коммитах: parent `HEAD`, submodule `packages/foliate-js` = `0c7a0ed`.

Репозитории:
- **SUB** = `packages/foliate-js` (форк `MariganMarigam/foliate-js`, `.gitmodules:2-3`)
- **APP** = `apps/readest-app` (workspace-пакет `foliate-js` подключён как `workspace:*`, `package.json:171` → импорт `foliate-js/<file>.js` работает напрямую, прецедент `src/app/reader/utils/annotatorUtil.ts:1`)

## 0. Что уже есть в коде (переиспользуем, не пишем заново)

| Нужно | Уже есть | Где |
|---|---|---|
| Канонический текст по текстовым узлам + отображение (node, offset) ↔ flat offset | `textWalker()` + `buildCum`/`nodeAt`/`fromFlat` | `SUB/text-walker.js:63-77`, `SUB/search.js:43-71` |
| Точка → (node, offset) в iframe | `getCaretPosition(doc,x,y)` (caretPositionFromPoint → caretRangeFromPoint) | `APP/src/app/reader/utils/crossDocSelection.ts:71-81`; дубль в `useInstantAnnotation.ts:85-95` |
| Точка на тексте, а не на поле | `isTextAtPoint(doc,x,y)` (допуск 12 px) | `crossDocSelection.ts:88-104` |
| iframe-координаты → координаты окна (учитывает `expandedSize` полосы и скролл контейнера) | `toParentViewportPoint(doc,x,y)` | `APP/src/app/reader/utils/annotatorUtil.ts:122-128` |
| Отрисовка поверх iframe без DOM-вставок | `Overlayer.add(key, range, draw, options)`; `#getRects` уже проставляет `rect.page` | `SUB/overlayer.js:203-210`, `183-202`, `pageOf` `SUB/overlayer.js:8-18` |
| Живой overlayer раздела | `renderer.getContents() → [{index, overlayer, doc, contentPages}]` | `SUB/paginator.js:4344-4367`, тип `APP/src/types/view.ts:57-65` |
| Заморозка листания на время жеста | `renderer.scrollLocked` (setter) | `SUB/paginator.js:2524-2529`; прецедент `useTextSelector.ts:576,597` |
| Готовый попап перевода | `TranslatorPopup` (props `text/position/trianglePosition/popupWidth/popupHeight/onDismiss`) | `APP/.../annotator/TranslatorPopup.tsx:31-39` |
| Кэш переводов + `translate([...])` | `useTranslator().translate(input, {useCache})` **всегда читает локальный кэш и всегда пишет в него** | `APP/src/hooks/useTranslator.ts:61-124`, `169-180`; `src/services/translators/cache.ts:147-161, 202-208` |
| Позиционирование/клэмп попапа | `getPopupPosition(pos, bounds, w, h, pad)`, `getPopupBounds`, `getPosition` | `APP/src/utils/sel.ts:429-470`, `288-296` |
| Обёртка `Popup` с треугольником (`dir:'up'` = попап над точкой) | `APP/src/components/Popup.tsx:6-40` | |
| Точки вставки pointer-событий в iframe | `Annotator.onLoad` вешает `pointerdown/move/up/cancel` на `detail.doc` | `APP/.../annotator/Annotator.tsx:761-764` |
| Документ следующего раздела без навигации | `book.sections[i].createDocument()` | `SUB/view.js:577`, `618` |

**Вывод:** правки движка сводятся к **одному новому файлу** `SUB/text-index.js`. Ни `paginator.js`, ни `overlayer.js` менять не нужно: координаты внутри iframe уже совпадают с координатами SVG-оверлея (`expand()` синхронизирует их размеры, `paginator.js:1241-1253`), и `rect.page` уже содержит тайл страницы.

## 1. Архитектурные решения (зафиксированы, не обсуждаются при реализации)

1. **Индекс строится в движке, кэшируется в приложении.** Движок даёт чистую функцию без DOM-геометрии (тестируется в jsdom), приложение владеет жизненным циклом и локалью.
2. **Единица индекса — отрендеренный Document (chunk), а не spine index.** У одной секции может быть несколько chunk-документов (`paginator.js:4354-4363`). Ключ кэша: `WeakMap<Document, string>` + `Map<sectionHash, Entry>` LRU(8).
3. **Жест живёт в `useTextSelector.ts`**, а не в отдельном слушателе: этот хук уже владеет pointerdown/move/up/cancel, латчем клика (`isUpToPopup`, `1340-1342`) и снятием `scrollLocked`. Новый код — отдельный хук `useSentenceHold`, вызываемый оттуда (по образцу `useInstantAnnotation`, вызываемого на `475-489`).
4. **Подсветка — через `overlayer.add('sentence-hold', range, draw, opts)`**, а не через отдельный host-DOM div. Причины: (а) автоматически живёт внутри транслируемого контейнера и не «съезжает» на листании; (б) `redraw()` вызывается при `expand()` (`paginator.js:1247-1253`) — переживает ре-лейаут; (в) `rect.page` уже посчитан.
5. **Попап — существующий `TranslatorPopup`**, позиция считается в host-DOM из координат первой строки.
6. **Взаимное исключение с instant annotation:** если `isInstantAnnotationEnabled() === true` (`useInstantAnnotation.ts:62-68`), удержание строки **не** вооружается. UI настроек обязан показывать их как взаимоисключающие; runtime-guard обязателен.

## 2. Модуль 1 (SUB, новый файл): `packages/foliate-js/text-index.js`

Оценка: **M**. Чистый ESM, без импортов, без геометрии.

### 2.1 Константы

```js
const REJECT_TAGS = new Set(['script','style','rt','rp','noscript','svg','math'])
const BREAK_TAGS = new Set(['br','hr','p','div','li','h1','h2','h3','h4','h5','h6',
  'blockquote','tr','td','th','section','article','pre','figure','figcaption',
  'aside','header','footer','dt','dd','ul','ol','table'])
const SEG_MIN_CHARS = 40          // сегмент короче — склеиваем с соседом
const MAX_RECTS = 400             // защита от патологических Range
const ABBREV_EN = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|Fig|No|Vol|pp|al|cf)|\be\.g|\bi\.e|\betc)\.$/i
const ABBREV_RU = /(?:\b(?:т\.\s?е|т\.\s?д|т\.\s?к|г|гг|стр|рис|см|др|им|проф|акад|тов|руб|млн|млрд|тыс|ул|пер|кв|обл|респ|н\.\s?э|вв)\.|[А-ЯЁA-Z]\.|[А-ЯЁ]\.\s?[А-ЯЁ]\.)$/u
```

### 2.2 `export const buildTextIndex = (root, { locale = 'en' } = {}) => TextIndex`

Возвращает:
```ts
{
  text: string,                                   // канонический текст, raw (без нормализации пробелов)
  nodes: Array<{ node: Text; start: number; end: number }>, // start/end — UTF-16 offset в text
  nodeMap: Map<Node, { start: number; end: number }>,        // для O(1) offsetFromPosition
  breaks: number[],                               // отсортированные offset-границы (длина текста на момент разрыва)
  sentences: Array<[number, number]>,             // [start, end) в text, отсортированы, непересекающиеся
  hash: string,                                   // FNV-1a 32-bit от text, hex
  locale: string
}
```

Псевдокод:
1. `const doc = root.ownerDocument ?? root`; `walker = doc.createTreeWalker(root, SHOW_ELEMENT|SHOW_TEXT|SHOW_CDATA_SECTION, {acceptNode})`.
   `acceptNode`: tag в `REJECT_TAGS` → `FILTER_REJECT`; tag в `BREAK_TAGS` → `FILTER_ACCEPT`; прочие элементы → `FILTER_SKIP`; текстовые → `FILTER_ACCEPT`.
   ⚠️ `acceptNode` из `SUB/text-walker.js:44-51` **не** переиспользуется: он отдаёт `FILTER_SKIP` всем элементам, поэтому `<br>`/`<p>` не попадут в обход и границы зафиксировать негде.
2. `let len = 0`; цикл `while (n = walker.nextNode())`:
   - element → `breaks.push(len)`; `continue`
   - text → если `nodeValue.length === 0` пропустить; `nodes.push({node, start: len, end: len + v.length})`, `nodeMap.set(node, entry)`, `text += v`, `len += v.length`.
3. `locale = root.lang || doc.documentElement.lang || 'en'` (прецедент `SUB/search.js:302`).
4. `sentences = segment(text, breaks, locale)` (2.3).

### 2.3 `const segment = (text, breaks, locale) => Array<[number, number]>`

1. `const raw = segments(text, locale)` — `Intl.Segmenter(locale, {granularity:'sentence'})` → `[seg.index, seg.index+seg.segment.length)`. Fallback при отсутствии `Intl.Segmenter`: `/(?<=[.!?…])\s+/u` разбиением (тот же guard ниже).
2. **Разрезать по `breaks`:** для каждого сегмента, для каждого `b` из `breaks` с `start < b < end` → `[start,b]`, `[b,end]`.
3. **Trim:** сдвигать `start` вперёд, `end` назад, пока `/\s/` — **только смещением offsets**, текст не трогать (иначе offsets перестанут совпадать с DOM). Пустые — выбросить.
4. **Аббревиатуры:** идём с конца; если `ABBREV_EN.test(text.slice(start, end))` или `ABBREV_RU.test(...)` **и** между `end` и началом следующего сегмента нет `b ∈ breaks` → слить со следующим.
5. **Склейка коротких:** если `end - start < SEG_MIN_CHARS` и есть следующий, и между ними нет `b ∈ breaks` → слить вперёд. Повторять, пока не стабильно.
6. Вернуть массив.

Инварианты (проверяются тестом): `sentences[i][1] === sentences[i+1][0]` не обязательно (могут быть пробелы), `sentences` возрастают, ни одна граница не лежит внутри `breaks`-пары запрещённым образом, `sentences.every(([s,e]) => break inside → false)`.

### 2.4 `export const rangeFromOffsets = ({ nodes }, start, end) => Range`

1. `nodeAt(nodes, offset)` — бинарный поиск наибольшего `i` с `nodes[i].start <= offset` (ровно как `SUB/search.js:44-56`); `offset` за пределами → клампить в `[0, text.length]`; `nodes` пуст → `null`.
2. `range = doc.createRange(); range.setStart(nodes[si].node, start - nodes[si].start); range.setEnd(nodes[ei].node, end - nodes[ei].start)`.
3. `doc` берётся из `range.startContainer.ownerDocument` (узлы живого документа).
4. `end <= start` → вернуть `null` (вызывающий не рисует).

### 2.5 `export const offsetFromPosition = (index, node, offset) => number`

1. `index.nodeMap.get(node)` → `start + clamp(offset, 0, len)`.
2. node — элемент: обойти `node.childNodes` начиная с `offset` вперёд; первый текстовый потомок, присутствующий в `nodeMap` (искать рекурсивно по `nodeMap.has`, а не `textContent`) → его `start`. Не нашли — назад → его `end`.
3. Иначе `-1`.

### 2.6 `export const sentenceAt = (index, offset) => number`

Бинарный поиск: `i` с `sentences[i][0] <= offset < sentences[i][1]`; если offset в промежутке между предложениями — вернуть ближайшее предыдущее; вне текста → `-1`.

Оценка: **M** (≈180 строк).

## 3. Модуль 2 (APP, новый): `src/app/reader/utils/sentenceIndex.ts`

Оценка: **S**. Только кэш + доступ к live-документу.

```ts
export interface DocSentenceIndex extends ReturnType<typeof buildTextIndex> {}
export const getDocIndex = (doc: Document): DocSentenceIndex;            // WeakMap<Document, Entry>, синхронно
export const getSectionEntry = (view: FoliateView, spineIndex: number):
  { doc: Document; overlayer?: OverlayerLike; index: DocSentenceIndex } | null;
export const primeSection = (view: FoliateView, spineIndex: number): Promise<DocSentenceIndex | null>; // createDocument
export const clearSentenceIndexCache = (): void;                          // для тестов и close()
```

Псевдокод:
1. `const byDoc = new WeakMap<Document, DocSentenceIndex>()` (GC сам уберёт закрытые разделы).
2. `getDocIndex(doc)`: `byDoc.get(doc)` → вернуть; иначе `entry = buildTextIndex(doc.body, {locale})`, `byDoc.set`, плюс `lru.set(`${entry.hash}`, entry)` с ограничением 8 (вытеснение по вставке).
3. `getSectionEntry(view, spineIndex)`: `view.renderer?.getContents?.() ?? []` → найти `c.index === spineIndex && c.doc`; если `overlayer` нет — вернуть `overlayer: undefined` (вызывающий подписывается на `create-overlayer`, см. `Annotator.tsx:779`).
4. `primeSection`: `const section = view.book?.sections?.[spineIndex]; const doc = await section.createDocument();` (прецедент `SUB/view.js:577`) → `getDocIndex(doc)`. `doc` детач, `nodeMap` из него валиден только для чтения text/sentences; `rangeFromOffsets` на нём не вызывать.
5. Ошибки: любой throw → `console.warn('[sentence-index]', e)` один раз на раздел, вернуть `null`. Никаких исключений наружу.

## 4. Модуль 3 (APP, новый): `src/app/reader/utils/sentenceHighlight.ts`

Оценка: **S**.

```ts
export interface LineRect { left: number; top: number; right: number; bottom: number;
  width: number; height: number; page?: { left: number; top: number; right: number; bottom: number } }
export const groupLineRects = (rects: LineRect[], tolerance?: number /* =2 */): LineRect[];
export const drawSentenceHighlight = (rects: LineRect[],
  options: { color: string; padLeft: number; padRight: number; padY?: number /* =2 */; radius?: number /* =4 */ }
): SVGGElement;
export const showSentenceHighlight = (view: FoliateView, spineIndex: number, range: Range): boolean;
export const hideSentenceHighlight = (view: FoliateView, spineIndex: number): void;
```

Псевдокод:
1. `groupLineRects`: отфильтровать `width > 0 && height > 0`; отсортировать по `top`; жадно группировать, пока `|центрY(rect) − центрY(current group)| <= tolerance`; в группе `left=min, top=min, right=max, bottom=max`; `page` — от первого rect группы. Кап `MAX_RECTS` (400).
2. `drawSentenceHighlight`: `const g = document.createElementNS(svgNS,'g')`, `fill = options.color`, `opacity = 0.35`, `pointer-events = 'none'`. Для каждой линии: если `line.page` есть → `x = page.left + padLeft`, `right = page.right - padRight`; иначе (scrolled без тайлинга) → `x = line.left - padLeft`, `right = line.right + padRight`. `rect(x, line.top - padY, right - x, line.height + 2*padY, rx=radius)`.
   ⚠️ Растяжка до края колонки законна потому, что root-бокс документа ровно тайлит страницы: `columnize` ставит `documentElement.width = columnSize` (`paginator.js:1246`), а `pageOf` (`overlayer.js:8-18`) считает от `documentElement.getBoundingClientRect()`. Паддинг колонки читается из computed style `documentElement.paddingLeft/Right`, который сам движок и выставляет (`paginator.js:1028-1035`) → кастомные темы учтены.
3. `showSentenceHighlight`: `getSectionEntry(view, spineIndex)`; если `overlayer` нет → вернуть `false`; `padLeft/padRight` из `getComputedStyle(doc.documentElement)`; `overlayer.add('sentence-hold', range, drawSentenceHighlight, {color, padLeft, padRight})`; вернуть `true`. `options` передаются в `draw` движком (`overlayer.js:207`).
4. `hideSentenceHighlight`: `overlayer.remove('sentence-hold')`; отсутствие — no-op (`overlayer.js:211-215`).

## 5. Модуль 4 (APP, новый): `src/app/reader/hooks/useSentenceHold.ts`

Оценка: **M**. Хук владеет конечным автоматом жеста; слушатели **не** вешает (см. §6).

```ts
const HOLD_MS = 400           // требование: 350–450
const HOLD_SLOP_PX = 8
const SWITCH_RATIO = 0.8      // доля высоты строки
const SWITCH_DEBOUNCE_MS = 120

export interface SentenceHoldState {
  index: number; sentenceIdx: number; text: string;
  anchor: { x: number; top: number; bottom: number };  // window-координаты
  ready: boolean;                                        // трансляция пришла
  translation: string | null; error: string | null;
}
export const useSentenceHold = (bookKey: string) => {
  arm(doc: Document, index: number, ev: PointerEvent): void
  onMove(doc: Document, ev: PointerEvent): void
  end(doc: Document, index: number, ev?: PointerEvent): boolean
  cancel(): void
  dismiss(): void
  state: SentenceHoldState | null
}
```

Внутренние refs: `press` (`{doc,index,pointerId,x,y,window:{x,y}}`), `timer`, `active` (`{doc,index,sentenceIdx,range,rects,lines}`), `generation` (number), `lastSwitchAt`, `rafPending`, `prefetched` (Set<string>).

Переходы:
1. `arm`: если `isInstantAnnotationEnabled()` (через `getViewSettings(bookKey)`, образец `useInstantAnnotation.ts:62-68`) → выход. `press = {...}`; `timer = setTimeout(engage, HOLD_MS)`.
2. `onMove` (rAF-коалесценция: `if (rafPending) return; rafPending = true; requestAnimationFrame(...)`):
   - `!active`: `hypot(now − press.window) > HOLD_SLOP_PX` → `cancel()` (листание не тронуто: `preventDefault` не вызывался — `useTextSelector.ts:619-620`).
   - `active`: см. 5.
3. `engage` (колбэк таймера):
   1. `pos = getCaretPosition(press.doc, press.x, press.y)`; `null`/не TEXT → `cancel()`.
   2. `entry = getSectionEntry(view, press.index)`; нет → `cancel()`.
   3. `off = offsetFromPosition(entry.index, pos.node, pos.offset)`; `-1` → `cancel()`.
   4. `si = sentenceAt(entry.index, off)`; `-1` → `cancel()`. **Разрешить только `isTextAtPoint`-попадания? Нет** — здесь уже есть caret; допуск не нужен (допуск был нужен до caret).
   5. `range = rangeFromOffsets(entry.index, s, e)`; `null` → `cancel()`.
   6. `view.renderer.scrollLocked = true` (прецедент `useTextSelector.ts:576`).
   7. `showSentenceHighlight(...)`; `active = {...}`; `setState(...)`; `requestTranslation(si)`.
4. `end`: `clearTimeout(timer)`; `!active` → `false`. Иначе `view.renderer.scrollLocked = false`; **подсветку и попап не снимать** (их снимает `dismiss`); вернуть `true`.
5. `onMove` при `active`:
   1. `lineH = rects[0].height`; `top = min(top)`, `bottom = max(bottom)` первой/последней линии активного range (iframe-координаты).
   2. `y = ev.clientY`. `if (y < top − SWITCH_RATIO*lineH) next = si−1`; `else if (y > bottom + SWITCH_RATIO*lineH) next = si+1`; иначе `return`.
   3. Клампить `next` в `[0, sentences.length−1]`. Если `next === si` → граница раздела: `primeSection(view, index+1)` (или `index−1` при `si === 0`), `return` (подсветка стоит на последнем/первом предложении).
   4. `if (now − lastSwitchAt < SWITCH_DEBOUNCE_MS) return;` (иначе — отложить `setTimeout` на остаток).
   5. `si = next`; `range = rangeFromOffsets(...)`; `overlayer.add('sentence-hold', range, ...)` (сам `add` удаляет старый ключ, `overlayer.js:204`); `requestTranslation`.
6. `requestTranslation(si)`:
   1. `const gen = ++generation`.
   2. `const text = index.text.slice(s, e)`; если `prefetched.has(text)` → ждать кэш не нужно, но всё равно `await translate([text], {useCache:true})` (попап прочитает локальный кэш, `useTranslator.ts:88-100`).
   3. `translate([text], { useCache: true })` через `useTranslator` (тот же хук, что в `TranslatorPopup.tsx:77-84`: `provider`, `sourceLang`, `targetLang`, `promptId`, `bookTitle`, `bookAuthor`).
   4. После резолва: `if (gen !== generation) return;` → `setState`.
   5. Ошибка: `catch` → `if (gen !== generation) return;` `setState({...error})`, без toast (попап покажет текст ошибки).
   6. Через 250 мс простоя — `[si−1, si+1].filter(valid)` → `translate([t], {useCache:true}).catch(()=>{})`; `prefetched.add(t)`. Свой `translate`-вызов кэширует результат (`useTranslator.ts:124-133`), поэтому попап при переключении не ходит в сеть.
7. `cancel`: `clearTimeout`, `active = null`, `generation++`, `scrollLocked = false`, `hideSentenceHighlight`.
8. `dismiss`: как `cancel`, плюс `setState(null)`.
9. `useEffect` cleanup / смена `bookKey`: `cancel()`.

Границы раздела: `primeSection` — единственный «префетч раздела»; полноценная догрузка соседнего view — **Out of scope** (§13), т.к. публичного API у `#loadAdjacentSection` нет и трогать `#filling`-флаги пагинатора рискованно.

## 6. Точки вставки в существующий код (точные)

### 6.1 `APP/src/app/reader/hooks/useTextSelector.ts` (MODIFY)

| Что | Где |
|---|---|
| Импорт `useSentenceHold` рядом с `useInstantAnnotation` | после `:26` |
| Инстанциация + деструктуризация `{ arm, onMove, end, cancel, state }` | рядом с `:475-489` |
| Вооружение жеста | в `handlePointerDown`, **после** блока instant-annotation (`:770-785`), перед cross-page drag (`:789`): `if (!isInstantAnnotating.current) arm(doc, index, ev)` |
| Отмена/драг | в `handlePointerMove` после `maybeCancelInstantHoldOnMove()` (`:834`) → `onMove(doc, ev)` |
| Завершение | в `handlePointerUp` (`:1055`), **до** блока `isInstantAnnotating` (`:1093`): `if (end(doc, index, ev)) { isUpToPopup.current = true; return; }` |
| Android native-touch | в `handleNativeTouchMove` (`:906-910`) → `onMove(doc, {clientX: x/dpr, clientY: y/dpr})` не нужен: без активного `press` функция no-op; достаточно `cancel()` в `handleNativeTouchEnd`-пути |
| Отмена | в `handlePointerCancel` рядом с `cancelInstantHold()` (`:937`), в `handleTouchCancel` (`:1208`), в `handleTouchEnd` (`:1188-1192`) |
| Проброс наружу | в возвращаемый объект (`:1401-1429`): `sentenceHoldState: state, dismissSentenceHold: dismiss` |

Почему это не ломает листание (проверено):
- До срабатывания таймера мы **не вызываем** `preventDefault` — свайп уходит в пагинатор как обычно (та же логика, что в `armInstantHold`, комментарий `:618-624`).
- `HOLD_SLOP_PX = 8 <` пагинаторного `DRAG_TURN_DISTANCE_RATIO = 0.06` ширины (`SUB/paginator.js:223`) — сдвиг на 8 px не может перелистнуть (`:2632-2636`).
- После срабатывания `scrollLocked = true` → `#onTouchMove` выходит на `SUB/paginator.js:2776-2779` **до** накопления `state.dx`, поэтому `#touchScrolled` остаётся `false` и `#onTouchEnd` (`:3166-3171`) не вызывает `snap` — листания не будет.
- Отдыхающий палец не даёт инерции: `state.vx` обнуляется при паузе > 80 мс (`SUB/paginator.js:3182-3185`).

### 6.2 `APP/src/app/reader/components/annotator/Annotator.tsx` (MODIFY)

1. Взять `sentenceHoldState`/`dismissSentenceHold` из `useTextSelector` (деструктуризация рядом с `:515-524`).
2. Размеры (рядом с `:277-292`):
   ```ts
   const sentencePopupWidth = Math.min(360, window.innerWidth - 32);
   const sentencePopupHeight = Math.min(265, maxHeight);
   ```
3. Позиция (мемо на `sentenceHoldState`):
   ```ts
   const bounds = document.querySelector(`#gridcell-${bookKey}`)?.getBoundingClientRect();
   const above = state.anchor.top - 8 - sentencePopupHeight >= popupPadding;
   const point = { x: state.anchor.x, y: above ? state.anchor.top - 8 : state.anchor.bottom + 8 };
   const dir: Position['dir'] = above ? 'up' : 'down';
   const trianglePosition = { point, dir };
   const position = getPopupPosition({ point, dir }, bounds, sentencePopupWidth, sentencePopupHeight, popupPadding);
   ```
   `state.anchor` уже в window-координатах (`toParentViewportPoint`, `annotatorUtil.ts:122-128`), поэтому `offsetPosition(..., origin)` из `:405-409` не нужен; `getPopupBounds` — из `:366-370`, если включён iPhone-Duo клэмп.
4. Рендер (рядом с существующим `showDeepLPopup`-блоком `:2770-2780`):
   ```tsx
   {sentenceHoldState && sentencePopupPosition && (
     <TranslatorPopup bookKey={bookKey} text={sentenceHoldState.text}
       position={sentencePopupPosition} trianglePosition={sentenceTriangle}
       popupWidth={sentencePopupWidth} popupHeight={sentencePopupHeight}
       onDismiss={dismissSentenceHold} />
   )}
   ```
5. `sentenceHoldState.ready === false` → попап всё равно рендерится: `TranslatorPopup` сам показывает «Loading…» (`TranslatorPopup.tsx:122-163, 224-226`). Дублирующий запрос не страшен — локальный кэш уже прогрет (§5.6).
6. Скрывать при смене `sentenceHoldState.index` на другой раздел → `dismissSentenceHold()` в `useEffect`.

### 6.3 `APP/src/types/book.ts` (MODIFY)

В `TranslatorConfig` (`:457-462`) добавить:
```ts
  /** Долгое удержание строки открывает перевод предложения (A2). */
  sentenceTranslateEnabled?: boolean;
```
`ViewSettings` уже наследует `TranslatorConfig` (`:571-579`), запись — через `saveViewSettings(envConfig, bookKey, 'sentenceTranslateEnabled', v, true, false)` (образец `TranslatorPopup.tsx:88`).

## 7. Подсветка: сводка поведения

- Источник истины — `overlayer` раздела; ключ `'sentence-hold'` (один на книгу: активная строка одна).
- Перерисовка: `overlayer.add` сам снимает старый ключ (`overlayer.js:204`), `redraw()` при ресайзе/смене темы уже вызывается движком (`paginator.js:1247-1253, 4386`).
- Если `overlayer` ещё не создан (первый кадр) → `showSentenceHighlight` вернул `false`; подписаться один раз на `create-overlayer` (событие уже слушает `Annotator.tsx:779`) и повторить; если и это не помогло — показывать попап без подсветки, один `console.warn`.
- Вертикальное письмо (`viewSettings.vertical`): растяжка по `top/bottom` вместо `left/right` — реализовать ветвлением по `view.renderer?.scrollProp === 'scrollTop'`; в A2 допускается **не** поддерживать и просто не показывать подсветку при `vertical === true` (попап работает). Решение зафиксировано: подсветка только для горизонтальных книг.

## 8. Производительность (бюджеты, измеряемые)

| Операция | Бюджет | Где мерить |
|---|---|---|
| `buildTextIndex` на 30 КБ текста (~3–5k текстовых узлов) | ≤ 8 мс desktop, ≤ 25 мс Android (4 ГБ) | `performance.measure('sentence-index')` под `if (process.env.NODE_ENV !== 'production')` |
| `Intl.Segmenter` sentence на 30 КБ | ≤ 6 мс | там же, отдельная метка |
| `getClientRects` на предложении | ≤ 1 мс; ровно **1** вызов на перерисовку | тест считает вызовы (см. §9) |
| `pointermove` | ≤ 1 обработчик на кадр (rAF-коалесценция), 0 layout-чтений вне rAF | код-ревью + тест на счётчик rAF |
| Переключение предложения (перерисовка+запрос) | ≤ 16 мс p95 до появления подсветки | ручной замер, `scripts/bilireader-run.sh` |
| Память | индекс на раздел ≤ 12× размера текста; LRU 8 разделов | оценка в ревью |

Полный индекс раздела строится **лениво** — только при первом удержании в этом разделе (или при `primeSection`). Никакого фонового построения по всем разделам.

## 9. Тесты (без GUI)

Все — `vitest` в APP (`pnpm test`), jsdom. Прецеденты: `src/__tests__/foliate-paginator-a11y.test.ts:1-40` (импорт из `foliate-js/*.js` напрямую), `src/__tests__/app/reader/hooks/useTextSelector-instantHold.test.ts` (фейковые таймеры + заглушка doc), `src/__tests__/utils/sel.test.ts:207` (стаб `getClientRects`).

### 9.1 `APP/src/__tests__/foliate-text-index.test.ts` (NEW)

`buildTextIndex` на документах из `document.implementation.createHTMLDocument`:
1. «таблица смежна»: `nodes[i].end === nodes[i+1].start`, сумма длин === `text.length`.
2. `rangeFromOffsets(idx, s, e).toString() === idx.text.slice(s, e)` для 20 случайных пар (round-trip на реальном фрагменте ru/en).
3. `rangeFromOffsets` → `null` при `s === e` и при пустом `nodes`.
4. Сегментация ru: `«Он пришёл, т.е. явился. Потом ушёл.»` → 2 предложения (без разрыва на `т.е.`).
5. Сегментация en: `'Mr. Smith paid 5.5 dollars. Then left.'` → 2 (без разрыва на `Mr.` и на `5.5`).
6. Инициалы: `'А. С. Пушкин писал. Потом читал.'` → 2.
7. `<br>`: `'Первая часть<br>вторая часть.'` → ни одно предложение не содержит обе части; `breaks` содержит offset стыка.
8. `<p>a</p><p>b</p>` → два предложения даже при коротком тексте (`SEG_MIN_CHARS`).
9. Склейка коротких: `'Да. Нет. Ну хорошо, поехали дальше по тексту.'` → первое и второе слиты, но не через `<br>`.
10. `offsetFromPosition`: TEXT-узел + k → `start + k`; ELEMENT-узел (между `<b>`/`<i>`) → `start` следующего текстового узла; узел вне индекса → `-1`.
11. Суррогатная пара: текст с emoji — длина в code units, offsets не разрывают пару (`text.slice` даёт целый эмодзи).
12. `hash` стабилен между двумя сборками одного документа.

### 9.2 `APP/src/__tests__/app/reader/utils/sentenceHighlight.test.ts` (NEW)

1. `groupLineRects` — rect'ы с разницей центров 2 px → одна линия; 3 px → две.
2. `groupLineRects` отбрасывает `height === 0` и `width === 0`.
3. `drawSentenceHighlight` на 3 линиях с `page = {left:0, right:400, ...}`, `padLeft = 20`, `padRight = 20` → 3 `<rect>`, каждый `x = 20`, `width = 360`, `pointer-events = 'none'`.
4. Без `page` (scrolled) → растяжка от `line.left - padLeft` до `line.right + padRight`.
5. `showSentenceHighlight` без `overlayer` → `false`, без исключений.

### 9.3 `APP/src/__tests__/app/reader/hooks/useSentenceHold.test.ts` (NEW)

Моки как в `useInstantAnnotation.test.ts:10-52` (`useEnv`, `settingsStore`, `bookDataStore`, `readerStore` с `view.renderer = {scrollLocked:false, getContents}`). `vi.useFakeTimers()`.
1. `arm` + `advanceTimersByTime(399)` → состояние `null`, `scrollLocked === false`.
2. `arm` + move на 9 px + `advanceTimersByTime(400)` → `null` (отмена), `scrollLocked === false`.
3. `arm` + `advance(400)` → `scrollLocked === true`, `showSentenceHighlight` вызван 1 раз, `translate` вызван с текстом активного предложения.
4. Устаревший ответ: два переключения, первый промис резолвится позже → `state.text` соответствует второму, первый отброшен (generation).
5. Драг: `y > bottom + 0.8*lineHeight` → `sentenceIdx + 1`; `y` внутри допуска → без изменений; повтор в пределах 120 мс → отложено.
6. `end` → `true` и `scrollLocked === false`.
7. `cancel` (pointercancel) → `scrollLocked === false`, `hideSentenceHighlight` вызван, `state === null`.
8. Префетч: после `advance(250)` вызваны `translate` для `si−1` и `si+1`; повторный `advance(250)` без смены предложения — повторных вызовов нет (`prefetched`).
9. Граница раздела: `si === last` и драг вниз → `primeSection` вызван с `index+1`, `sentenceIdx` не меняется.

### 9.4 Проверка без GUI

```bash
cd apps/readest-app
pnpm test --run src/__tests__/foliate-text-index.test.ts \
  src/__tests__/app/reader/utils/sentenceHighlight.test.ts \
  src/__tests__/app/reader/hooks/useSentenceHold.test.ts
pnpm lint          # biome + tsc
```
Ручная проверка (по AGENTS.md: без сборки релиза): `scripts/bilireader-run.sh`.

## 10. Порядок коммитов (каждый — рабочий и зелёный)

| # | Репо | Содержимое | Проверка |
|---|---|---|---|
| C1 | SUB | `text-index.js` (только новый файл, никем не импортируется) | `node --input-type=module -e "import('./packages/foliate-js/text-index.js').then(m=>console.log(Object.keys(m)))"` из корня |
| C2 | parent | bump указателя подмодуля + `src/__tests__/foliate-text-index.test.ts` | `pnpm test --run src/__tests__/foliate-text-index.test.ts` |
| C3 | APP | `utils/sentenceIndex.ts` + тесты кэша (в 9.1 добавить 2 кейса) | тот же прогон |
| C4 | APP | `utils/sentenceHighlight.ts` + `sentenceHighlight.test.ts` | прогон 9.2 |
| C5 | APP | `hooks/useSentenceHold.ts` + `sentenceHold.test.ts` + флаг в `types/book.ts` | прогон 9.3 |
| C6 | APP | wiring: `useTextSelector.ts`, `Annotator.tsx` | `pnpm lint` + все три файла тестов + ручная проверка |
| C7 | APP | `docs/` запись о фиче (или AGENTS.md, если так принято) | — |

### 10.1 Обновление указателя подмодуля

```bash
# 1) в подмодуле
cd packages/foliate-js
git checkout -b feat/text-index            # если ещё не на ветке
git add text-index.js
git commit -m "feat(text-index): canonical text table and sentence segmentation"
git push -u origin feat/text-index
# 2) в родителе
cd ../..
git add packages/foliate-js
git commit -m "chore(foliate): bump foliate-js for text-index"
git push
```
Правила: указатель в parent обновляется **только** после пуша в `MariganMarigam/foliate-js` (`.gitmodules:2-3`), иначе у других агентов/CI сабмодуль не разрешится. Если ветка подмодуля не влита в его `main` — в сообщении C2 указать хеш сабмодуля.

## 11. Риски (по убыванию)

1. **Гонка жеста с конечным автоматом пагинатора на Android WebView.** `pointercancel` приходит, когда вебвью забирает тач под скролл (`useTextSelector.ts:934-947`), а `#onTouchMove` успевает накопить `dx` до `scrollLocked`. Митигация: `scrollLocked` ставится в том же тике, что и подсветка; `cancel` на `pointercancel`/`touchcancel`/native-release; никакого `preventDefault` до срабатывания таймера; отдельный тест 9.3.7. Остаточный риск: медленное устройство может «проглотить» первый пиксель драга — поведение идентично уже отгруженному instant-hold, т.е. регрессии не будет, но и идеала не будет.
2. **Расхождение канонического текста и DOM.** `rt/rp` (ruby), soft-hyphen, PDF text-layer, ре-рендер раздела между построением индекса и использованием → подсветка «не туда». Митигация: `REJECT_TAGS`, `WeakMap` по Document, `hash` в ключе кэша, `rangeFromOffsets → null` при любом несоответствии (лучше не подсветить, чем подсветить неверно), запрет на подсветку при `viewSettings.vertical`.
3. **Предположение о геометрии колонки.** Растяжка до `page.right - padRight` опирается на то, что `documentElement` ровно тайлит страницы и паддинг рут-элемента = поля страницы. Это верно для `columnize` (`paginator.js:982-1051`), но ломается при кастомном CSS книги, переопределяющем `padding` на `html` с `!important`… (движок ставит `setStylesImportant`, так что риск низкий). Митигация: читать паддинг из computed style, клампить `right > x`, кап `MAX_RECTS`, при `page` отсутствии — деградировать до растяжки по самой линии.

Плюс архитектурный риск, снятый решением: **конфликт с instant annotation** — снимается взаимным исключением в `arm` (§5.1) и требованием к UI настроек.

## 12. Открытые вопросы, требующие решения @oscar (не @ivan)

1. Нужен ли переключатель в UI в этой итерации, или флаг включается только через настройки разработчика? План работает в обоих случаях (флаг `sentenceTranslateEnabled`).
2. Разрешать ли жест мышью (desktop) сразу, или только touch/pen в первом релизе? План: разрешать все типы, при условии `!isInstantAnnotationEnabled()`; если решат иначе — одна строка в `arm`.

## 13. Out of scope (явно)

- Полноценная догрузка соседнего раздела во view (публичный `preloadAdjacent` в `paginator.js`) — не делаем: приватный `#loadAdjacentSection` завязан на `#filling`/`#isSameDirection` (`paginator.js:1782-1790`), риск сломать префетч выше пользы. Вместо этого — `createDocument()` для индекса.
- Подсветка в вертикальном письме.
- Перевод абзаца целиком, TTS-интеграция, сохранение истории переводов.
- Правки `overlayer.js` и `paginator.js` — не требуются (проверено: `rect.page` уже есть, `options` уже пробрасываются, `scrollLocked` уже публичный).

## 14. Итог

- **Файлов:** 1 новый в `packages/foliate-js`; 3 новых модуля + 3 теста + 3 модификации в `apps/readest-app` = **9 файлов APP, 1 файл SUB**.
- **Порядок:** C1 (SUB) → C2 (bump+тесты) → C3 → C4 → C5 → C6 → C7.
- **Confidence:** 0.85 — движок и подсветка проверены построчно; остаточная неопределённость в поведении тач-событий на Android WebView (риск 1) и в UX-решении по мыши (§12).
