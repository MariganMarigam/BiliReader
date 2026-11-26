# Stage 1 — Встроенный llama.cpp: выбор подхода + спека шага 1.1

**Дата:** 2026-11-05
**Автор:** Scout
**Статус:** решение + execution contract для @ivan. Внешние факты проверены 2026-11-05 по crates.io API, исходникам `utilityai/llama-cpp-rs`, GitHub API (PR/issue), cargo book.
**Вход:** `output/plan/phase-0-1.md` §2.3, Step 1.1, Step 1.6.

---

## 1. Решение (TL;DR)

**Выбран подход B: крейт `llama-cpp-2` 0.1.161 (+ транзитивный `llama-cpp-sys-2` 0.1.161), с зафиксированным путём миграции на свой форк llama.cpp.**

Подход A (вендоринг + ручной FFI) **отклонён**: ручные `#[repr(C)]` структуры `llama_context_params` / `llama_model_params` / `llama_batch` дублируют то, что уже сгенерировано bindgen'ом и обновляется еженедельно; при каждом бампе llama.cpp это ревалидация вручную + риск UB. Шаг 1.6 «скопировать сигнатуры дословно из llama.h» — это и есть работа, которую `llama-cpp-sys-2` уже делает (1124-строчный `src/llama.rs`, 100 % generated).

Подход C (`llama_cpp` edgenai 0.3.2) **отклонён**: последний релиз 2024-04-29 (2,5 года), 51 600 скачиваний против 1,86 млн у B, нет Android/iOS-поддержки, нет `llama_batch` современного API.

**Ключевой факт, который решает дело:** `llama-cpp-sys-2` пиннит в сабмодуле ровно тот commit llama.cpp, который уже выбран в `phase-0-1.md` §2.3 — `8642541b255bfb5dc39cd351a178be09013a55d6` (v0.8.0, 2026-10-28). То есть план и крейт согласованы по версии C++-ядра, и нам не нужно вендорить ничего в Фазе 1.

---

## 2. Доказательства (проверено)

### 2.1 Крейты (crates.io API, 2026-11-05)

| Крейт | max_version | Опубликован | Скачиваний | Репозиторий |
|---|---|---|---|---|
| `llama-cpp-2` | 0.1.161 | 2026-11-03 | 1 862 287 | utilityai/llama-cpp-rs |
| `llama-cpp-sys-2` | 0.1.161 | 2026-11-03 | 1 877 898 | utilityai/llama-cpp-rs |
| `llama_cpp` (edgenai) | 0.3.2 | **2024-04-29** | 51 600 | edgenai/llama_cpp-rs |

Ритм релизов B: 0.1.154 (2026-08-05), .155 (08-31), .156 (09-02), .157 (09-22), .158 (09-30), .159 (10-07), .160 (10-15), .161 (11-03) — примерно раз в 1–3 недели.
`llama.cpp` upstream: v0.9.0 (2026-11-04) → крейт отстаёт на 1 релиз/неделю.

### 2.2 Что вендорено внутри `llama-cpp-sys-2`

