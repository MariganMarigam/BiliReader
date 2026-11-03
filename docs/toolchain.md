# BiliReader — Toolchain (Фаза 0, шаг 0.2)

**Дата фиксации:** 2026-11-03
**Хост:** Linux Mint 22.2 (Zara), база Ubuntu 24.04 (noble), kernel 7.0.0-42-generic, x86_64
**Проверка:** `bash scripts/bilireader-check-toolchain.sh`

## Фактические версии (после установки)

| Инструмент | Требуется планом | Фактически | Статус |
|---|---|---|---|
| Node.js | 24.x | **24.22.2** (nvm, `~/.nvm/versions/node/v24.22.2`) | OK |
| pnpm | 11.1.1 | **11.1.1** | OK |
| rustc | stable, >= 1.95 | **1.99.1** (2026-10-13) | OK |
| cargo | stable | **1.99.1** | OK |
| rustup | — | 1.29.2 | OK |
| JDK | 17 | **17.0.20.1** (OpenJDK, `/usr/lib/jvm/java-17-openjdk-amd64`) | OK |
| cmake | для llama.cpp (шаг 1.6) | **ОТСУТСТВУЕТ** | BLOCKER |
| ninja-build | для llama.cpp (шаг 1.6) | **ОТСУТСТВУЕТ** | BLOCKER |
| NDK | 28.2.13676358 | не ставился (шаг 0.4 вне этого запуска) | DEFERRED |
| Android SDK / adb | platform-tools | отсутствует | DEFERRED |

## Системные зависимости Linux (CI: `.github/workflows/nightly.yml:177`)

Точный список из CI:

```
pkg-config libasound2-dev libclang-dev g++ libfontconfig-dev libgtk-3-dev
libwebkit2gtk-4.1 libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1
libjavascriptcoregtk-4.1-dev gir1.2-javascriptcoregtk-4.1 gir1.2-webkit2-4.1
libappindicator3-dev librsvg2-dev patchelf xdg-utils
```

Плюс runtime-пакеты CEF (`nightly.yml:199`): `libnss3 libpulse0 libspeechd2 libxkbcommon-x11-0`.

### Состояние на хосте

Установлены: `pkg-config`, `g++`, `gir1.2-javascriptcoregtk-4.1`, `gir1.2-webkit2-4.1`,
`xdg-utils`, `libnss3`, `libpulse0`, `libspeechd2`, `libxkbcommon-x11-0`.

Отсутствуют (dev-пакеты, нужны для линковки Tauri/CEF):

```
libasound2-dev libclang-dev libfontconfig-dev libgtk-3-dev
libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev
libappindicator3-dev librsvg2-dev patchelf cmake ninja-build
```

`pkg-config --exists` подтверждает: `gtk+-3.0`, `webkit2gtk-4.1`, `javascriptcoregtk-4.1`,
`libsoup-3.0`, `alsa`, `fontconfig`, `libclang`, `appindicator3-0.1`, `librsvg-2.0` — не найдены.

### Блокер установки

Установка требует root. В неинтерактивной сессии `sudo` недоступен (нет пароля,
харнесс блокирует вызов), `apt-get install` без root даёт:

```
E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)
E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?
```

Отдельно: `apt-get install --dry-run` упирается в конфликт
`libayatana-appindicator3-1 : Conflicts: libappindicator3-1` (уже установлен ayatana-вариант).
При установке `libappindicator3-dev` потребуется либо удалить `libayatana-appindicator3-1`,
либо использовать `libayatana-appindicator3-dev` вместо `libappindicator3-dev`
(отклонение от CI-списка зафиксировать при выполнении).

### Команда установки (выполнять с root)

```bash
sudo apt-get update
sudo apt-get install -y pkg-config libasound2-dev libclang-dev g++ libfontconfig-dev \
  libgtk-3-dev libwebkit2gtk-4.1 libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1 \
  libjavascriptcoregtk-4.1-dev gir1.2-javascriptcoregtk-4.1 gir1.2-webkit2-4.1 \
  libayatana-appindicator3-dev librsvg2-dev patchelf xdg-utils \
  libnss3 libpulse0 libspeechd2 libxkbcommon-x11-0 cmake ninja-build
```

## Установка toolchain (без root, выполнено)

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 24 && nvm use 24          # -> v24.22.2
corepack prepare pnpm@11.1.1 --activate   # НЕ СРАБОТАЛО, см. отклонения
npm install -g pnpm@11.1.1 --force       # фактический способ установки pnpm

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh
sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain stable
RUSTUP_USE_CURL=1 rustup toolchain install stable --profile minimal   # -> 1.99.1
```

## Отклонения от плана

1. **pnpm установлен через `npm install -g pnpm@11.1.1 --force`, а не `corepack prepare`.**
   Причина: corepack в Node 24 использует undici, а undici в этой сети падает с
   `UND_ERR_CONNECT_TIMEOUT` при подключении к `registry.npmjs.org:443` (проверено:
   `curl` и `node https.get` к тому же URL возвращают 200, `fetch()` — таймаут;
   `--dns-result-order=ipv4first` и `--no-network-family-autoselection` не помогают).
   Версия pnpm совпадает с пином `packageManager` в корневом `package.json` (11.1.1).
2. **`libappindicator3-dev` → `libayatana-appindicator3-dev`** (конфликт пакетов), если
   установка будет выполняться.
3. **Android-часть (NDK, aarch64-таргеты) отложена** — шаг 0.4 вне этого запуска.

## Проверка

```bash
bash scripts/bilireader-check-toolchain.sh
```

Скрипт печатает строки `OK <tool> <version>` / `FAIL <tool> <причина>` / `SKIP <tool> <причина>`
и возвращает 1, если есть хотя бы один `FAIL`.
