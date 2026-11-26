# BiliReader — перенос на другую машину и ОС

Что переносится через git, что копируется руками, какие версии нужны и в каком порядке
поднимать проект. Состояние — [STATUS.md](STATUS.md), планы — [ROADMAP.md](ROADMAP.md).

## Оглавление

1. [Что версионируется, а что нет](#1-что-версионируется-а-что-нет)
2. [Версии окружения](#2-версии-окружения)
3. [Linux](#3-linux)
4. [Windows](#4-windows)
5. [macOS](#5-macos)
6. [Переменные окружения](#6-переменные-окружения)
7. [Пути данных](#7-пути-данных)
8. [Чек-лист переноса](#8-чек-лист-переноса)
9. [Что проверить после переноса](#9-что-проверить-после-переноса)

## 1. Что версионируется, а что нет

| Объект | В git | Как переносить |
|---|---|---|
| Исходники, `Cargo.lock`, `Cargo.cef.lock`, `pnpm-lock.yaml` | да | `git clone` |
| Git-субмодули (8 шт.) | указатели да, содержимое нет | `git submodule update --init --recursive` |
| `packages/swift-rs` | да, обычный каталог (вендорный патч) | вместе с клоном |
| `apps/readest-app/.env`, `.env.tauri`, `.env.web` и их `.example` | да | уже в клоне; сверить `NEXT_PUBLIC_APP_PLATFORM` |
| `node_modules/`, `target/` | нет | пересоздаются `pnpm install` и сборкой |
| `dist/` (AppImage, deb, SHA256SUMS) | нет | копировать отдельно; пересобрать скриптом |
| `output/`, `.opencode/`, `task.txt` | нет | локальные артефакты агентов; в свежем клоне их не будет |
| Модель `Hy-MT2-1.8B-Q4_K_M.gguf` (1.13 ГБ) | нет | скачать в приложении или скопировать вручную |
| Словарь FreeDict, шрифты PT, `samples/` | да | вместе с клоном |

Важно: `output/`, `dist/`, `.opencode/` исключены через **`.git/info/exclude`**, а не
`.gitignore`. Этот файл не клонируется — в новой копии они снова станут untracked; при
желании повторите записи:

```sh
printf 'output/\ntask.txt\n.opencode/\ndist/\n' >> .git/info/exclude
```

Субмодули (`.gitmodules`):

| Путь | Upstream |
|---|---|
| `packages/foliate-js` | `MariganMarigam/foliate-js` (ветка `feat/text-index`) |
| `packages/tauri` | `readest/tauri` (ветка `readest`) |
| `packages/simplecc-wasm` | `readest/simplecc-wasm` |
| `packages/qcms` | `mozilla/pdf.js.qcms` |
| `packages/js-mdict` | `readest/js-mdict` |
| `apps/readest-app/src-tauri/plugins/tauri-plugin-turso` | `readest/tauri-plugin-turso` |
| `apps/readest-app/src-tauri/plugins/tauri-plugin-webview-upgrade` | `readest/tauri-plugin-webview-upgrade` |
| `apps/readest-app/.claude/skills/gstack` | `garrytan/gstack` |

## 2. Версии окружения

Проверено на Linux 2026-11-26; источник — `docs/toolchain.md` и `docs/baseline.md`.

| Инструмент | Версия | Обязательность |
|---|---|---|
| Node.js | **24.22.2** (nvm), 24.x | обязателен |
| pnpm | **11.1.1** (пин `packageManager`) | обязателен |
| Rust / cargo | **1.99.1** stable; MSRV в `Cargo.toml` — 1.90, план требовал ≥ 1.95 | обязателен |
| rustup | 1.29.2 | рекомендуется |
| cmake | 3.x | обязателен: CEF и llama.cpp собираются CMake |
| ninja | 1.x | обязателен |
| clang / libclang | 18 (`/usr/lib/llvm-18/lib`) | обязателен для CEF (`LIBCLANG_PATH`) |
| GTK | 3.24.41 | Linux, desktop/CEF |
| WebKitGTK / JavaScriptCore | 2.52.6 | Linux, режим `--desktop` |
| JDK | 17.0.20.1 | только Android |
| NDK | 28.2.13676358 | только Android |

## 3. Linux

Пакеты — тот же список, что в CI (полный разбор: [toolchain.md](toolchain.md)):

```sh
sudo apt-get update
sudo apt-get install -y pkg-config libasound2-dev libclang-dev g++ libfontconfig-dev \
  libgtk-3-dev libwebkit2gtk-4.1 libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1 \
  libjavascriptcoregtk-4.1-dev gir1.2-javascriptcoregtk-4.1 gir1.2-webkit2-4.1 \
  libayatana-appindicator3-dev librsvg2-dev patchelf xdg-utils \
  libnss3 libpulse0 libspeechd2 libxkbcommon-x11-0 cmake ninja-build
```

`libappindicator3-dev` конфликтует с уже установленным `libayatana-appindicator3-1`;
используйте `libayatana-appindicator3-dev`. Для CEF нужен X11 (Wayland не поддерживается).
Проверка: `bash scripts/bilireader-check-toolchain.sh` (ненулевой код при любом `FAIL`).

## 4. Windows

| Компонент | Что ставить | Зачем |
|---|---|---|
| WebView2 | Evergreen Runtime (или MS Edge); в конфиге `webviewInstallMode: embedBootstrapper` | рендер окна (wry, не CEF) |
| Visual Studio Build Tools 2022 | рабочая нагрузка «Desktop development with C++» (MSVC, Windows SDK) | компиляция Rust и llama.cpp |
| Rust | `rustup default stable-msvc`; цель `x86_64-pc-windows-msvc` | тулчейн MSVC |
| Node.js + pnpm | 24.x и 11.1.1 | фронтенд |
| CMake + Ninja | в PATH | сборка `llama-cpp-sys-2` |
| NSIS / WiX | скачивает бандлер сам | установщик `.exe` / `.msi` |

Отличия от Linux:

- `apps/readest-app/scripts/tauri.mjs` применяет CEF только на Linux; на Windows идёт
  обычный wry-путь, `TAURI_CEF_CARGO` не нужен, `Cargo.cef.lock` не используется.
- Сборка: `pnpm -C apps/readest-app tauri build` (bundle targets `all` → NSIS + MSI).
- Скрипты `scripts/bilireader-*.sh` — bash; в Git Bash работают, но проверяйте пути.
- Модель и данные — в `%APPDATA%` (см. §7); `BIREADER_MODELS_DIR` — через `setx` или PowerShell.

## 5. macOS

| Шаг | Команда |
|---|---|
| Инструменты | `xcode-select --install` (Xcode CLT; полный Xcode не обязателен) |
| Rust-цель | `rustup target add aarch64-apple-darwin` (Intel: `x86_64-apple-darwin`) |
| Сборка | `pnpm -C apps/readest-app tauri build --target aarch64-apple-darwin` |
| Минимум ОС | 12.0 (`bundle.macOS.minimumSystemVersion`) |

Отличия: WebKit системный (GTK/CEF не нужны), бандлы — `.app`/`.dmg`. `Cargo.toml` уже
патчит `swift-rs` вендорной копией под Xcode 26 (Swift 6.2) — не удаляйте патч. Пути
данных — `~/Library/Application Support/...` (§7).

## 6. Переменные окружения

| Переменная | Значение | Когда нужна |
|---|---|---|
| `BIREADER_MODELS_DIR` | каталог с `Hy-MT2-1.8B-Q4_K_M.gguf` | движок ищет модель здесь, если в настройках пусто |
| `BIREADER_MODEL_PATH` | полный путь к `.gguf` | тесты и dev-запуски; приоритет выше каталога |
| `TAURI_CEF_CARGO=1` | `1` | заставить `scripts/tauri.mjs` использовать `cargo tauri` из `readest/tauri` (иначе npm `cli-cef`, который ломает AppImage) |
| `LIBCLANG_PATH` | `/usr/lib/llvm-18/lib` | CEF-сборка, если libclang не в стандартном месте |
| `TAURI_CEF_CLI` | путь к распакованному `tauri.js` npm-пакета | offline/Flatpak-сборка без `pnpm dlx` |
| `RUNTIME`, `DWARFS_CMD` | пути к `uruntime` и `mkdwarfs` | обход DNS-сбоя appimagetool |
| `TAURI_SIGNING_PRIVATE_KEY` | ключ minisign | подпись апдейтера; без него сборка идёт с `--no-sign` |
| `CARGO_PROFILE_DEV_DEBUG` | — | **не нужен**: профиль зафиксирован в `Cargo.toml` (`[profile.dev] debug = 0`) |

Приоритет каталога модели: `settings.localTranslator.modelsDir` → `BIREADER_MODELS_DIR` →
`<data_dir>/bilireader/models`.

## 7. Пути данных

`<appData>` — каталог Tauri для идентификатора `com.bilireader.app`.

| ОС | Данные приложения | Модель по умолчанию (движок) |
|---|---|---|
| Linux | `~/.local/share/com.bilireader.app/Readest/` | `~/.local/share/bilireader/models/` |
| Windows | `%APPDATA%\com.bilireader.app\Readest\` | `%APPDATA%\bilireader\models\` |
| macOS | `~/Library/Application Support/com.bilireader.app/Readest/` | `~/Library/Application Support/bilireader/models/` |

Внутри каталога данных: `Books/<hash>/` (файл книги + `config.json` с `progress`),
`library.json`, `bilireader/models/` — то, что скачал менеджер моделей. Если в
Settings → Storage задан свой каталог, пути меняются.

## 8. Чек-лист переноса

```sh
# 1. Клон с субмодулями
git clone --recurse-submodules https://github.com/MariganMarigam/BiliReader <project>
cd <project> && git checkout bilireader/main

# 2. Если клонировали без --recurse-submodules
git submodule update --init --recursive

# 3. Node 24 и pnpm 11.1.1
nvm install 24 && nvm use 24
npm install -g pnpm@11.1.1        # corepack на медленной сети падает по таймауту

# 4. Зависимости (lock-файл обязателен)
pnpm install --frozen-lockfile

# 5. Vendored-ассеты (pdf.js и simplecc)
pnpm --filter @readest/readest-app setup-vendors

# 6. Системные библиотеки и линковка (Linux)
bash scripts/bilireader-check-toolchain.sh

# 7. Быстрый запуск: UI в браузере, без Rust
scripts/bilireader-run.sh                 # http://localhost:3000

# 8. Desktop-окно (WebKitGTK): 10–15 мин холодная сборка, 2–3 ГБ
scripts/bilireader-run.sh --desktop

# 9. Релизная сборка Linux (CEF): ≥ 8 ГБ свободно, 25–45 мин
scripts/bilireader-build-linux.sh

# 10. Модель перевода (1.13 ГБ) — скачать в Settings → Language → Offline engine
#     или скопировать файл и указать каталог:
export BIREADER_MODELS_DIR="$HOME/.local/share/bilireader/models"
```

Если `git status` показывает `output/`, `dist/`, `.opencode/` — это ожидаемо после клона,
см. §1.

## 9. Что проверить после переноса

| Проверка | Команда / действие | Ожидаемо |
|---|---|---|
| Типы | `pnpm -C apps/readest-app exec tsc --noEmit` | rc=0 |
| Тесты JS | `pnpm -C apps/readest-app test:pr:web:unit` | 15110 passed, 16 skipped, 0 failed |
| Rust-ядро | `pnpm --filter @readest/readest-app test:tauri` | зелёный (нужен дисплей) |
| Перевод | Settings → Offline engine: статус `Installed`; удержать строку в `samples/sample.epub` | попап с переводом, первый ответ дольше, далее из кэша |
| Словарь | двойной клик по `dog`, затем `ran` | карточка FreeDict; `ran` → статья `run`; неизвестное слово уходит в переводчик |
| Шрифты | Settings → Font → Serif: `PT Serif (offline)` | кириллица без сети |
| Артефакты | `sha256sum -c SHA256SUMS` в каталоге с AppImage/deb | оба `OK` |