- `llama.cpp` — git-сабмодуль внутри крейта, commit `8642541b255bfb5dc39cd351a178be09013a55d6` («llama.cpp : bump version to 0.8.0 (#31309)», 2026-10-28). Источник: GitHub API `/contents/llama-cpp-sys-2/llama.cpp` + `/commits/<sha>`.
- Публикуемый `.crate` включает исходники: `Cargo.toml` §`include` содержит `/llama.cpp/ggml`, `/llama.cpp/include`, `/llama.cpp/src`, `/llama.cpp/common`, `/llama.cpp/vendor`.
- **bindgen в build-time НЕ используется.** `[build-dependencies]` = `cc`, `cmake`, `find_cuda_helper`, `glob`, `walkdir`; привязки лежат готовыми (`llama-cpp-sys-2/src/{llama,ggml,gguf,common}.rs`, шапка `lib.rs:13` — «These files are generated with `cargo run --bin generate-bindings`»). README крейта про «нужен clang» **устарел**. → кросс-компиляция не требует host-clang с sysroot Android/iOS.

### 2.3 Android / iOS в build.rs (`llama-cpp-sys-2/build.rs`, 1350 строк)

| Что | Где | Как |
|---|---|---|
| Определение target | `:60-83` | `arm64-v8a`, `aarch64-linux-android`, `armv7`, `x86_64`, `i686` — все Android-триплеты поддержаны явно |
| NDK | `:249-281` | `ANDROID_NDK` → `ANDROID_NDK_ROOT` → `NDK_ROOT` → `CARGO_NDK_ANDROID_NDK` → автопоиск `$ANDROID_HOME/ndk/<последняя по сортировке>`; паника, если не найдено |
| API level | `:286-290` | `ANDROID_API_LEVEL` → `ANDROID_PLATFORM=android-NN` → `CARGO_NDK_ANDROID_PLATFORM`, **default 28** |
| ABI | `:302-315` | `ANDROID_ABI` = `arm64-v8a` и т.д. |
| STL | `:696-718`, `:1303-1313` | фичи `static-stdcxx` (`ANDROID_STL=c++_static`, линкует `c++_static`+`c++abi`) / `shared-stdcxx`; без фич — cc-крейт линкует `c++_shared` |
| Apple | `:68-72`, `:664-673`, `:1293-1301` | generic `target.contains("apple")`: `GGML_BLAS=OFF`, линкует `Foundation`, `Metal`, `MetalKit`, `Accelerate`, `libc++`; Metal-бэкенд отключается только для watchOS |
| OpenMP | `:975` | на Android принудительно выключен |
| CPU-фичи ARM | `:732` | `GGML_CPU_ARM_ARCH` — переопределяемо (dotprod/i8mm) |

### 2.4 CI покрытие (факт, не мнение)

`.github/workflows/llama-cpp-rs-check.yml`: джобы `check` (ubuntu x86_64), `arm64` (ubuntu-26.04-arm **linux**, не Android), `mac` (macOS), `windows`, `emscripten`. **Джоб Android и iOS в CI нет.**

Компенсация: 14 issue с `android` в заголовке, последние закрыты 2026-10-08 (#1140 NDK target triple с API level, #1084 Vulkan android, #872 c_char в android-сборке), #605 «Build for aarch64-linux-android» закрыт 2026-08-27. iOS: #949 «feat: add iOS support» закрыт 2026-03-23. → мобильные таргеты поддерживаются и правятся, но **никем не тестируются автоматически** → первый Android-билд у нас = первый настоящий тест.

### 2.5 Rust API (0.1.161, точные сигнатуры из исходников)

```rust
// llama-cpp-2/src/llama_backend.rs:45   — ОДИН инстанс на процесс
LlamaBackend::init() -> Result<LlamaBackend, LlamaCppError>   // повторный вызов → BackendAlreadyInitialized (:21)
// llama-cpp-2/src/model.rs:347
LlamaModel::load_from_file(_: &LlamaBackend, path: impl AsRef<Path>, params: &LlamaModelParams) -> Result<Self, LlamaModelLoadError>
// model.rs:406 — контекст ЗАИМСТВУЕТ модель, время жизни 'a
fn new_context<'a>(&'a self, _: &LlamaBackend, params: LlamaContextParams) -> Result<LlamaContext<'a>, LlamaContextLoadError>
// model.rs:126
fn vocab(&self) -> LlamaVocab<'_>
// vocab.rs:222 / :425 / :84
fn tokenize(&self, text: &[u8], add_special: bool, parse_special: bool) -> Vec<LlamaToken>
fn token_to_piece(&self, token: LlamaToken, special: bool, lstrip: Option<NonZeroU16>) -> Vec<u8>
fn is_eog(&self, token: LlamaToken) -> bool
// model.rs:319 / :541 / :100
fn chat_template(&self, name: Option<&str>) -> Result<LlamaChatTemplate, ChatTemplateError>
fn apply_chat_template(&self, tmpl: &LlamaChatTemplate, chat: &[LlamaChatMessage], add_ass: bool) -> Result<String, ApplyChatTemplateError>
LlamaChatMessage::new(role: String, content: String) -> Result<Self, NewLlamaChatMessageError>
// context.rs:28,44 — Send, но НЕ Sync; model.rs:35,37 — Send + Sync
unsafe impl Send for LlamaContext<'_> {}   // Sync отсутствует
// context.rs:108
fn decode(&mut self, batch: &mut LlamaBatch) -> Result<(), DecodeError>
// llama_batch.rs:143 / :52
LlamaBatch::new(n_tokens: usize, n_seq_max: i32) -> Self
fn add(&mut self, LlamaToken, pos: llama_pos, seq_ids: &[i32], logits: bool) -> Result<(), BatchAddError>
// sampling.rs:686 / :175 / :87
LlamaSampler::greedy() -> Self ; LlamaSampler::chain_simple(impl IntoIterator<Item=Self>) -> Self
fn sample(&mut self, ctx: &LlamaContext<'_>, idx: i32) -> LlamaToken   // idx=-1 → последний; accept делается внутри
// context/params/get_set.rs:21 / :172 / :53 — ВНИМАНИЕ: with_n_ctx берёт Option
fn with_n_ctx(mut self, n_ctx: Option<NonZeroU32>) -> Self
fn with_n_threads(mut self, n_threads: i32) -> Self
fn with_n_batch(mut self, n_batch: u32) -> Self
// context/kv_cache.rs:103
fn clear_kv_cache(&mut self)
```

**Следствия для архитектуры (жёсткие, не рекомендации):**
1. `LlamaBackend::init()` — глобальный синглтон; инициализировать ровно один раз.
2. `LlamaContext<'a>` заимствует модель → хранить их в одном `struct` нельзя без self-reference. Решение: **выделенный поток**, внутри которого `model` и `context` — локальные переменные одной функции; тогда `LlamaEngine` наружу отдаёт только канал (Sync-безопасно), а `Sync` для контекста не нужен вовсе.
3. Отмена генерации в llama.cpp API отсутствует → единственный механизм: проверка `AtomicBool` в цикле сэмплинга между токенами.
4. Стриминг токенов — цикл `sample → token_to_piece` (готового стрима в крейте нет, но он и не нужен).

### 2.6 Смена ядра на патченный форк (STQ PR #22836)

PR `ggml-cpu : add STQ1_0 ternary quantization with ARM NEON vec_dot kernel`: **open**, head `1e411d8f5a1e23525fa3265dfb4bd76265465397`, 17 файлов, **+374/−4**. Публичные заголовки: `include/llama.h` (+1) и `ggml/include/ggml.h` (+2/−1) — **аддитивное значение enum**, изменения layout структур нет → предгенерированные привязки `llama-cpp-sys-2` остаются ABI-корректными, грузить STQ-GGUF можно без правок Rust-кода.

Способ подмены (единственный, т.к. env-переменной «путь к исходникам llama.cpp» в крейте **нет**: `build.rs:423` — `Path::new(CARGO_MANIFEST_DIR).join("llama.cpp")`, а фича `system-ggml` относится только к ggml):

1. Форк `utilityai/llama-cpp-rs` → ветка `bilireader/stq`, в ней сабмодуль `llama-cpp-sys-2/llama.cpp` переустановлен на форк `bilireader/llama.cpp` = `8642541b…` + cherry-pick `1e411d8f…` (плюс, при необходимости, `2af64dd0…` из #19357).
2. В `apps/readest-app/src-tauri/Cargo.toml`:
   ```toml
   [patch.crates-io]
   llama-cpp-2     = { git = "https://github.com/bilireader/llama-cpp-rs", branch = "bilireader/stq" }
   llama-cpp-sys-2 = { git = "https://github.com/bilireader/llama-cpp-rs", branch = "bilireader/stq" }
   ```
   Cargo **клонирует сабмодули git-зависимостей рекурсивно** (cargo book, «Git submodules»: «Cargo automatically fetches its submodules recursively»); при проблемах с лишними сабмодулями — документированный opt-out `submodule.<name>.update = none` в `.gitmodules` форка (ровно этот приём уже применён в `Cargo.toml:104-109` для форка `localsend`).
3. **Требование:** в манифесте зависимость объявляется caret-версией `"0.1.161"` (не `=0.1.161`), иначе `[patch]` не применится («patch not used»), а точность держит закоммиченный `Cargo.lock`. `links = "llama"` у sys-крейта гарантирует, что двух версий ядра в графе быть не может — подмена всегда полная.

Альтернатива без форка на первом шаге: Фаза 1 живёт на crates.io-версии (`8642541b…` == наш пин), шаг 2.3 добавляет только блок `[patch.crates-io]` — Rust-код не меняется.

---

## 3. Матрица сравнения (по критериям задачи)

| Критерий | A. Вендоринг + ручной FFI | **B. llama-cpp-2 0.1.161** | C. llama_cpp 0.3.2 |
|---|---|---|---|
| Сборка Android arm64 | вручную: cmake + NDK toolchain + link args (план Step 1.6 п.2) | из коробки: NDK/ABI/API/STL в `build.rs:249-315,696-718` | нет (2024, до мобильной поддержки) |
| Сборка iOS | вручную: cmake Xcode toolchain, frameworks | из коробки: Apple-ветка линкует Metal/Accelerate/Foundation/libc++ (`:1293-1301`), #949 merged | нет |
| Свой форк llama.cpp | естественно (свой сабмодуль) | через форк крейта + `[patch.crates-io]` (2 файла правок) | не поддерживается |
| Время первой сборки | cmake llama.cpp + наш build.rs + ничего не кэшируется между таргетами | cmake llama.cpp, тот же объём C++; **оценка** 4–8 мин на 4 ядрах, ~1,5–3 ГБ промежуточных объектов в `target/` (замер — спайк S2) | то же |
| Размер `target` | сопоставим (тот же C++) | сопоставим; `default-features=false` убирает `libcommon.a` (~14 МБ, комментарий в `Cargo.toml` sys-крейта) | — |
| Стриминг токенов | писать самому | цикл `sample`/`token_to_piece` (есть всё) | нет батч-API |
| Отмена генерации | свой флаг в своём цикле | свой флаг в своём цикле (то же) | нет |
| Зрелость/активность | наш код | 1,86 млн загрузок, релизы каждые 1–3 недели, мобильные фиксы идут | мёртв 2,5 года |
| Tauri (Send/Sync) | `unsafe impl Send/Sync` на сырых указателях (план Step 1.6) | модель `Send+Sync`; контекст `Send`, но не `Sync` → выделенный поток, без `unsafe impl` | `unsafe impl` внутри крейта |
| Риск UB | высокий: ручные `#[repr(C)]`, дрейф полей при бампе | низкий: структуры сгенерированы из того же `llama.h` | средний |
| Готовые примеры Tauri | нет | **публичных Tauri-примеров практически нет** (GitHub repo-search «llama-cpp-2 tauri» → 1 репозиторий, 0★, `jbannach-dev/local-platy`, push 2026-05-18). Интеграция пишется с нуля, но она тривиальна (см. §5) | нет |

**Отдельно про «ручной FFI» из плана:** `phase-0-1.md` Step 1.6 п.1 требует «скопировать сигнатуры дословно из llama.h». Это ровно то, что делает `llama-cpp-sys-2/src/llama.rs` (автогенерация, 1124 строки, CI-проверка «Regenerate bindings → git diff --exit-code»). Плюс в плане `unsafe impl Send for LlamaEngine` на структуре с `*mut` — при `model`+`ctx` в одном объекте это UB-риск при конкурентном доступе; в B этой проблемы нет by design.

---

## 4. Риски (сверху — главный)

1. **Android: переменная NDK не совпадает.** `llama-cpp-sys-2/build.rs:249` читает `ANDROID_NDK`/`ANDROID_NDK_ROOT`/`NDK_ROOT`/`CARGO_NDK_ANDROID_NDK`, **но не** `NDK_HOME` и **не** `ANDROID_NDK_HOME`. Tauri CLI выставляет `NDK_HOME`, а `gen/android/app/build.gradle.kts:138` и `scripts/bilireader-check-toolchain.sh:80` работают с `NDK_HOME`/`ANDROID_NDK_HOME`. Без экспорта `ANDROID_NDK` build.rs уйдёт в автопоиск «последнего NDK в `$ANDROID_HOME/ndk`» → **недетерминированная версия NDK вместо пиннинга 28.2.13676358**. Обязательный фикс — в команде сборки (§5.6).
2. **Android: API level по умолчанию 28, а `minSdk = 26`** (`gen/android/app/build.gradle.kts:51`). Компиляция линкует `-D__ANDROID_API__=28`; вызовы символов, добавленных в 27/28, упадут на устройствах API 26. Фикс: `ANDROID_PLATFORM=android-26`.
3. **Android: `c++_shared` по умолчанию.** Без фич STL cc-крейт линкует `c++_shared` → APK обязан везти `libc++_shared.so` (сейчас его нет; в gradle упоминается только BOOX-вариант `libc++.so`). Фикс: фича `static-stdcxx` (см. §5.1). Обратная сторона — на Linux она линкует `libstdc++.a` и требует наличия статического архива (`emit_compiler_static_archive_search_path`).
4. **Android 15+: требование 16 КБ page size** для нативных библиотек. NDK r28 умеет; нужно проверить `llvm-readelf -l libreadest_lib.so | grep LOAD` на `align 0x4000` в Verify. Если нет — `-Wl,-z,max-page-size=16384` в `build.rs` (link-arg).
5. **Нет мобильного CI у крейта** (§2.4) — первый Android-билд проверяет нашу сборку впервые. Смягчение: спайк S2 строит `aarch64-linux-android` до начала работ по 1.6.
6. **Диск 9,3 ГБ свободно** (`df -h /`), правило AGENTS.md — перед сборкой ≥ 8 ГБ. C++-объекты llama.cpp добавят ~1,5–3 ГБ на архитектуру (x86_64 + aarch64). Перед сборкой: `scripts/bilireader-clean.sh --yes`.
7. **`LlamaBackend::init()` — синглтон**: второй вызов = `BackendAlreadyInitialized`. Держим инициализацию только в потоке L3, никаких других инициализаций llama.cpp в процессе (важно для тестов: тесты не должны звать `init()`).
8. **Пиннинг**: `llama-cpp-2` «does not follow semver meaningfully» (README) → caret-версия + `Cargo.lock` в коммите; обновление — отдельным шагом с прогоном S2-бенчмарка.
9. **iOS**: поддержка заявлена (#949), но не в CI; Metal-фреймворки линкуются всегда (инференс всё равно CPU при `n_gpu_layers=0`). Проверять только на шаге iOS, не раньше.

---

## 5. Спека шага 1.1 (execution contract)

> **Замещение:** этот шаг **отменяет** Step 1.1 из `phase-0-1.md` в части имён команд (там 9 команд `translation_*`, здесь 3) и **поглощает** llama-часть Step 1.6 (движок L3 реализуется здесь). Step 1.6 остаётся только как спайк S2 (бенчмарк на реальной модели) + шаг 2.3 (форк). Остальные команды (`translation_cache_*`, `translation_model*`) приходят своими шагами 1.2/1.7 с теми же правилами регистрации.

### 5.1 `apps/readest-app/src-tauri/Cargo.toml` — MODIFY

**Место:** в `[dependencies]` сразу после строки 130 `md-5 = "0.10"`.

```toml
# L3-перевод: llama.cpp в процессе. `llama-cpp-sys-2` вендорит llama.cpp
# 8642541b255bfb5dc39cd351a178be09013a55d6 (v0.8.0) — тот же пин, что в
# output/plan/phase-0-1.md §2.3. Caret-версия обязательна: `=0.1.161`
# заблокирует [patch.crates-io] при переходе на форк STQ (шаг 2.3).
# Точность держит Cargo.lock.
llama-cpp-2 = "0.1.161"

# STL: на Android и Linux линкуем C++-рантайм статически (c++_static /
# libstdc++.a), иначе APK обязан везти libc++_shared.so, а Linux-бинарь
# получает DT_NEEDED libstdc++ (см. verify шага 1.6).
[target.'cfg(any(target_os = "android", target_os = "linux"))'.dependencies]
llama-cpp-sys-2 = { version = "0.1.161", features = ["static-stdcxx"] }
```

**НЕ добавлять:** `cmake` в `[build-dependencies]` (не нужен — cmake зовёт sys-крейт), `bindgen`, `cc`. Никакого `vendor/llama.cpp` в `src-tauri/`.

**Команды фиксации версий** (из `apps/readest-app/src-tauri`):
```
cargo add -p Readest llama-cpp-2@0.1.161
cargo add -p Readest --target 'cfg(any(target_os = "android", target_os = "linux"))' llama-cpp-sys-2@0.1.161 --features static-stdcxx
cargo check -p Readest          # первая сборка llama.cpp: 4–8 мин, это ожидаемо
```

### 5.2 `src/translation_core/engine.rs` — CREATE

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level { L1, L2, L3 }

impl Level {
    pub fn as_str(self) -> &'static str;           // "l1" | "l2" | "l3"
    pub fn parse(s: &str) -> Option<Level>;        // регистронезависимо
}

/// Отмена одной генерации. Clone дёшев (Arc).
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self;                          // Self(Arc::new(AtomicBool::new(false)))
    pub fn cancel(&self);                          // self.0.store(true, Ordering::SeqCst)
    pub fn is_cancelled(&self) -> bool;            // self.0.load(Ordering::Relaxed)
}

/// Приёмник стрима. Реализация для () — no-op (используется в тестах/батче).
pub trait TokenSink { fn on_token(&mut self, piece: &str); }
impl TokenSink for () { fn on_token(&mut self, _piece: &str) {} }

#[derive(Debug, Clone, Default)]
pub struct EngineOutput { pub text: String, pub tokens: usize }

pub struct EngineRequest<'a> {
    pub text: &'a str,
    pub context: Option<&'a str>,
    pub max_new_tokens: usize,
}

pub trait Engine: Send + Sync {
    fn id(&self) -> &'static str;                  // "llama-cpp-2"
    fn level(&self) -> Level;                      // Level::L3
    fn translate(&self, req: &EngineRequest<'_>, cancel: &CancelToken, sink: &mut dyn TokenSink)
        -> Result<EngineOutput, EngineError>;
}
```

`EngineError` живёт в `error.rs` (уже в манифесте плана). Обязательные варианты для этого шага:
`ModelMissing(String)`, `NotLoaded`, `Backend(String)`, `Cancelled`, `Panic`, `InvalidInput(String)`, `Closed`. `#[derive(Debug, thiserror::Error)]`, `Display` заполняется.

### 5.3 `src/translation_core/llama.rs` — CREATE

Константа провенанса (пишется в `CoreStatus`, попадает в `docs/PROVENANCE.md`):
```rust
pub const LLAMA_CPP_PIN: &str = "8642541b255bfb5dc39cd351a178be09013a55d6";
pub const WRAPPER: &str = "llama-cpp-2 0.1.161";
```

**Публичный API:**
```rust
#[derive(Debug, Clone)]
pub struct LlamaConfig {
    pub n_ctx: u32,            // 2048
    pub n_threads: i32,        // available_parallelism().min(4)
    pub max_new_tokens: usize, // 128
    pub system_prompt: String, // "Translate the following English text to Russian. Output translation only."
}

impl Default for LlamaConfig { /* значения выше; n_threads считает available_parallelism() */ }

pub struct LlamaEngine { tx: std::sync::Mutex<std::sync::mpsc::Sender<Job>> }

impl LlamaEngine {
    /// Спавнит поток `llama-l3`, который владеет backend+model+context.
    /// Возвращает Err, если поток не смог инициализироваться (битый/отсутствующий GGUF,
    /// BackendAlreadyInitialized, OOM) — ошибка приходит через handshake-канал.
    pub fn open(gguf_path: &Path, cfg: LlamaConfig) -> Result<Self, EngineError>;
    pub fn config(&self) -> &LlamaConfig;  // через Arc<LlamaConfig> внутри
}

impl Engine for LlamaEngine { /* level() = L3, id() = WRAPPER */ }
impl Drop for LlamaEngine { /* дропает tx → поток выходит из recv() */ }
```

**Внутренние типы:**
```rust
struct Job {
    text: String,
    context: Option<String>,
    max_new_tokens: usize,
    cancel: CancelToken,
    sink: Box<dyn FnMut(&str) + Send>,
    reply: std::sync::mpsc::Sender<Result<EngineOutput, EngineError>>,
}
```

**Logic `LlamaEngine::open`:**
1. `let (tx, rx) = mpsc::channel::<Job>();` и `let (boot_tx, boot_rx) = mpsc::channel::<Result<(), EngineError>>();`
2. `let path = gguf_path.to_path_buf(); let cfg = Arc::new(cfg);`
3. `std::thread::Builder::new().name("llama-l3".into()).stack_size(8*1024*1024).spawn(move || engine_thread(path, cfg, rx, boot_tx))?` — ошибку спавна → `EngineError::Backend`.
4. `boot_rx.recv_timeout(Duration::from_secs(120))`: `Ok(Ok(()))` → `Ok(Self { tx: Mutex::new(tx) })`; `Ok(Err(e))` → `Err(e)`; `Err(Timeout)`/`Disconnected` → `Err(EngineError::Backend("llama backend init timeout"))`.
5. Модель **не грузится лениво** — `open` возвращается только после успешной загрузки (нужно для честного `local_engine_status.ready`).

**Logic `engine_thread`:**
1. `let backend = match LlamaBackend::init() { Ok(b) => b, Err(e) => { boot_tx.send(Err(EngineError::Backend(format!("{e}")))); return; } };`
2. `if !path.exists() { boot_tx.send(Err(EngineError::ModelMissing(path.display().to_string()))); return; }`
3. `let model = LlamaModel::load_from_file(&backend, &path, &LlamaModelParams::default())` — ошибка → `boot_tx.send(Err(EngineError::Backend(..)))`, `return` (никаких `unwrap`/`expect`).
4. `let cparams = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(cfg.n_ctx)).with_n_threads(cfg.n_threads);`
   (сигнатура — `with_n_ctx(Option<NonZeroU32>)`, `get_set.rs:21`; `NonZeroU32::new` уже даёт Option)
   `let mut ctx = model.new_context(&backend, cparams)` — ошибка → как в п.3.
5. `boot_tx.send(Ok(()));` затем `while let Ok(job) = rx.recv() { let r = generate(&model, &mut ctx, &cfg, job); ... }`
   `generate` возвращает `(Result<EngineOutput, EngineError>, reply_sender)` — reply отправляется **внутри** `generate` до возврата, чтобы порядок был определён; проще: `let Job { reply, .. } = &job; let r = generate(...); let _ = reply.send(r);`
6. **Порядок объявления важен:** `ctx` объявлен после `model` → при выходе из функции `ctx` дропается первым (RAII, обратный порядок). Комментарий об этом обязателен в коде.
7. Паника внутри `generate` не должна убивать поток: обернуть в `std::panic::catch_unwind(AssertUnwindSafe(|| ...))`, при панике → `Ok(Err(EngineError::Panic))` + `log::error!`. (Модель после паники остаётся валидной для следующего job — llama.cpp не освобождает ресурсы при unwind в нашем коде.)

**Logic `generate(model, ctx, cfg, job) -> Result<EngineOutput, EngineError>`:**
1. `let tmpl = model.chat_template(None).map_err(|e| EngineError::Backend(format!("chat template: {e}")))?;`
2. `let user = match job.context { Some(c) if !c.trim().is_empty() => format!("{}\n\n{}", c.trim(), job.text), _ => job.text.clone() };`
3. `let messages = [LlamaChatMessage::new("system".into(), cfg.system_prompt.clone())?, LlamaChatMessage::new("user".into(), user)?];`
4. `let prompt = model.apply_chat_template(&tmpl, &messages, true).map_err(..)?;`
5. `let tokens = model.vocab().tokenize(prompt.as_bytes(), true, false);` — пустой `tokens` → `EngineError::InvalidInput("empty prompt")`.
6. `let mut batch = LlamaBatch::new(tokens.len().max(1), 1);`
   `for (i, t) in tokens.iter().enumerate() { batch.add(*t, i as i32, &[0], i + 1 == tokens.len())?; }`
   (logits запрашиваются только на последнем токене промпта.)
7. `ctx.clear_kv_cache();` (`context/kv_cache.rs:103`, подтверждено в 0.1.161) — очистка KV между job'ами. Затем `ctx.decode(&mut batch)?`.
8. `let mut sampler = LlamaSampler::greedy();` `let vocab = model.vocab();`
   `let mut out = String::new(); let mut n_cur = tokens.len() as i32; let mut n_out = 0usize; let mut buf: Vec<u8> = Vec::with_capacity(64);`
9. Цикл:
   ```
   loop {
       if cancel.is_cancelled() { return Err(EngineError::Cancelled); }
       if n_out >= job.max_new_tokens { break; }
       let tok = sampler.sample(ctx, -1);
       if vocab.is_eog(tok) { break; }
       buf.clear();
       // token_to_piece(token, special=false, lstrip=None) -> Vec<u8>
       let piece_bytes = vocab.token_to_piece(tok, false, None);
       let piece = String::from_utf8_lossy(&piece_bytes);
       out.push_str(&piece);
       (job.sink)(&piece);
       n_out += 1;
       batch.clear();
       batch.add(tok, n_cur, &[0], true)?;
       n_cur += 1;
       ctx.decode(&mut batch)?;
   }
   ```
10. `Ok(EngineOutput { text: out.trim().to_string(), tokens: n_out })`. Отмена → `Err(Cancelled)`, частичный текст **не** возвращается и не кэшируется.

**Edge cases (обязательны):**
- ctx переполнен (`n_cur >= cfg.n_ctx`): `break` с тем, что есть (не паниковать).
- `job.text` пустой/пробельный → `Err(EngineError::InvalidInput("empty text"))` до токенизации.
- Модель с неизвестным типом квантования (Q2_0C на upstream-сборке) → `load_from_file` вернёт `Err` → `open()` → `Err`; `EngineSet.llama = None`, `status.ready=false`, `status.error=Some(..)`.
- Повторный `open()` в том же процессе → второй `LlamaBackend::init()` = `BackendAlreadyInitialized` → ошибка наверх; `TranslationCore` не должен звать `open` дважды (проверка `if llama.is_some() { return Ok(status) }`).

### 5.4 `src/translation_core/mod.rs` — CREATE

```rust
pub mod engine; pub mod error; pub mod llama;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

#[derive(Default)]
pub struct EngineSet { pub llama: Option<Arc<llama::LlamaEngine>> }

pub struct CoreInner {
    pub llama: RwLock<Option<Arc<llama::LlamaEngine>>>,
    pub cancels: Mutex<HashMap<String, engine::CancelToken>>,
    pub models_dir: RwLock<Option<PathBuf>>,
    pub last_error: RwLock<Option<String>>,
}

#[derive(Clone, Default)]
pub struct TranslationCore { inner: Arc<CoreInner> }

impl TranslationCore {
    pub fn new() -> Self;                                        // пустой, ничего не грузит
    pub fn cancels(&self) -> &Mutex<HashMap<String, engine::CancelToken>>;
    /// Идемпотентно: если движок уже загружен — возвращает статус без перезагрузки.
    pub fn ensure_engine(&self, models_dir: &Path) -> Result<bool, error::CoreError>;
    pub fn status(&self) -> CoreStatus;
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CoreStatus {
    pub ready: bool,
    pub engine: String,            // llama::WRAPPER
    pub llama_cpp_commit: String,  // llama::LLAMA_CPP_PIN
    pub model_path: Option<String>,
    pub n_ctx: u32,
    pub threads: i32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalTranslation { pub job_id: String, pub text: String, pub tokens: usize, pub ms: u64, pub cancelled: bool }
```

**Logic `ensure_engine`:** `models_dir` → `create_dir_all`; путь модели = `models_dir/hy-mt2-1.8b-q4_k_m.gguf`; если файла нет → `last_error = "model missing"`, `Ok(false)`; если есть и `llama.is_some()` → `Ok(true)`; иначе `LlamaEngine::open(...)` (вызов **блокирующий**, поэтому из команды — только внутри `spawn_blocking`) и запись в `RwLock`.

### 5.5 `src/translation_core/commands.rs` — CREATE

```rust
#[tauri::command]
pub async fn local_engine_status(
    state: tauri::State<'_, TranslationCore>,
    models_dir: String,
) -> Result<CoreStatus, String>;

#[tauri::command]
pub async fn translate_local(
    app: tauri::AppHandle,
    state: tauri::State<'_, TranslationCore>,
    job_id: String,
    text: String,
    context: Option<String>,
) -> Result<LocalTranslation, String>;

#[tauri::command]
pub fn cancel_translation(
    state: tauri::State<'_, TranslationCore>,
    job_id: String,
) -> Result<bool, String>;
```

**`local_engine_status`:** `let core = state.inner.clone(); tauri::async_runtime::spawn_blocking(move || core.ensure_engine(Path::new(&models_dir)).map(|_| core.status())).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())`
— загрузка модели 1–3 с **не должна** идти в async-пуле: обязателен `spawn_blocking`.

**`translate_local`:** 
1. `if text.trim().is_empty() { return Err("empty text".into()) }`
2. Взять движок: `let engine = { state.inner.llama.read()?.clone().ok_or("engine not loaded; call local_engine_status first")? };`
3. `let token = CancelToken::new(); state.inner.cancels.lock().insert(job_id.clone(), token.clone());`
4. `let app2 = app.clone(); let jid = job_id.clone(); let started = Instant::now();`
5. `tauri::async_runtime::spawn_blocking(move || { let mut sink = move |piece: &str| { let _ = app2.emit("translation://token", serde_json::json!({"job_id": jid, "delta": piece})); }; let req = EngineRequest { text: &text, context: context.as_deref(), max_new_tokens: 128 }; engine.translate(&req, &token, &mut sink).map(|o| (o, started.elapsed().as_millis() as u64)) }).await`
6. Снять регистрацию: `state.inner.cancels.lock().remove(&job_id);` (всегда, и при ошибке — поэтому удаление до маппинга ошибки).
7. `Err(EngineError::Cancelled)` → `Ok(LocalTranslation { text: String::new(), cancelled: true, .. })` (не ошибка IPC: UI ждёт мягкой отмены). Прочие ошибки → `Err(e.to_string())`.

**`cancel_translation`:** `Ok(state.inner.cancels.lock().get(&job_id).map(|t| { t.cancel(); true }).unwrap_or(false))` — синхронная команда, без `spawn_blocking`.

**Контракт отмены (job_id + AtomicBool):** `job_id` — UUID v4 с фронта; реестр `HashMap<String, CancelToken>` в `CoreInner`; `CancelToken` = `Arc<AtomicBool>`; воркер проверяет флаг **раз в токен** (llama.cpp не имеет callback-отмены); частичный результат отбрасывается; `cancel_translation` возвращает `true`, если job ещё активен. Повторный вызов с тем же `job_id` после завершения → `false` (не ошибка).

### 5.6 Три (четыре) места регистрации Tauri — точные строки

| # | Файл | Действие | Точное место |
|---|---|---|---|
| 1 | `apps/readest-app/src-tauri/src/lib.rs` | `mod translation_core;` | после строки **56** (`mod transfer_file;`), перед пустой строкой 57 |
| 2 | `apps/readest-app/src-tauri/src/lib.rs` | 3 элемента в `tauri::generate_handler![...]` | перед закрывающей `])` на строке **727**, после `nightly_update::install_nightly_update,` (строка 726): новые строки `translation_core::commands::local_engine_status,` / `translation_core::commands::translate_local,` / `translation_core::commands::cancel_translation,` |
| 3 | `apps/readest-app/src-tauri/src/lib.rs` | `app.manage(...)` | сразу после строки **835** (`app.manage(localsend::LocalSendState::default());`): `app.manage(translation_core::TranslationCore::new());` |
| 4 | `apps/readest-app/src-tauri/build.rs` | 3 имени в `AppManifest::new().commands(&[...])` | перед `])` на строке **88**, после `"localsend_cancel_send",` (строка 87): `"local_engine_status",` `"translate_local",` `"cancel_translation",` |
| 5 | `apps/readest-app/src-tauri/capabilities/default.json` | 3 разрешения | после `"allow-localsend-cancel-send"` (строка 266, **перед ней добавить запятую**): `"allow-local-engine-status",` `"allow-translate-local",` `"allow-cancel-translation"` |

Правила: имена в `build.rs` — **snake_case как у fn**; в `capabilities` — **kebab-case** (`allow-<kebab-command>`). Забыть любое из 4 мест = IPC «not allowed» (комментарий `build.rs:24-33`). `capabilities/webdriver-remote.json` в этом шаге **не трогаем** (E2E-тесты ядра не используют).

**Android-проверка сборки (обязательный префикс окружения — см. риск §4.1/4.2):**
```
cd apps/readest-app
export ANDROID_NDK="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/28.2.13676358}"
export ANDROID_PLATFORM=android-26
pnpm tauri android build -t aarch64 --debug
```

### 5.7 Тесты (`src/translation_core/tests.rs`, `#[cfg(test)] mod tests`)

| Тест | Что проверяет | Ассерты |
|---|---|---|
| `status_without_model_is_not_ready` | нет GGUF в пустом tempdir | `status.ready == false`, `status.llama_cpp_commit == LLAMA_CPP_PIN`, `status.error.is_some()` |
| `status_is_idempotent` | два вызова `ensure_engine` на пустом каталоге | оба `Ok(false)`, ошибка не «залипает» в панику |
| `cancel_token_flips_flag` | `CancelToken::new()`, `is_cancelled()==false`, `cancel()`, `is_cancelled()==true` | 3 ассерта |
| `cancel_unknown_job_returns_false` | `cancel_translation` логика через `CoreInner.cancels` | `false`, реестр пуст |
| `cancels_registry_drops_entry` | вставка токена + `cancel()` + `remove()` | `get(&job_id).is_none()` |
| `empty_text_is_rejected` | `translate_local`-валидация (вынесена в `fn validate_text(&str)`) | `Err` с "empty" |
| `#[ignore] generates_with_real_model` | реальный GGUF при `BILIREADER_GGUF=/path.gguf` | `text` непустой, `tokens>0`, латиница на входе → кириллица на выходе |

Тест с реальной моделью — только `#[ignore]`, запуск вручную: `cargo test -p Readest --lib generates_with_real_model -- --ignored --nocapture`.

### 5.8 Verify (по порядку)

```
cd apps/readest-app/src-tauri
cargo check -p Readest                       # → "Finished" (первый прогон 4–8 мин)
cargo test -p Readest --lib                  # → "test result: ok. 7 passed" (6 + 1 ignored)
cargo clippy -p Readest --no-deps -- -D warnings   # → 0 warnings
cd .. && pnpm test:rust                      # (package.json:52) → ok
cd <project> && df -h / | tail -1   # ≥ 8 ГБ перед Android
cd apps/readest-app && ANDROID_NDK="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/28.2.13676358}" ANDROID_PLATFORM=android-26 pnpm tauri android build -t aarch64 --debug   # → BUILD SUCCESSFUL
llvm-readelf -d target/aarch64-linux-android/debug/libreadest_lib.so | grep -c "libc++_shared"   # → 0
llvm-readelf -l target/aarch64-linux-android/debug/libreadest_lib.so | grep LOAD | head -1       # align 0x4000 (16 КБ page size)
```

### 5.9 Out of scope для 1.1

Кэш (1.2), очередь приоритетов и воркеры (1.3), словарь (1.4), Marian (1.5), менеджер моделей/скачивание (1.7), TS-провайдер (1.8), `[patch.crates-io]` и STQ-форк (2.3), iOS-сборка, `capabilities/webdriver-remote.json`, удаление `libcommon.a` через `default-features=false` (оптимизация размера — после S2), батч-перевод (в 1.1 одна пара text/context на вызов).

---

## 6. Что это меняет в `phase-0-1.md`

| Было | Стало |
|---|---|
| Step 1.1: 9 команд `translation_init/translate/cancel/...` | 3 команды: `local_engine_status` (init+status), `translate_local`, `cancel_translation`; остальные приходят в 1.2/1.7 |
| Step 1.1 п.9: `cargo add sha2 hex unicode-normalization` + `rusqlite` | плюс `llama-cpp-2`, `llama-cpp-sys-2` (см. §5.1) |
| Step 1.6 п.1-2: `llama_ffi.rs` + cmake в `build.rs` | **удаляется**; `llama.rs` реализует `Engine` поверх `llama-cpp-2` |
| Step 1.6 п.3-4: `llama_model_default_params` и ручной цикл | те же шаги через `LlamaModel::load_from_file` / `LlamaSampler` (см. §5.3 `generate`) |
| Tier 1: `src-tauri/vendor/` (сабмодуль llama.cpp) | **не создаётся**; вместо него при 2.3 — форк `llama-cpp-rs` + `[patch.crates-io]` |
| Step 1.6 Verify: `ldd | grep libstdc++ == 0` | сохраняется, но обеспечивается фичей `static-stdcxx`, а не `-static-libstdc++` в build.rs |

---

## 7. Confidence

- Выбор подхода **0.90** (факты по API/сборке/мобильным фиксам проверены напрямую в исходниках и GitHub API; единственная неопределённость — отсутствие мобильного CI у крейта).
- Точность спеки 1.1 **0.90**: сигнатуры взяты из исходников 0.1.161 (`llama.rs`/`model.rs`/`vocab.rs`/`sampling.rs`/`context/params/get_set.rs`/`context/kv_cache.rs`/`build.rs` с номерами строк). Непроверенным остаётся только фактический ELF `align` и поведение `static-stdcxx` на конкретном тулчейне.
- Android-сборка **0.7** — главный риск (нет CI, NDK-переменные не совпадают, minSdk 26 vs API 28, 16 КБ страницы). Первый Android-билд считать спайком, не «шагом».
