# BiliReader — Baseline Linux (шаг 0.3)

**Дата:** 2026-11-03
**Хост:** Linux Mint 22.2 (Ubuntu 24.04 base), x86_64, 16 CPU, 15 GiB RAM
**Статус:** ✅ ВЫПОЛНЕН повторным прогоном после установки системных dev-пакетов —
`.AppImage`, `.deb`, `.rpm` собраны, приложение запускается (см. раздел
«Повторный прогон: сборка выполнена» в конце файла). Раздел ниже фиксирует
первый, неудачный прогон и оставлен как история.

## Условия запуска

- Свободно на `/` до установки зависимостей: **17 ГиБ** (порог плана — не менее 8 ГиБ, пройден).
- Node v24.22.2, pnpm 11.1.1, rustc 1.99.1 (см. `docs/toolchain.md`).
- Ревизия кода: `upstream/main@7a0e98f53` (`bilireader/main`).

## Выполненные шаги

| # | Команда | Результат |
|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | см. журнал ниже |
| 2 | `pnpm --filter @readest/readest-app setup-vendors` | не запускался (зависит от шага 1) |
| 3 | `pnpm tauri build` (из `apps/readest-app`) | **rc=1** через 9 мин 05 с — `glib-sys` build script: `glib-2.0` не найден |
| 4 | `pnpm tauri dev` | не запускался: падает там же, где build (та же cargo-зависимость `glib-sys`) |

### Журнал `pnpm install`

Попытка 1 (4 мин 11 с) — ошибка сети (`UND_ERR_CONNECT_TIMEOUT`, `TimeoutError`).
Причина: pnpm использует undici с жёстким 10-секундным connect timeout, а TLS-хендшейк до
`registry.npmjs.org` на этом хосте занимает 15–16 с (замер: `tls.connect` → 15805 мс; при этом
`curl` и `node https.get` к тому же URL отвечают 200). Это сетевая деградация, не ошибка кода.

Попытки 2–3 — с увеличенными `--fetch-retries/--fetch-timeout`; пакеты докачивались в store.
Попытка 4 (после прогретого store): **успех за 1 мин 09 с**, `rc=0`,
`Done in 1m 8.8s using pnpm v11.1.1`. `node_modules` — 1.7 ГиБ.

### setup-vendors

`pnpm --filter @readest/readest-app setup-vendors` → rc=0, 4.0 с; `public/vendor/pdfjs` заполнен.

### Verify (без системных библиотек)

| Команда | Результат |
|---|---|
| `pnpm --filter @readest/readest-app exec tsc --noEmit` | **rc=0**, 4.4 с |
| `... exec dotenv -e .env -- vitest run src/__tests__/utils/misc.test.ts` | **1 файл, 44 теста passed**, 0 failed, 1.5 с |

### Проба сборки (точный лог)

```
$ cd apps/readest-app && pnpm tauri build
...
   Compiling glib-sys v0.18.1
   Compiling gobject-sys v0.18.0
$ node scripts/upload-sourcemaps.mjs
Sentry: SENTRY_AUTH_TOKEN unset, skipping source map upload.
Sentry: stripped 246 .js.map file(s) from the app bundle.
    Updating git repository `https://github.com/readest/tauri`
...
error: failed to run custom build command for `glib-sys v0.18.1`
  process didn't exit successfully: `.../target/release/build/glib-sys-.../build-script-build` (exit status: 1)
  cargo:warning=
  pkg-config exited with status code 1
  > PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1 pkg-config --libs --cflags glib-2.0 'glib-2.0 >= 2.56'

  pkg-config output:
    Package glib-2.0 was not found in the pkg-config search path.
    Perhaps you should add the directory containing `glib-2.0.pc'
    to the PKG_CONFIG_PATH environment variable
    Package 'glib-2.0', required by 'virtual:world', not found

  The system library `glib-2.0` required by crate `glib-sys` was not found.
  The file `glib-2.0.pc` needs to be installed and the PKG_CONFIG_PATH environment variable must contain its parent directory.
  The PKG_CONFIG_PATH environment variable is not set.

warning: build failed, waiting for other jobs to finish...
failed to build app: failed to build app
       Error failed to build app: failed to build app
[ELIFECYCLE] Command failed with exit code 1.
```

- Полный лог: `/tmp/opencode/tauri-build.log` (1218 строк).
- Длительность до падения: **9 мин 05 с** (frontend `next build` прошёл успешно).
- `target/` после падения: 628 МиБ. Свободно на `/`: 13 ГиБ.
- Гипотеза: единственная причина — отсутствие dev-пакетов GLib/GTK (и далее webkit/CEF/cmake).
  Кодовая база форка не при чём: `tsc --noEmit` и vitest зелёные.

## Блокер baseline-сборки

Для сборки Linux-таргета (CEF-рантайм) необходимы dev-пакеты, которых нет на хосте и которые
нельзя установить без root:

```
libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
libasound2-dev libfontconfig-dev libclang-dev libayatana-appindicator3-dev librsvg2-dev
cmake ninja-build patchelf
```

