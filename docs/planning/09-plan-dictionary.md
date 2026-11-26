# A4 — офлайн-словарь en→ru: источники, пайплайн, схема, вердикт

Дата: 2026-11-26. Агент: Scout. Только факты, проверенные по сети и локальными замерами; всё, что измерено руками, помечено **[ИЗМЕРЕНО]**, оценки — **[ОЦЕНКА]**.

Проверка актуальности: kaikki/Wiktextract дамп от 2026-10-01 (extract 2026-10-30), WikDict сборка `2_2026-06` (23.06.2026), FreeDict `2025.11.23`, Debian sid `dict-freedict-eng-rus 2024.11.01-2` (59 433 headwords — старая сборка, актуальная 62 181).

---

## 0. TL;DR

| Вопрос | Ответ |
|---|---|
| Источник | **FreeDict eng-rus (= FreeDict+WikDict, данные Wiktionary через DBnary)** |
| Лицензия | **CC BY-SA 3.0** (коммерческое использование и модификация разрешены, обязательны атрибуция + ShareAlike на сам словарь) |
| Готовый файл | StarDict 4.0 МБ / SLOB 8.2 МБ / dictd 5.3 МБ / TEI 8.2 МБ (xz) |
| Своя SQLite | **26.7 МБ** с IPA, POS, 84 188 senses, 143 405 переводами, индексами **[ИЗМЕРЕНО]** |
| Скорость | **25 µs** на lookup по индексам; 46 ms при отсутствии одного индекса **[ИЗМЕРЕНО]** |
| Лемматизация | Уже есть в репозитории: `apps/readest-app/src/services/dictionaries/lemmatize/english.ts` — писать нечего |
| Часы | MVP-словарь 8–12 ч; + SRS 16–22 ч |

---

## 1. Источники: сравнение

### 1.1 FreeDict `eng-rus` (рекомендуемый)

- **URL**: https://download.freedict.org/dictionaries/eng-rus/2025.11.23/ · https://freedict.org/downloads
- **Что это на самом деле**: `eng-rus.tei` → заголовок: «English-Русский **FreeDict+WikDict** dictionary», maintainer Karl Bartel, «Automatic creation … by WikDict», «Base data from Wiktionary.org via DBnary», `<extent>62181 headwords</extent>`. То есть FreeDict-eng-rus и WikDict-en-ru — **один и тот же датасет в разных форматах**. Это снимает необходимость выбирать между ними.
- **Лицензия**: `<availability status="free">… CC Attribution-ShareAlike 3.0 Unported` (в самом TEI). Коммерческое использование разрешено, модификация разрешена, производные — под той же лицензией, нужна атрибуция.
- **Размеры/форматы**: `src.tar.xz` 3.8 МБ (внутри `eng-rus.tei` 34.7 МБ XML), `stardict.tar.xz` 4.0 МБ, `slob` 8.2 МБ, `dictd.tar.xz` 5.3 МБ.
- **Содержимое [ИЗМЕРЕНО на eng-rus.tei 2025.11.23]**:
  - 62 181 headword, 84 188 `<sense>`, 143 405 русских переводов (`<cit type="trans">`), 78 720 блоков перевода
  - POS есть у всех: `n 35 653`, `pn 8 372`, `adj 8 282`, `v 6 133`, `adv 1 380`, `phraseologicalUnit 534`, `interjection 379`, `proverb 267`, `prefix 160`, `numeral 160`, `preposition 142`, `suffix 94`, `pronoun 94`, `conjunction 70`, `determiner 60`, `particle 8`, `postposition 3`, `symbol 1`
  - несколько значений: в среднем **2.57 sense'а** на entry (max 84); одно-значных 2 612
  - несколько переводов на sense: 143 405 цитат / 78 720 блоков ≈ 1.82 русских слова на смысл
  - **IPA есть**: 79 371 `<pron>` (`/bæŋk/`, `[beɪŋk]`)
  - английское определение смысла (`<def>`) есть — годится как подпись к значению в UI
  - **примеров употребления НЕТ** (`type="example"` = 0), usage notes НЕТ, cross-refs НЕТ
  - 15 598 headword'ов многословные (25%), 2 887 с дефисом/апострофом, максимальная длина 111 символов (пословицы)
  - русские переводы содержат знак ударения (`бе́рег`, `ба́нка`) — нужно нормализовать (см. §3)

