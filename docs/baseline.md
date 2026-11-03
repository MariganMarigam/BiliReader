# BiliReader — Baseline Linux (шаг 0.3)

**Дата:** 2026-11-03
**Хост:** Linux Mint 22.2 (Ubuntu 24.04 base), x86_64, 16 CPU, 15 GiB RAM
**Статус:** ⚠️ НЕ ВЫПОЛНЕН — сборка падает на отсутствующих системных dev-пакетах (нет root);
JS-часть baseline проверена и проходит (tsc + vitest).

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
