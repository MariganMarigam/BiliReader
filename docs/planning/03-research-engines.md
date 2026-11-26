# 02 — Офлайн-движки перевода: технико-экономический анализ (CPU-only / mobile)

**Дата:** 2026-11-03 · **Автор:** Scout · **Статус:** research (данные проверены по карточкам моделей и API HF/GitHub на 2026-11-03)

**Целевые платформы:** Android arm64 (2–4 ГБ RAM, слабый CPU), iOS, Linux desktop x86_64 CPU-only.
**Бюджеты латентности:** слово — «мгновенно» (<50 мс), фраза — практически мгновенно (<150 мс), предложение — сотни мс (<800 мс).
**Языковые пары MVP:** en→ru, de→ru, fr→ru, es→ru; далее расширяемо.

---

## 0. TL;DR (для Оскара)

1. **Ключевой факт, меняющий задание:** `AngelSlim/Hy-MT1.5-1.8B-1.25bit` **нельзя использовать в коммерческом продукте вне Китая** — лицензия Tencent HY Community License **исключает EU, UK и Южную Корею** (дословно: *«THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA»*, `License.txt`). Для приложения с глобальным сторовым релизом это блокер.
2. **Замена найдена:** **Hy-MT2-1.8B** (релиз 2026-05-21) — **Apache-2.0**, официальные GGUF: Q4_K_M 1.13 ГБ, Q6_K 1.47 ГБ, Q8_0 1.91 ГБ, 2-bit **572.7 МБ**, 1.25-bit **440 МБ**. Русский поддержан. Это тот же вендор, лучшее качество, чистая лицензия.
3. **1.25-bit/2-bit GGUF = риск:** собираются только с патченным llama.cpp. 1.25-bit зависит от **STQ-ядра (PR #22836), который на 2026-09-14 всё ещё OPEN и не влит в upstream**. 2-bit (Q2_0C) — тоже проприетарный форк-квант (PR #19357). Официально работает, но вендорить придётся свой билд llama.cpp.
4. **Реальные замеры на ARM есть (Arm, Vivo X300, 1 ядро CPU):** 2-bit Hy-MT2 — prefill p50 **223 мс**, decode **49.6 tok/s**, RSS **1088 МиБ**, размер 630 МБ (Q8-эмбеддинги). Q8-базовая версия: prefill 309.5 мс, 25.1 tok/s, RSS 2891 МиБ.
5. **Вывод по каскаду:** ни одна LLM-модель не даёт «мгновенный» перевод **слова** — 200–600 мс и риск неверного смысла. Слово должно идти через **словарный слой (Wiktionary/kaikki + лемматизация)** — <10 мс. Фраза — **OPUS-MT int8/Bergamot** (79 МБ / 30 МБ на пару, десятки мс). Предложение с контекстом — **Hy-MT2-1.8B 2-bit**.

---

## 1. Сводная таблица кандидатов

| Модель | Размер (квант) | RAM инференса | Латентность CPU | ru? | Лицензия (комм.) | Рантаймы | Сложность Android/iOS/Linux |
|---|---|---|---|---|---|---|---|
| **Hy-MT2-1.8B** (2026-05) | 440 МБ (1.25bit) / 572.7 МБ (2bit) / 1.13 ГБ (Q4_K_M) / 1.47 ГБ (Q6_K) / 1.91 ГБ (Q8_0) | ~0.6–1.1 ГБ RSS (2bit, замер Arm: 1088 МиБ avg) | **prefill 223 мс + 49.6 tok/s** (2bit, 1 ядро флагмана). Предложение 15–20 токенов ≈ **0.6–0.9 с** (флагман) / **1.2–2 с** (слабый телефон, *оценка*) | ✅ (ru в списке 33 языков) | **Apache-2.0** ✅ | llama.cpp/GGUF (STQ/Q2_0C — форк-PR), ONNX (конвертация), MLX (macOS) | Средняя: официальные сборки llama.cpp под Android NDK/iOS, KleidiAI; но 1.25/2-bit — свой билд llama.cpp |
| **HY-MT1.5-1.8B** (2025-12) | 1.13 ГБ (Q4_K_M) / 1.47 ГБ (Q6_K) / 1.91 ГБ (Q8_0); AngelSlim 1.25bit | ~1–2 ГБ | как выше | ✅ | ❌ **Tencent HY Community License: запрет EU/UK/KR** | llama.cpp (официальный GGUF), GPTQ-Int4, FP8 | та же + юридический блокер |
| **OPUS-MT (Marian, 77M/пару)** | **79 МБ/пару в CT2 int8** (blog MultiVoice); ONNX int8: en-ru = encoder 49.1 + decoder 86.4 = **135.5 МБ**; fp32 293 МБ | 150–300 МБ | **оценка**: 15–35 мс/предложение (desktop, 4 потока), **60–150 мс** (телефон) | ✅ прямые пары en-ru, ru-en, fr-ru (Apache-2.0), es-ru (Apache-2.0), de-ru | CC-BY-4.0 / Apache-2.0 (часть пар) ✅ с атрибуцией | **CTranslate2**, ONNX Runtime Mobile, transformers.js | Средняя: CT2 под Android — только ручная сборка (issue #1683 open), под iOS официально нет. **ONNX Runtime — самый дешёвый путь на мобайл** |
| **Bergamot (Mozilla, ~40M)** | **30.1 МБ** `model.enru.intgemm.alphas.bin` + 2.6 МБ лексикон + 0.9 МБ vocab ≈ **34 МБ/направление** | 60–120 МБ | **оценка**: 10–25 мс (desktop), 30–80 мс (телефон), ~2× быстрее OPUS-MT | ✅ en↔ru; **de/fr/es→ru только через пивот en** (2 прохода) | **MPL-2.0** ✅ | bergamot-translator (C++/WASM), форк Marian | Средняя: WASM «из коробки» в WebView, нативный C++ билд под Android/iOS возможен, но мобильного SDK нет |
| **NLLB-200-distilled-600M** | 2.35 ГБ fp32 → ~600 МБ int8 | 800 МБ–1.2 ГБ | **оценка**: 60–120 мс/предложение (CPU), медленнее OPUS-MT в 2–4× | ✅ | ❌ **CC-BY-NC-4.0** (некоммерческая) | CT2, ONNX, transformers | Высокая (600M encoder-decoder + SentencePiece 200 языков) |
| **M2M-100 418M** | 1.85 ГБ fp32 → ~470 МБ int8 | ~600 МБ | медленнее OPUS-MT, качество по ru устарело | ✅ | MIT ✅ | CT2/ONNX | Средняя |
| **MADLAD-400-3B** | q2_k **920.8 МБ** / q4_k 1577.9 МБ | 1.2–2 ГБ | слишком медленно для интерактива на телефоне | ✅ | Apache-2.0 ✅ | llama.cpp GGUF | Низкая, но не влезает в бюджет RAM |
| **TranslateGemma-4B** (2026-01) | ~2.5 ГБ int4 (*оценка*) | 3–4 ГБ | секунды на слабом CPU | ✅ (55 языков) | Gemma license (комм. с ограничениями) ⚠️ | llama.cpp, MediaPipe/ONNX | Высокая для 2–4 ГБ устройств |
| **Gemma 3n E2B** | ~2–3 ГБ int4 | 3–4 ГБ | не для real-time на слабом CPU | ✅ | Gemma license ⚠️ | llama.cpp/MediaPipe | Не подходит по RAM |
| **Qwen3-1.7B** | 1.0–1.4 ГБ q4 | 1.5 ГБ | общий LLM, не MT-тюнен → больше токенов на перевод | ✅ | Apache-2.0 ✅ | llama.cpp | Средняя, но проигрывает Hy-MT2 по качеству/токен |
| **EuroLLM-1.7B** | ~1 ГБ q4 | 1.2 ГБ | — | ❌/⚠️ (24 офиц. языка ЕС, ru не входит) | Apache-2.0 ✅ | llama.cpp | Не для ru |
| **SeamlessM4T v2** | 2.3B → ~1.2–2 ГБ | 2–3 ГБ | не реально на 2 ГБ RAM | ✅ | ❌ CC-BY-NC-4.0 | fairseq2 (тяжёлый) | Очень высокая |
| **Whisper** | tiny 39M/75 МБ, base 74M/142 МБ | 200–400 МБ | — | ✅ (ru распознаёт хорошо) | MIT ✅ | whisper.cpp, ONNX | **Это ASR, не TTS.** Для «озвучки» нужен Piper (VITS, ~20–60 МБ/голос, MIT) или Kokoro-82M (Apache) |

> Все цифры латентности без пометки «замер» — **оценки** на основе размера модели, типа кванта и опубликованного замера Arm; они помечены явно.

---

## 2. Детально по каждому кандидату

### 2.1 Hy-MT2-1.8B — главный кандидат на «умный» слой

**Что это:** «fast-thinking» семейство переводческих моделей Tencent Hunyuan: 1.8B / 7B / 30B-A3B, 33 языка + 5 диалектов, релиз **2026-05-21**, Apache-2.0.
- Paper: https://arxiv.org/abs/2605.22064
- Карточка: https://huggingface.co/tencent/Hy-MT2-1.8B
- GGUF: https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF (Q4_K_M 1.13 ГБ, Q6_K 1.47 ГБ, Q8_0 1.91 ГБ)
- 2-bit: https://huggingface.co/tencent/Hy-MT2-1.8B-2Bit-GGUF (**572.7 МБ**)
- 1.25-bit: https://huggingface.co/tencent/Hy-MT2-1.8B-1.25Bit-GGUF (**440 МБ**)
- Квантование: https://github.com/Tencent/AngelSlim

**Реальный бенчмарк (Arm, Vivo X300, ОДНО ядро CPU, llama.cpp + KleidiAI):**

| Метрика | Q8_0 (1.82 ГБ) | 2-bit Q2_0C + Q8-эмбеддинги (630 МБ) |
|---|---|---|
| Prefill p50 (промпт + 1-й токен) | 309.5 мс | **223.0 мс** |
| Decode p50 | 25.06 tok/s | **49.60 tok/s** |
| Средний RSS | 2891 МиБ | **1088 МиБ** |
| Пиковый RSS | 3797 МиБ | 1513 МиБ |

Источник: https://huggingface.co/Arm/hy-mt2-1-8b-2bit-translation-gguf

**Вывод по латентности:** предложение из 15 слов ≈ 20 выходных токенов → 223 мс + 400 мс = **~620 мс** на одном ядре флагмана. На слабом телефоне (2–4× медленнее) — **1.2–2 с**. На desktop x86 CPU-only — **0.4–0.8 с** (*оценка*).

**Критично для интеграции:**
- 1.25-bit GGUF требует **STQ-ядра**: PR https://github.com/ggml-org/llama.cpp/pull/22836 — на 2026-09-14 **state: open, merged: false** (создан 2026-05-08). Т.е. upstream llama.cpp его не содержит.
- 2-bit Q2_0C — тоже не upstream (PR #19357), но Arm уже упаковал рабочий бандл и замерил его.
- Практический вывод: **форк llama.cpp обязателен**; версия должна пиниться (submodule), иначе апстрим-обновления сломают сборку.
- Промпт-шаблон простой: `Translate the following segment into {target_language}, without additional explanation.\n\n{text}` (полные имена языков: Russian, не ru). Есть режимы terminology / context / formatted — **context-режим это ровно то, что нужно для anylang-подобного перевода предложения в книге**.

**Качество:** вендор заявляет превосходство над Microsoft/Doubao API для 1.8B и паритет с 7B-версией. Независимого бенчмарка en→ru на момент отчёта нет — **это открытый вопрос**.

---

### 2.2 HY-MT1.5-1.8B (то, что было в задании) — юридический блокер

- GGUF есть официальный: Q4_K_M 1.13 ГБ / Q6_K 1.47 ГБ / Q8_0 1.91 ГБ (https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF).
- Отдельный `Hy-MT1.5-1.8B-2bit` (574 МБ) и `AngelSlim/Hy-MT1.5-1.8B-1.25bit`.
- **Лицензия (дословно из `License.txt`):**
  - *«THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA»*
  - *«Territory» shall mean the worldwide territory, excluding the territory of the European Union, United Kingdom and South Korea.*
  - п.4: при >100 млн MAU нужен отдельный договор с Tencent.
  - п.5(b): запрещено использовать выводы для обучения других моделей.
- **Вердикт: не использовать.** Даже если сам пользователь в РФ, сторовый релиз = дистрибуция в EU/UK (Apple/Google аккаунты), что прямо нарушает п.3(c)/5(c).

---

### 2.3 OPUS-MT (Helsinki-NLP, Marian) + CTranslate2/ONNX int8 — «быстрый» слой

**Размеры (измерено по файлам HF):**
| Артефакт | Размер |
|---|---|
| `Helsinki-NLP/opus-mt-en-ru` fp32 (pytorch_model.bin) | 292.8 МБ (≈77M параметров) |
| CT2 int8 (по данным MultiVoice) | **79 МБ на языковую пару** |
| ONNX int8 en-ru: encoder 49.1 МБ + decoder_merged 86.4 МБ | **135.5 МБ** |
| ONNX int8 fr-ru | 50.0 + 88.2 = 138.2 МБ |
| ONNX int8 es-ru | 49.5 + 87.3 = 136.8 МБ |

Источники: https://huggingface.co/Helsinki-NLP/opus-mt-en-ru · https://huggingface.co/SashaSobchuk/opus-mt-onnx-int8 · https://elbgg.dev/en/blog/multivoice-en

**Пары:** en-ru ✅, ru-en ✅, fr-ru ✅ (Apache-2.0), es-ru ✅ (Apache-2.0), de-ru — репозиторий отдаёт 401 (gated/переименован), нужно проверить `Helsinki-NLP/opus-mt-de-ru` вручную либо использовать пивот de→en→ru. Всего в OPUS-MT ~1000+ направлений, что закрывает «далее расширяемо».

**Скорость (*оценка*):** 77M encoder-decoder, int8 → desktop 4 потока: 15–35 мс на короткое предложение; телефон: 60–150 мс. Для фразы из 3–6 слов — **<50 мс на телефоне**. Это единственный кандидат, реально попадающий в бюджет «фраза — мгновенно».

**Качество:** заметно ниже LLM-моделей на длинных/контекстных предложениях, но на коротких фразах и типичной книжной лексике — приемлемо. Для сравнения порядка величин: Bergamot COMET ≈ 0.83 против Google 0.87, Argos (по сути OPUS-MT-производные) ≈ 0.71 (обсуждение LibreTranslate: https://community.libretranslate.com/t/firefox-translation-models/1612). OPUS-MT обычно ставят между Argos и Bergamot.

**Интеграция:**
- CTranslate2 4.8.4: официальные сборки x86-64 + AArch64, int8; **Android — только ручная сборка** (https://github.com/OpenNMT/CTranslate2/issues/1683), iOS официально не поддерживается.
- **ONNX Runtime Mobile** — самый дешёвый путь: официальные AAR для Android и pod для iOS, int8-модели уже готовы (репозиторий SashaSobchuk), размер ~135 МБ/пару, но можно держать только нужные пары.
- Linux desktop: CT2 идеален (питон/ C++ API, 79 МБ).

---

### 2.4 Bergamot / firefox-translations-models — самый лёгкий слой

- Проект: https://browser.mt/ · репо: https://github.com/mozilla/firefox-translations-models · доки Firefox: https://firefox-source-docs.mozilla.org/toolkit/components/translations/resources/03_bergamot.html
- **Размер на направление (измерено):** `model.enru.intgemm.alphas.bin` **30.1 МБ**, `lex.50.50.enru.s2t.bin` 2.6 МБ, `vocab.enru.spm` 0.9 МБ → **≈34 МБ**. Русское направление ru-en: 30.1 + 4.2 + 0.9 = 35.2 МБ.
- **Лицензия: MPL-2.0** ✅ (коммерческое использование разрешено, требуется раскрытие изменений в файлах MPL).
- Критерий приёмки Mozilla: в пределах ~5% COMET от Google Translate.
- **Ограничение:** модели существуют почти исключительно как `xx→en` и `en→xx`. **de→ru / fr→ru / es→ru напрямую нет** → нужен пивот через английский (2 прохода ≈ 2× латентность, всё равно 60–150 мс).
- Рантайм: bergamot-translator (C++/WASM), форк Marian с intgemm. Для Android/iOS нативный билд возможен (это обычный C++), но мобильного SDK нет — придётся писать JNI/ObjC-обёртку.

---

### 2.5 NLLB-200 / M2M-100 / MADLAD-400 / SeamlessM4T — почему не MVP

| Модель | Блокер |
|---|---|
| NLLB-200-distilled-600M | **CC-BY-NC-4.0** — коммерческое использование запрещено. 600M параметров, ~600 МБ int8, медленнее OPUS-MT. |
| M2M-100 418M | MIT, но качество по ru устарело (2020), 470 МБ int8 — проигрывает OPUS-MT по всем осям. |
| MADLAD-400-3B | Apache-2.0, но q2_k = 921 МБ, RAM 1.2–2 ГБ — не для 2 ГБ телефона. |
| SeamlessM4T v2 | CC-BY-NC-4.0 + fairseq2 — двойной блокер. |
| EuroLLM-1.7B | Apache-2.0, но покрытие — официальные языки ЕС; ru не входит. |

---

### 2.6 Более новые (2025–2026) on-device MT — что реально появилось

| Модель | Дата | Размер | Лицензия | Годность |
|---|---|---|---|---|
| **Hy-MT2-1.8B** | 2026-05 | 440 МБ–1.9 ГБ | Apache-2.0 | ★★★ главный кандидат |
| **TranslateGemma 4B/12B/27B** | 2026-01-15 | 4B ≈ 2.5 ГБ int4 (*оценка*) | Gemma license | ★☆ 55 языков, но 4B не влезает в 2–4 ГБ RAM комфортно; интересен на desktop |
| **Gemma 3n E2B/E4B** | 2025 | 2–4 ГБ | Gemma license | ★☆ «on-device» по маркетингу, по RAM — нет |
| **Qwen3-1.7B** | 2025 | ~1 ГБ q4 | Apache-2.0 | ★★ общий LLM, не MT-тюнен: больше токенов на тот же перевод |
| Tiny Aya 3.35B | 2026-02 | ~2 ГБ q4 | (проверить) | ★☆ великоват |
| Hy-MT2-7B | 2026-05 | 4.5 ГБ q4 | Apache-2.0 | только desktop с GPU/16 ГБ RAM |

**Вывод:** специализированных компактных MT-моделей «sub-500MB, Apache, 30+ языков, ru» на ноябрь 2026 ровно одна — **Hy-MT2-1.8B**. Это удача, а не норма.

---

### 2.7 Whisper — оцениваем отдельно (и он не нужен для перевода)

- Whisper — **ASR** (речь→текст). MIT. whisper.cpp работает на Android/iOS.
- В сценарии «читалка + перевод» Whisper нужен только если появится **озвучка книги (TTS) → субтитры/синхронизация** или голосовой ввод.
- Для собственно «озвучки» нужен **TTS**: Piper (VITS, 20–60 МБ/голос, MIT, есть ru-голоса, отлично работает на ARM) или Kokoro-82M (Apache, качественнее, тяжелее).
- **Рекомендация:** Whisper не включать в MVP; TTS — отдельная фича, Piper.

---

## 3. Словарный слой: зачем он нужен и чем лучше MT для одного слова

### 3.1 Почему MT плох для слова
1. **Латентность:** 200–620 мс против <10 мс у словаря. Для UX «тапнул слово → подсказка» это разница между «мгновенно» и «подвисание».
2. **Смысл:** у изолированного слова нет контекста. MT выдаст **одну** догадку; словарь выдаёт **список значений** (как anylang), что для изучающего язык — правильнее pedagogically.
3. **Галлюцинации:** LLM на редких словах/именах собственных может выдать неверный перевод или объяснение вместо перевода; словарь — детерминирован.
4. **Стоимость батареи:** запуск 1.8B-модели на каждый тап — это 0.5–1 с работы всех ядер; словарь — микросекунды.

### 3.2 Источники словаря (проверено)
| Источник | Объём | Лицензия | Комментарий |
|---|---|---|---|
| **kaikki.org (Wiktextract, English Wiktionary)** | полный английский словарь postprocessed JSONL — **3.2 ГБ**; русский — **904.6 МБ** | CC-BY-SA (Wiktionary) — нужна атрибуция + share-alike на производные данные | Содержит переводы, этимологию, формы словоизменения. https://kaikki.org/dictionary/English/index.html · https://kaikki.org/dictionary/Russian/index.html |
| kaikki raw (все языки) | напр. de: 2.9 ГБ JSONL / 296 МБ gz | CC-BY-SA | https://kaikki.org/dictionary/rawdata.html |
| StarDict-словари (FreeDict и др.) | 5–50 МБ/словарь | зависит от словаря (часто GPL) | Простой формат, но качество/актуальность ниже |
| Wiktextract SQLite-конверсии | ~25 ГБ (полный) | CC-BY-SA | https://huggingface.co/datasets/wave101828228/Kaikki-Wiktionary-Ultimate-SQLite |

**Практика для мобильного:** из полного kaikki нужно вырезать только `word → [переводы на ru]` + формы. Оценка после прунинга: **30–80 МБ SQLite** на пару en→ru (FTS5-индекс по леммам), загрузка через mmap. Это в разы меньше любой MT-модели.

### 3.3 Лемматизация
Нужна, потому что в книге слово встречается в косвенной форме (`went`, `книгами`). Варианты по возрастанию цены:
- таблица форм из kaikki (уже есть в данных) — 0 зависимостей, ~1–3 мс;
- Snowball-стеммеры (Porter/Snowball для en/de/fr/es, русский Snowball) — 10–50 КБ, <1 мс, но грубее;
- spaCy/pymorphy — тяжело для мобильного, не брать.

---

## 4. Рекомендуемая каскадная схема

```
                    ┌─────────────────────────────────────────────┐
  тап по тексту ───▶│ 0. Классификатор выделения                  │
                    │    (1 слово / 2–6 слов / предложение+)      │
                    └───────┬──────────────┬──────────────┬───────┘
                            │              │              │
                    1 слово │       2–6 слов│      предложение
                            ▼              ▼              ▼
                 ┌──────────────────┐ ┌──────────────┐ ┌────────────────────┐
                 │ L1: СЛОВАРЬ      │ │ L2: БЫСТРАЯ  │ │ L3: КОНТЕКСТНАЯ MT │
                 │ kaikki SQLite    │ │ MT (int8)    │ │ Hy-MT2-1.8B 2/1.25 │
                 │ + лемматизация   │ │ OPUS-MT CT2  │ │ bit, llama.cpp     │
                 │ < 10 мс          │ │ /ONNX или    │ │ + prompt "context" │
                 │ список значений  │ │ Bergamot     │ │ 400 мс–1.5 с       │
                 │                  │ │ 40–150 мс    │ │                    │
                 └──────────────────┘ └──────┬───────┘ └──────────┬─────────┘
                                             │                    │
                                       (если качество низкое) ────┘
                                             │
                                    ┌────────▼─────────┐
                                    │ L3 «refine» /    │
                                    │ prefetch в фоне  │
                                    └──────────────────┘
```

### Почему именно так

| Уровень | Инструмент | Латентность | Обоснование |
|---|---|---|---|
| **L1: слово** | kaikki/Wiktionary, прунинг в SQLite + формы | **<10 мс** | MT не даёт списка значений и стоит 200–600 мс. Словарь в 20–60× быстрее и pedagogically правильнее. |
| **L2: фраза** | **OPUS-MT int8** (ONNX Runtime Mobile на мобайле, CT2 на desktop) или **Bergamot** (34 МБ/пара против 79–135 МБ) | **40–150 мс** | Единственный класс моделей, попадающий в «практически мгновенно». Bergamot — если нужна минимальная память; OPUS-MT — если нужны прямые пары de/fr/es→ru без пивота. |
| **L3: предложение** | **Hy-MT2-1.8B 2-bit** (572.7 МБ) с контекстным промптом; 1.25-bit (440 МБ) — только после мержа STQ | **0.4–1.5 с** | Единственная модель с ru + Apache-2.0 + реально работающим GGUF + замером на ARM. |

### Дополнительные приёмы, снижающие латентность без потери качества
1. **Prefetch:** при открытии страницы книги переводить абзацы L3 в фоне (idle, с ограничением по батарее). Тап по предложению тогда = мгновенно (из кэша). Кэш — SQLite, ключ = хэш(текст+пара+уровень).
2. **Двухступенчатый UX:** мгновенно показать L2-перевод (40–150 мс), через 0.5 с заменить на L3, если он лучше (диффометрия или просто «уточнённый перевод»). Это ровно то, что делает anylang по ощущениям.
3. **Тёплый процесс:** держать модель загруженной (mmap), не грузить/выгружать на каждый тап. Для L3 на Android — Foreground Service с уведомлением, иначе ОС убьёт процесс.
4. **Ограничение длины:** L3 всегда режет вход до ~120 токенов; для длинных абзацев — по предложениям с перекрытием контекста в 1 предложение.

---

## 5. Размер дистрибутива (реалистичная оценка)

| Компонент | Android (MVP: en→ru) | Все 4 пары |
|---|---|---|
| Словарь en→ru (SQLite, прунинг kaikki) | 30–80 МБ | 120–300 МБ |
| L2 OPUS-MT int8 ONNX (135 МБ/пару) | 135 МБ | ~540 МБ |
| L2 альтернатива: Bergamot (34 МБ/направление) | 34 МБ (en→ru) | 8 направлений × 34 = 272 МБ (с пивотом — меньше) |
| L3 Hy-MT2 1.8B 2-bit | 573 МБ | 573 МБ (мультиязычная) |
| **Итого MVP (словарь + Bergamot + Hy-MT2)** | **~640 МБ** | **~950 МБ–1.2 ГБ** |
| **Итого MVP (словарь + OPUS-MT + Hy-MT2)** | **~740 МБ** | **~1.4 ГБ** |

→ Нужен **модельный менеджер с докачкой по требованию** (как в Firefox Translations / Argos): базовый пакет ~50 МБ (словарь + UI), пары и L3 качаются по выбору пользователя. Play Store лимит на APK/AAB — 200 МБ base + asset delivery.

---

## 6. Сложность интеграции по платформам

| Рантайм | Android | iOS | Linux desktop | Итог |
|---|---|---|---|---|
| **llama.cpp + GGUF** | ✅ официальный NDK-пример, KleidiAI, NEON; нужен кастомный билд для Q2_0C/STQ | ✅ официальный XCFramework | ✅ тривиально | **Средняя** (пиннинг форка) |
| **ONNX Runtime Mobile** | ✅ AAR, NNAPI/XNNPACK | ✅ pod | ✅ | **Низкая** — лучший путь для L2 |
| **CTranslate2** | ⚠️ ручная сборка CMake (issue #1683) | ❌ официально нет | ✅ | **Высокая** на мобайле |
| **Bergamot (C++/WASM)** | ⚠️ JNI-обёртка + нативный билд | ⚠️ ObjC-обёртка | ✅ | **Средняя-высокая** |
| **MLX** | ❌ | ⚠️ только Apple Silicon | ❌ | не для наших целей |

---

## 7. Риски

| # | Риск | Серьёзность | Митигация |
|---|---|---|---|
| R1 | **1.25-bit Hy-MT2 требует невлитого PR #22836** (open с 2026-05-08, обновлён 2026-09-14) | Высокая | Пинить форк llama.cpp по коммиту; fallback на 2-bit (Arm-пакет уже рабочий) или Q4_K_M |
| R2 | Качество Hy-MT2 1.8B на **en→ru** не подтверждено независимым бенчмарком | Высокая | Прогнать собственный eval на 500–1000 предложениях (Flores-200 ru + книжные фрагменты) против OPUS-MT и Bergamot |
| R3 | **1088 МиБ RSS** для 2-bit на 2 ГБ устройстве | Высокая | mmap + `--no-mmap` при нехватке; выгружать модель после N минут; на <3 ГБ RAM — только L1+L2 |
| R4 | Лицензия Hy-MT1.5 (задание указывало именно её) | Блокер | Заменить на Hy-MT2 (Apache-2.0) |
| R5 | kaikki CC-BY-SA: производные данные должны быть под той же лицензией | Средняя | Отдельный «data» пакет с attribution; не смешивать с проприетарными ассетами |
| R6 | OPUS-MT `de-ru` недоступен напрямую (401) | Низкая | Пивот de→en→ru или Bergamot-пивот |
| R7 | Android убьёт процесс с моделью | Средняя | Foreground Service + уведомление, как у словарных приложений |
| R8 | Сторовые лимиты размера | Средняя | Asset delivery / докачка моделей |

---

## 8. Открытые вопросы (нужны решения до плана реализации)

1. **RAM-бюджет нижней планки:** целевой минимум — 2 ГБ или 3 ГБ? От этого зависит, входит ли L3 (Hy-MT2) в базовый сценарий на Android.
2. **Нужен ли L3 на мобайле вообще**, или допустимо «L2 сейчас + L3 только на desktop»? (Это упрощает продукт радикально.)
3. **Пивот через en допустим?** (Бергамот: 2 прохода, ~2× латентность, но ~в 2.5 раза меньше диска.)
4. **Требуется ли TTS в MVP?** Если да — Piper, отдельным решением.
5. **Кто владелец eval-набора?** Нужен фиксированный бенчмарк (Flores-200 + 300 книжных предложений) до выбора между L2-вариантами.

---

## 9. Источники (все проверены 2026-11-03)

- Hy-MT2 paper: https://arxiv.org/abs/2605.22064
- Hy-MT2-1.8B: https://huggingface.co/tencent/Hy-MT2-1.8B (License: apache-2.0)
- Hy-MT2-1.8B-GGUF: https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF
- Hy-MT2-1.8B-2Bit-GGUF (572.7 МБ): https://huggingface.co/tencent/Hy-MT2-1.8B-2Bit-GGUF
- Hy-MT2-1.8B-1.25Bit-GGUF (440 МБ): https://huggingface.co/tencent/Hy-MT2-1.8B-1.25Bit-GGUF
- Arm-бенчмарк на Vivo X300: https://huggingface.co/Arm/hy-mt2-1-8b-2bit-translation-gguf
- STQ PR (open): https://github.com/ggml-org/llama.cpp/pull/22836 · Q2_0C PR: https://github.com/ggml-org/llama.cpp/pull/19357
- HY-MT1.5 repo + лицензия: https://github.com/Tencent-Hunyuan/Hy-MT (License.txt)
- HY-MT1.5-1.8B-GGUF: https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF
- AngelSlim: https://github.com/Tencent/AngelSlim
- OPUS-MT en-ru: https://huggingface.co/Helsinki-NLP/opus-mt-en-ru (cc-by-4.0)
- OPUS-MT fr-ru / es-ru: https://huggingface.co/Helsinki-NLP/opus-mt-fr-ru, /opus-mt-es-ru (apache-2.0)
- ONNX int8 OPUS-MT (размеры): https://huggingface.co/SashaSobchuk/opus-mt-onnx-int8
- CT2 int8 79 МБ/пару: https://elbgg.dev/en/blog/multivoice-en
- CTranslate2 4.8.4: https://opennmt.net/CTranslate2/installation.html · Android-issue: https://github.com/OpenNMT/CTranslate2/issues/1683
- Bergamot: https://browser.mt/ · https://github.com/mozilla/firefox-translations-models · COMET-обсуждение: https://community.libretranslate.com/t/firefox-translation-models/1612
- Bergamot модели (размеры): https://huggingface.co/assafvayner/translatte-pair-models (mpl-2.0)
- NLLB-200-distilled-600M: https://huggingface.co/facebook/nllb-200-distilled-600M (cc-by-nc-4.0)
- M2M-100 418M: https://huggingface.co/facebook/m2m100_418M (mit)
- MADLAD-400-3B: https://huggingface.co/google/madlad400-3b-mt (apache-2.0, q2_k 921 МБ)
- TranslateGemma: https://blog.google/innovation-and-ai/technology/developers-tools/translategemma/ · https://huggingface.co/google/translategemma-4b-it (gemma)
- gemma-3n-E2B-it: https://huggingface.co/google/gemma-3n-E2B-it (gemma)
- Qwen3-1.7B: https://huggingface.co/Qwen/Qwen3-1.7B (apache-2.0)
- EuroLLM-1.7B: https://huggingface.co/utter-project/EuroLLM-1.7B-Instruct (apache-2.0)
- kaikki/Wiktextract: https://kaikki.org/dictionary/English/index.html (3.2 ГБ) · https://kaikki.org/dictionary/Russian/index.html (904.6 МБ) · https://kaikki.org/dictionary/rawdata.html
- Kaikki SQLite: https://huggingface.co/datasets/wave101828228/Kaikki-Wiktionary-Ultimate-SQLite

---

## 10. Confidence

**0.75** — высокая по лицензиям, размерам файлов и бенчмарку Arm (это измеренные факты); средняя по латентности OPUS-MT/Bergamot на мобильных (оценки, не замеры) и по качеству Hy-MT2 на en→ru (нет независимого бенчмарка).