`libglib2.0-dev` в CI-списке не указан, потому что он предустановлен на GitHub-раннерах; на этом
хосте его нет — именно на нём упала сборка (`glib-sys`).

Проверка: `bash scripts/bilireader-check-toolchain.sh` → 12 FAIL, exit 1.
`apt-get install -y cmake` → `E: Could not open lock file /var/lib/dpkg/lock-frontend (13: Permission denied)`.
`sudo` в неинтерактивной сессии недоступен (пароль неизвестен, харнесс блокирует вызов).

`cmake` и `ninja` — жёсткие блокеры: CEF-рантайм собирает `libcef_dll_wrapper` через CMake.

## Что должно быть сделано после разблокировки

1. Установить пакеты (список — `docs/toolchain.md`, раздел «Команда установки»).
2. `pnpm install --frozen-lockfile`
3. `pnpm --filter @readest/readest-app setup-vendors`
4. `pnpm tauri dev` — зафиксировать время холодного запуска, версию CEF, `get_webview_version`.
5. Ручной приёмочный сценарий (6 пунктов): (a) импорт EPUB из `~/Books`; (b) импорт FB2;
   (c) 10 перелистываний вперёд/назад; (d) кегль 16→22→16; (e) перезапуск — позиция сохранена
   в обеих книгах; (f) `Books/library.json` содержит 2 записи, в `Books/<hash>/config.json` — `progress`.
6. `pnpm --filter @readest/readest-app tauri build` → артефакт в `target/release/bundle/**`.
7. Verify: `pnpm --filter @readest/readest-app exec tsc --noEmit` и
   `pnpm --filter @readest/readest-app exec dotenv -e .env -- vitest run src/__tests__/utils/misc.test.ts`.

> Пункт 5 требует интерактивной работы с GUI — в автоматическом запуске не выполняется.

---

# Повторный прогон: сборка выполнена (2026-11-03)

Системные dev-пакеты установлены, блокер первого прогона снят. Проверенные версии
через `pkg-config`: `glib-2.0 2.80.0`, `gtk+-3.0 3.24.41`, `webkit2gtk-4.1 2.52.6`,
`javascriptcoregtk-4.1 2.52.6`, `libsoup-3.0 3.4.4`, `alsa 1.2.11`, `fontconfig 2.15.0`,
`ayatana-appindicator3-0.1 0.5.90`, `librsvg-2.0 2.58.0`; `cmake 3.x`, `ninja`, `patchelf`,
`libclang-18` (`/usr/lib/llvm-18/lib`).

## Команда сборки

Из `apps/readest-app`, как в CI (`.github/workflows/nightly.yml`, шаг
«build desktop bundles»):

```bash
cd apps/readest-app
TAURI_CEF_CARGO=1 STRACE_MODE=0 pnpm tauri build
```

Без `TAURI_SIGNING_PRIVATE_KEY` добавляется `--no-sign` (иначе бандлер падает после
успешной упаковки, см. отклонение 4) — именно это делает
`scripts/bilireader-build-linux.sh`.

`pnpm tauri` — это `apps/readest-app/scripts/tauri.mjs`: на Linux он подменяет
`Cargo.lock` на `Cargo.cef.lock`, добавляет `--features cef`, `--no-default-features` и
`--config src-tauri/.cargo/cef.toml`. Скрипт `build-linux-x64` из `package.json` не
используется: он требует отсутствующий `.env.tauri.local`. Оборачивает всё
`scripts/bilireader-build-linux.sh`.

Один раз перед сборкой нужен CEF-CLI из readest/tauri (то же, что делает CI):

```bash
cargo install tauri-cli --git https://github.com/readest/tauri \
  --rev 6beeb209b5514f597a26f48b7a5b9fe4c59b5f12 --locked --force   # 633 c, rc=0
```

Без него `pnpm tauri` берёт npm-пакет `@tauri-apps/cli-cef@3.0.0-alpha.27`, и сборка
AppImage ломается по двум причинам, обе воспроизведены (см. «Отклонения»).

## Время и результат

| Прогон | Команда | Время | rc | Итог |
|---|---|---|---|---|
| 1 | `pnpm tauri build` (npm `cli-cef`) | **36 мин 27 с** | 1 | `.deb` + `.rpm` собраны; AppImage завис в quick-sharun, затем `404` на `lib/anylinux.c` |
| 2 | `TAURI_CEF_CARGO=1 STRACE_MODE=0 pnpm tauri build` | **10 мин 21 с** | 1 | Rust `Finished release in 2m45s`; `.deb` + `.rpm` пересобраны; AppImage упал на скачивании uruntime (DNS) |
| 3 | только упаковка AppImage (`quick-sharun --make-appimage`, локальные `RUNTIME`/`DWARFS_CMD`) | **53 с** | 0 | `BiliReader_0.12.16_amd64.AppImage` создан |
| 4 | `scripts/bilireader-build-linux.sh --bundles deb` (проверка обёртки) | **3 мин 07 с** | 0 | скрипт прошёл целиком: setup-vendors → next build → cargo → `.deb`, пути артефактов напечатаны |