Пример реальной записи (`<orth>bank</orth>`): n, `/bæŋk/`, senses: `бе́рег|брег` = «(hydrology) An edge of river, lake, or other watercourse», `банк` = «branch office», `ба́нка|о́тмель` = «elevation under the sea», `банк|банкомёт` = «controller of a card game», `вал|на́сыпь` = «slope of earth».

### 1.2 WikDict SQLite (тот же датасет, готовые БД)

- **URL**: https://download.wikdict.com/dictionaries/sqlite/2_2026-06/ · описание https://www.wikdict.com/page/download
- **Лицензия**: CC BY-SA (сайт: 4.0; TEI: 3.0 — расхождение в самих артефактах, для атрибуции указывать «CC BY-SA, Wiktionary via DBnary»).
- **`en-ru.sqlite3` — 20.9 МБ** **[ИЗМЕРЕНО]**: `translation` 126 267 строк, `simple_translation` 96 101 headword, `translation_grouped` 121 821.
  Схема: `translation(lexentry, sense_num, sense, written_rep, trans_list, score, is_good, importance)`.
  - POS **есть, но внутри строки**: `lexentry = 'eng/bank__Noun__1'` → надо распарсить.
  - `sense` = английский глосс; `trans_list` = `банк | банкомёт` (разделитель `|`).
  - `score` / `importance` — готовое ранжирование смыслов и слов (bank Noun#1 importance 2.65, Noun#2 0.0018). **Это то, чего нет в TEI** — порядок смыслов «по частоте».
  - **IPA в этой БД нет.**
- **`en.sqlite3` — 580 МБ** (**не вкладывать!**): `entry` 2 546 404 (все языки; `lexentry, written_rep, part_of_speech, pronun_list`), `form` 569 808, `importance`/`rel_importance`/`rep_importance` по 1.37 Млн (**частотные скоры**: `bank` 1.78, `the` 1.41, `zyzzyva` 0.0). Из неё берём только частоты и, при желании, формы — прунингом.
- **StarDict `wikdict-en-ru.zip` — 4 МБ** (https://download.wikdict.com/dictionaries/stardict/) — тоже «взять как есть».

### 1.3 Wiktionary / Wiktextract (kaikki.org)

- **URL**: https://kaikki.org/dictionary/rawdata.html · https://kaikki.org/dictionary/English/
- **Лицензия**: CC BY-SA + GFDL (как сам Wiktionary), коммерческое использование ок.
- **Размеры [ИЗМЕРЕНО по странице, 2026-10-30]**: все языки raw JSONL **24.8 ГБ** (gz 2.9 ГБ); постобработанный **English — 3.2 ГБ**; 1 795 048 senses в English; 1 396 111 различных словоформ.
- **Поля**: `word, pos, senses[].glosses, senses[].examples, senses[].translations[{code,word,sense,tags}], forms[], sounds[]/pronunciations[] (IPA), etymology, categories`.
- **Что даёт сверх FreeDict**: **примеры**, полные таблицы словоформ, этимология, синонимы/антонимы, озвучка (20.4 ГБ аудио отдельно).
- **Цена**: 3.2 ГБ парсинга, шум в привязке перевод→смысл, дубли этимологий. Для MVP — избыточно.

### 1.4 dict.cc — **НЕЛЬЗЯ**

- https://www.dict.cc/?s=about%3Awordlist: «The translation data contained **must not be extracted and/or republished**», «the English-German translations contained are only available for **personal use** …, republishing is not allowed anymore». Плюс Terms of Use: автоматический парсинг требует разрешения.
- Вывод: юр. тупик для вложения в приложение. Не использовать ни в каком виде.

### 1.5 LibreOffice / Hunspell (`ru_RU`, `en_US`)

- Это **орфографические** словари (списки словоформ + affix-правила). Переводов не содержат вообще. Как источник en→ru — непригодны. Полезны только для спеллчека/нормализации ввода.

### 1.6 Apertium en↔ru — **непригодно**

- Репозиторий `apertium-rus-eng` существует, но **последний push 2017-03-17** **[ИЗМЕРЕНО через GitHub API]**, лицензия GPL (вирусная для данных), формат — 1:1 пары для rule-based MT без глосс и без частей речи на выходе. Мёртвый и юридически неудобный вариант.

### 1.7 StarDict-сборки en-ru (архив huzheng, зеркало stardict.uber.space)

- https://stardict.uber.space/ru/: `mueller7` 3 МБ **GPL**, `Full English-Russian` 32.4 МБ **GPL**, `en-ru-bars` 10 МБ (**лицензия не указана**), тематические паки GPL.
- Проблемы: (а) провенанс «Full English-Russian» не документирован (смесь Mueller/Lingvo-подобных источников), (б) GPL на данные — вирусный для проприетарного бандла, (в) нет гарантии POS/смыслов. Как «взять как есть» — **нет**.

### 1.8 Прочее (проверено, отбраковано)

- **libredict wiktionary en-ru StarDict** (https://libredict.org/en): **4 638 headword** — на порядок меньше нужного.
- **WikDict ru-en** (`ru-en.sqlite3` 17 МБ) — нужен только если делать обратный поиск.

---

## 2. Готовые SQLite/StarDict en→ru с открытой лицензией — что можно взять как есть

| Артефакт | Размер | Формат | POS | Смыслы | IPA | Лицензия | Годность |
|---|---|---|---|---|---|---|---|
| FreeDict eng-rus StarDict | 4.0 МБ | `.ifo/.idx/.dict.dz` | ✅ | ✅ | ✅ | CC BY-SA 3.0 | **да, drop-in** |
| FreeDict eng-rus SLOB | 8.2 МБ | `.slob` | ✅ | ✅ | ✅ | CC BY-SA 3.0 | да (медленнее) |
| FreeDict eng-rus dictd | 5.3 МБ | `.index/.dict.dz` | ✅ | ✅ | ✅ | CC BY-SA 3.0 | да |
| WikDict `en-ru.sqlite3` | 20.9 МБ | SQLite | ✅ (в lexentry) | ✅ + rank | ❌ | CC BY-SA | да, но без IPA |
| WikDict StarDict en-ru | 4 МБ | StarDict | ✅ | ✅ | ❌ | CC BY-SA | да |
| dict.cc | — | txt | ✅ | ✅ | ❌ | proprietary | **нет** |
| mueller7 / Full En-Ru | 3 / 32.4 МБ | StarDict | ? | ✅ | ❌ | GPL | **нет** |
| libredict wiktionary en-ru | н/д | StarDict | ? | ✅ | ? | CC BY-SA | нет (4.6k слов) |

**Ключевой факт по репозиторию**: в приложении **уже есть** ридеры `apps/readest-app/src/services/dictionaries/stardictReader.ts` (ленивый бинарный поиск по `.idx`/`.syn`, построчная распаковка DictZip-чанков, LRU), `slobReader.ts`, `dictReader.ts`, `bglReader.ts`, плюс `dictionaryService.ts` (28.9 КБ) и `migrate.ts`. То есть **StarDict/SLOB en→ru вкладывается без единой строчки парсера** — только UI-карточка.

---

## 3. Пайплайн сборки из kaikki (и почему он не нужен для MVP)

### 3.1 Из kaikki (если делать «с нуля»)

```
1. Скачать kaikki English extract (3.2 ГБ)  [илИ raw all-languages 2.9 ГБ gz]
2. Стримить JSONL: для каждой строки, где lang_code == "en":
     для каждого sense (или верхнеуровневого translations):
       для каждого tr в translations, где tr.code == "ru" (и tr.lang == "Russian"):
         emit (word, pos, sense_num, gloss, tr.word, tr.sense, tr.tags)
3. Дедуп по (word, pos, gloss), нормализация ударений, маппинг POS.
```
- **Выход [ОЦЕНКА, сверено с независимым источником]**: ~96 тыс. headword, ~126 тыс. sense-строк, ~195 тыс. русских строк — совпадает с независимо собранным WikDict (`en-ru.sqlite3`: 96 101 headword / 126 267 строк) → цифра надёжная.
- **Время [ОЦЕНКА]**: 8–12 мин однопоточного Python на 3.2 ГБ JSONL + 1–2 мин на запись БД.
- **Размер после прунинга**: см. §3.3 — 18–27 МБ.

### 3.2 Из FreeDict TEI (рекомендуемый, эквивалент по содержанию)

```
1. curl freedict-eng-rus-2025.11.23.src.tar.xz (3.8 МБ) → tar xf
2. Прочитать eng-rus.tei (34.7 МБ), вырезать <body>, regex/XML-парс <entry>:
     <orth>, <pron>*, <gramGrp><pos>, <sense>{<def>, <cit type="trans"><quote>*}
3. Нормализовать: fold(word) (lower + снять U+0301/U+0300/U+0306),
   pos→enum, ru_raw (с ударением) + ru_fold (без), дедуп (word,pos,gloss,ru)
4. (опц.) джойн с en-ru.sqlite3 по (written_rep, pos) → sense.rank/importance
5. (опц.) джойн с en.sqlite3.rep_importance по written_rep → word.freq_rank
6. INSERT в SQLite, 4 индекса, VACUUM.
```
- **Время [ИЗМЕРЕНО]**: полный парс 34.7 МБ TEI → 62 181 lemma / 84 188 sense / 143 405 translation = **1.2 с парс, 4.6 с сборка с индексами и VACUUM** (Python, одна машина). Это «секунды», а не часы.

### 3.3 Ожидаемый размер SQLite **[всё ИЗМЕРЕНО, реальные сборки]**

| Вариант | Размер |
|---|---|
| Минимум: lemma(word,pos) + sense(lemma_id) + translation(sense_id,ru), 2 индекса | **17.9 МБ** |
| + англ. определения (`sense.def`) | 25.0 МБ |
| + IPA + fold-колонки для поиска по русскому | 25.0 МБ |
| + индекс `translation(sense_id)` (обязателен, см. ниже) | **26.7 МБ** |
| + формы (kaikki, если делать) | +4–6 МБ **[ОЦЕНКА]** |

Итог: **18–27 МБ** — в бюджет 30–80 МБ укладывается с запасом, остаётся место на примеры/формы.

### 3.4 Ловушка производительности (важно для «мгновенно на слабом устройстве») **[ИЗМЕРЕНО]**

Один и тот же запрос `lemma→sense→translation`:
- **без** индекса на `translation(sense_id)`: **46 048 µs** (46 мс) — полный скан 143 405 строк на каждый смысл;
- **с** индексом: **25 µs**.
Разница ×1800. Обязательный набор индексов: `lemma(word_fold)`, `sense(lemma_id)`, `translation(sense_id)`, `translation(ru_fold)` (для обратного поиска). 25 µs против нынешних 365 мс LLM — 4 порядка.

### 3.5 Нормализация данных (не забыть)

1. **Ударения**: `бе́рег` содержит U+0301. Хранить `ru_raw` (для отображения опционально «с ударением») и `ru_fold` (для поиска/сортировки). В SRS показывать без ударения по умолчанию.
2. **POS**: маппинг `n→noun, v→verb, adj→adjective, adv→adverb, pn→proper_noun, phraseologicalUnit→phrase, …` (18 значений, полный список в §1.1).
3. **Многословные заголовки**: 15 598 (25%) — исключить из индекса одиночных токенов, иначе засорят tap-lookup.
4. **`trans_list`**: разделитель `|`, обрезать пробелы, дедуп внутри sense.
5. **Дубли этимологий**: в wikdict `bank__Noun__1` и `bank__Noun__2` — в TEI они уже слиты в один entry; при сборке из SQLite нужен merge по (written_rep, pos).

---

## 4. Лемматизация: нужен ли стеммер?

**Ответ: нет. Она уже реализована в проекте.**

- `apps/readest-app/src/services/dictionaries/lemmatize/english.ts` (7.5 КБ): два слоя —
  1) таблица иррегулярных форм (`be/have/go/went/ran/mice/analyses/…`), 2) регулярные суффиксные правила (plural/past/gerund/comparative/possessive). Явно спроектировано как «over-generate, словарь сам отвалидирует».
- `lemmatize/index.ts` — реестр по primary subtag (`en`), вызывается **только после провала точного совпадения** («exact match always wins»). То есть поведение уже правильное: `bank` → точное; `banks` → lemma-кандидат.
- Данные вместо правил **не спасают**: в `en.sqlite3.form` для нашего набора лемм всего **63 224 строки / 58 981 ключ** **[ИЗМЕРЕНО]**, и, например, для `go` форм вообще нет. Покрытие непригодное.
- **Snowball/porter2** — не нужен: даёт стемы, а не леммы, требует новую зависимость и не улучшает hit-rate на словаре из лемм.
- **Mechura lemmatization-lists** (`lemmatization-en.txt`, 41 760 пар, **ODbL**) — технически хорош, но вводит вторую лицензию (ODbL ShareAlike на производную БД) поверх CC BY-SA. Не брать, пока не доказан дефицит.
- Если позже понадобится hit-rate >95% на редких формах — источник не стеммер, а **`forms[]` из kaikki** (полные таблицы словоформ English Wiktionary): отдельный build-step, +4–6 МБ, 1–2 ч.

---

## 5. Схема SQLite

Две **отдельные** БД: словарь (read-only, обновляемый артефакт) и пользовательские данные (SRS). Это критично: обновление словаря не должно трогать прогресс.

### 5.1 `dictionary.db` (read-only, вкладывается в бандл)

```sql
PRAGMA journal_mode = OFF;      -- при сборке
PRAGMA page_size = 4096;

CREATE TABLE meta (               -- версия, лицензия, дата сборки, источник
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- rows: ('schema_version','1'), ('source','FreeDict+WikDict 2025.11.23'),
--       ('license','CC BY-SA 3.0'), ('built_at','2026-11-26'), ('headwords','62181')

CREATE TABLE word (
  id        INTEGER PRIMARY KEY,
  lemma     TEXT NOT NULL,        -- 'bank'
  lemma_fold TEXT NOT NULL,       -- lower, без ударений/диакритики: 'bank'
  pos       TEXT NOT NULL,        -- 'noun' | 'verb' | 'adjective' | 'adverb' | 'proper_noun' | ...
  ipa       TEXT,                 -- '/bæŋk/'
  freq      REAL,                 -- rep_importance, 0.0 если неизвестно (сортировка/прунинг)
  n_senses  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_word ON word(lemma_fold, pos, IFNULL(ipa,''));
CREATE INDEX ix_word_fold ON word(lemma_fold);

CREATE TABLE sense (
  id        INTEGER PRIMARY KEY,
  word_id   INTEGER NOT NULL REFERENCES word(id),
  ord       INTEGER NOT NULL,     -- порядок показа: по importance/score desc
  gloss_en  TEXT                  -- '(countable) A branch office of such an institution.'
);
CREATE INDEX ix_sense_word ON sense(word_id, ord);

CREATE TABLE translation (
  id        INTEGER PRIMARY KEY,
  sense_id  INTEGER NOT NULL REFERENCES sense(id),
  ru        TEXT NOT NULL,        -- как в источнике, с ударением: 'бе́рег'
  ru_fold   TEXT NOT NULL,        -- нормализовано: 'берег'
  ord       INTEGER NOT NULL,
  is_good   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_tr_sense ON translation(sense_id, ord);   -- ОБЯЗАТЕЛЕН: 46ms → 25µs
CREATE INDEX ix_tr_fold  ON translation(ru_fold);         -- обратный поиск ru→en

-- опционально, фаза 2 (kaikki)
CREATE TABLE form (
  surface_fold TEXT NOT NULL,
  word_id      INTEGER NOT NULL REFERENCES word(id),
  tag          TEXT              -- 'plural' | 'past' | 'participle' | 'comparative'
);
CREATE INDEX ix_form ON form(surface_fold);
```

Запрос карточки (один, 25 µs):
```sql
SELECT w.lemma, w.pos, w.ipa, s.ord, s.gloss_en, t.ru, t.ord
FROM word w JOIN sense s ON s.word_id = w.id
            JOIN translation t ON t.sense_id = s.id
WHERE w.lemma_fold = ?1
ORDER BY w.freq DESC, s.ord, t.ord;
```

### 5.2 `user.db` — SRS и сохранённые слова (отдельный файл, в БД приложения)

```sql
CREATE TABLE vocabulary (
  id            INTEGER PRIMARY KEY,
  lemma         TEXT NOT NULL,        -- снапшот: переживает обновление словаря
  pos           TEXT NOT NULL,
  word_id       INTEGER,              -- nullable: ссылка на dictionary.db
  translation   TEXT,                 -- выбранный пользователем перевод (снапшот)
  added_at      INTEGER NOT NULL,     -- unix ms
  due_at        INTEGER NOT NULL,
  interval_days REAL    NOT NULL DEFAULT 0,
  ease          REAL    NOT NULL DEFAULT 2.5,   -- SM-2
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0,
  suspended     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(lemma, pos)
);
CREATE INDEX ix_vocab_due ON vocabulary(due_at) WHERE suspended = 0;

CREATE TABLE review_log (
  id          INTEGER PRIMARY KEY,
  vocab_id    INTEGER NOT NULL REFERENCES vocabulary(id),
  ts          INTEGER NOT NULL,
  rating      INTEGER NOT NULL,       -- 0 again / 1 hard / 2 good / 3 easy
  prev_interval REAL, new_interval REAL
);
CREATE INDEX ix_log_vocab ON review_log(vocab_id, ts);

CREATE TABLE lookup_history (        -- «недавно смотрел», оффлайн-статистика
  id      INTEGER PRIMARY KEY,
  lemma   TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  book_hash TEXT,                    -- из какой книги тапнули (nullable)
  saved   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_hist ON lookup_history(ts DESC);
```

Замечания:
- `vocabulary.lemma` — **снапшот**, а не только FK: пересборка словаря не должна ломать прогресс.
- FTS не нужен: точный поиск по индексу. FTS5 — только если появится поиск по определениям.
- Ключ SRS — `(lemma, pos)`: `bank`/noun и `bank`/verb — разные карточки.

---

## 6. Вердикт

### 6.1 В MVP (вложить в приложение)

1. **FreeDict+WikDict eng-rus, CC BY-SA 3.0** — единственный источник, который закрывает POS + несколько значений + IPA + определения при 4 МБ и 8.2 МБ сырья.
2. Формат — **сначала StarDict (4 МБ)**: ридер `stardictReader.ts` уже в проекте, UI-карточка делается за день, риск = 0. Затем (если нужен rank по частоте и SRS-ключи) — своя **SQLite 26.7 МБ** из TEI + join с `en-ru.sqlite3` (rank) и `en.sqlite3.rep_importance` (частота).
3. Лемматизация — **ничего не делать**, использовать `lemmatizeEn` как fallback.

### 6.2 Качать отдельно (паком, через существующий импорт словарей)

- `en-ru.sqlite3` 20.9 МБ — если пользователь хочет «расширенный» словарь с ранжированием (по сути дубль, смысл только при отказе от своей сборки).
- **kaikki-derived pack** (примеры + словоформы + этимология, 10–40 МБ **[ОЦЕНКА]**) — фаза 2, после валидации UX.
- `ru-en.sqlite3` 17 МБ — обратный поиск, отдельным паком.

### 6.3 Никогда

dict.cc (запрет на републикацию), GPL-сборки StarDict en-ru (провенанс), Apertium (мёртв, GPL), LibreOffice (нет переводов).

### 6.4 Часы **[ОЦЕНКА, на основе измеренной сложности]**

| Работа | Часы |
|---|---|
| Лицензия/атрибуция (экран «О словаре», COPYING, ссылка на источник) | 1–2 |
| Вложить FreeDict StarDict + UI-карточка (POS, значения, IPA, определения) | 3–4 |
| Build-скрипт TEI→SQLite (парс, fold ударений, POS-маппинг, join rank/freq) | 4–6 |
| SQLite-ридер + fallback-цепочка (exact → lemma → miss→LLM) + миграции | 4–6 |
| SRS: таблицы, SM-2/FSRS-lite, экран повторения, хуки из карточки | 6–10 |
| Тесты (фикстуры 200 слов, латентность, регресс на ударения) | 2–3 |
| **Итого MVP (словарь, без SRS)** | **8–12** |
| **Итого со SRS** | **16–22** |

### 6.5 Риски

1. **CC BY-SA — копилефт на данные, не на код.** Вложенный словарь и любые его производные (включая нашу SQLite-сборку) должны оставаться под BY-SA с атрибуцией; при смешивании с нашими данными (частоты, формы) ShareAlike распространяется на объединённую БД. Приложение при этом не «заражается». Митигация: отдельный файл `dictionary.db` + экран атрибуции + предложение скачать исходник/модификацию.
2. **Качество DBnary-привязки**: переводы иногда висят на неверном смысле, 17% лемм FreeDict не находятся в `entry`-таблице WikDict **[ИЗМЕРЕНО: 47 306 / 57 076]**, ударения внутри переводов, 25% многословных заголовков. Митигация: QA-выборка топ-1000 слов до релиза; порядок смыслов брать из `importance`, а не из порядка Wiktionary.
3. **Покрытие 62 тыс. лемм** — нативная проза будет давать промахи. Митигация: **не удалять LLM-фолбэк**, строить цепочку dict(<1 мс) → lemma → LLM(365 мс) только при промахе. Метрика: доля промахов на реальной книге.
4. **Устаревание**: источник обновляется ~2 раза в год (FreeDict 2025.11.23 → Debian 2026-02). Сборка занимает секунды, стоимость обновления ≈ 0.5 ч.
5. **Латентность на слабом устройстве** зависит от индексов, а не от объёма: без `translation(sense_id)` получаем 46 мс вместо 25 µs. В тестах фиксировать `EXPLAIN QUERY PLAN`.

---

## 7. Ссылки (все проверены 2026-11-26)

- kaikki raw: https://kaikki.org/dictionary/rawdata.html · English: https://kaikki.org/dictionary/English/ · формат: https://github.com/tatuylonen/wiktextract
- WikDict downloads: https://www.wikdict.com/page/download · файлы: https://download.wikdict.com/dictionaries/sqlite/2_2026-06/
- FreeDict eng-rus: https://download.freedict.org/dictionaries/eng-rus/2025.11.23/ · https://freedict.org/downloads
- Debian: https://packages.debian.org/sid/dict-freedict-eng-rus (59 433 headwords, freedict-wikdict)
- dict.cc: https://www.dict.cc/?s=about%3Awordlist (запрет републикации)
- StarDict-архив: https://stardict.uber.space/ru/ · лицензии на странице
- Apertium: https://github.com/apertium/apertium-rus-eng (последний push 2017-03)
- Mechura lemmatization lists (ODbL): https://github.com/michmech/lemmatization-lists
- libredict (4 638 headwords): https://libredict.org/en

## 8. Локальные артефакты замеров

`/tmp/opencode/dict/`: `en-ru.sqlite3` (20.9 МБ), `en.sqlite3` (580 МБ), `fd/eng-rus/eng-rus.tei` (34.7 МБ), `full.sqlite3` (26.7 МБ, прототип), `nodef.sqlite3` (17.9 МБ).
Контекст кода: 🔍 `apps/readest-app/src/services/dictionaries/stardictReader.ts:1-56`, `slobReader.ts`, `dictReader.ts`, `lemmatize/english.ts:1-40`, `lemmatize/index.ts:1-30`, `dictionaryService.ts`, `src/services/database/migrations/index.ts`.