Итого активного времени: ~21 мин 47 с (633 + 621 + 53 с), считая установку CLI.
Холодная компиляция Rust в прогоне 1 заняла 15 мин 48 с; повторные — 2 мин 45 с
(кэш `target/`).

## Артефакты

`target/release/bundle/` (размеры — байты, `du -h`):

| Файл | Размер |
|---|---|
| `appimage/BiliReader_0.12.16_amd64.AppImage` | 267 367 506 (255 МиБ) |
| `deb/BiliReader_0.12.16_amd64.deb` | 179 409 852 (171 МиБ) |
| `rpm/BiliReader-0.12.16-1.x86_64.rpm` | 142 599 787 (136 МиБ) |

`bundle.targets` в `src-tauri/tauri.conf.json` = `"all"`, поэтому собираются все три
формата. Внутри `.deb` — пакет `bili-reader`, бинарь `/usr/bin/readest`; CEF
(`libcef.so`, 268 МБ) лежит в `/usr/share/BiliReader/`, то есть пакет самодостаточен.

## Проверка запуска (smoke, без интерактива)

```bash
cd target/release/bundle/appimage
DISPLAY=:0 timeout 25 ./BiliReader_0.12.16_amd64.AppImage
```

- **rc = 124** — процесс дожил до таймаута (25 с) и был снят `timeout`; panic в stderr нет.
- Окно создаётся: `wmctrl -l` → `Readest` 1280x800; скриншот рабочего стола показывает
  экран библиотеки («Start your library», кнопка **Import Books**, поиск, «Sign in to sync»).
- В stderr — `ERROR:cef/libcef/browser/browser_info_manager.cc: Timeout of new browser info
  response for frame ...` (по одной строке на кадр) и `Gtk-Message: Failed to load module
  "xapp-gtk3-module"`. На отрисовку не влияют (окно отрисовано), но в отчёт о багах их
  стоит прикладывать.
- Тот же бинарь из распакованного `.deb` (`usr/share/BiliReader/readest`) ведёт себя
  одинаково: rc=124, окно есть.
- После запуска создан `~/.local/share/com.bilireader.app/Readest/Books/` — путь из
  `docs/manual-test.md` (B12) подтверждён.

## Диск

До сборки — **12 ГиБ** свободно, после — **4,3 ГиБ** (порог плана 3 ГиБ пройден).
`target/release` занимает 7,3 ГиБ, из них `deps` 3,3 ГиБ и CEF-дистрибутив ~1,5 ГиБ.
Промежуточный `BiliReader.AppDir` (1,2 ГиБ) после упаковки удалён.

## Отклонения и их причины

1. **npm `@tauri-apps/cli-cef` не может собрать AppImage.** Он тянет
   `quick-sharun.sh` с ветки `main` форка FabianLars, а тот ссылается на
   `pkgforge-dev/Anylinux-AppImages/.../useful-tools/lib/anylinux.c` — файл переехал в
   `pkgforge-dev/Anylinux-sharun` и отдаёт `404`. Пять ретраев → `ERROR: Failed to download 5 times!`.
   CI поэтому и собирает CLI из `readest/tauri`, где `quick-sharun` запинен на ревизию
   `53a05bc3` (все три URL на ней отдают 200).
2. **Зависание на `/bin/sh` + `set -m`.** `quick-sharun` в strace-режиме запускает
   приложение и убивает его групповым сигналом; под dash (`/bin/sh` в Ubuntu) группа не
   создаётся — `kill -TERM -$pid` не срабатывает, и сборка ждёт живой GUI бесконечно
   (наблюдалось 7+ минут). Лечится bash-шеллом (в CLI из readest/tauri) и `STRACE_MODE=0`.
3. **appimagetool не резолвит `release-assets.githubusercontent.com`** на этом хосте
   (`io: failed to lookup address information: Try again`), хотя `curl` тот же URL
   скачивает. Обход: скачать `uruntime-appimage-lite-x86_64` и `dwarfs-universal`
   обычным `curl`, затем упаковать с `RUNTIME=... DWARFS_CMD=...`. Это локальная
   особенность сети, не дефект репозитория.
4. **Подпись артефактов.** В `tauri.conf.json` включён `bundle.createUpdaterArtifacts`
   и вшит публичный ключ апдейтера, поэтому после успешной упаковки бандлер требует
   `TAURI_SIGNING_PRIVATE_KEY` и завершает сборку с `rc=1`
   (`A public key has been found, but no private key`). В CI ключ есть; локально
   используется `--no-sign` (бандлы при этом создаются и валидны, только без `.sig`).
   Это выяснилось на прогоне 4 (`scripts/bilireader-build-linux.sh --bundles deb`),
   который сначала упал на подписи. Прогон 1–3 до этого шага не доходили: они падали
   раньше, на AppImage.

## Что осталось за пределами автоматики

Ручной приёмочный сценарий (импорт EPUB/FB2, листание, кегль, темы, перезапуск) —
`docs/manual-test.md`. Он требует интерактивной работы с GUI и в этом прогоне не
выполнялся: проверено только то, что приложение стартует и показывает библиотеку.
