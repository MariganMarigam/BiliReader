# BiliReader — план оставшихся работ

Состояние на 2026-11-26 — [STATUS.md](STATUS.md). Перенос окружения — [PORTING.md](PORTING.md).
Оценки — в человеко-днях одного разработчика, без учёта ожидания загрузок.

## Оглавление

1. [C. Android](#c-android)
2. [D. Релиз v0.1.0 на GitHub](#d-релиз-v010-на-github)
3. [E. Опционально](#e-опционально)
4. [Блокеры и риски](#4-блокеры-и-риски)

## C. Android

Зависимости: C — ничего; D зависим от C только в части APK-ассета.

### C1. Тулчейн

| Компонент | Версия / значение | Источник |
|---|---|---|
| JDK | 17 (CI: Zulu 17) | `.github/workflows/nightly.yml` |
| Android SDK | `platform-tools` (пакет `tools` удалён из репозитория Google) | там же |
| NDK | `28.2.13676358` | `sdkmanager "ndk;28.2.13676358"` в CI |
| compileSdk / targetSdk | **36** | `apps/readest-app/src-tauri/gen/android/app/build.gradle.kts` |
| minSdk | **26** | там же и `tauri.conf.json` → `bundle.android.minSdkVersion` |
| ABI | `arm64-v8a` (`-t aarch64`) | `package.json` → `dev-android` |
| Rust target | `aarch64-linux-android` | CI-матрица |
| Gradle/AGP | сам доставит `platforms;android-36` и нужные build-tools (CI ставит только `platform-tools` и NDK) | `.github/workflows/nightly.yml` |
| `cargo-ndk` | **не используется**: `pnpm tauri android build` вызывает NDK напрямую; в CI не устанавливается. Нужен только для ручных `cargo build --target aarch64-linux-android` | `.github/workflows`, `package.json` |

Примечание: `build-tools;35` и `platforms;android-35` из ранних заметок репозиторию не
соответствуют — в `build.gradle.kts` `compileSdk = 36`. Пин 35 требует правки этого файла;
без правки sdkmanager достаточно поставить `platform-tools` и NDK — остальное дотянет Gradle.

Установка:

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager "platform-tools" "ndk;28.2.13676358"
rustup target add aarch64-linux-android
```

### C2. Сборка

| Шаг | Команда | Результат |
|---|---|---|
| 1 | `cd apps/readest-app` | — |
| 2 | `pnpm tauri android init` | `src-tauri/gen/android` (каталог уже в git, init перегенерирует) |
| 3 | `pnpm tauri android build -t aarch64` | APK |
| 4 | APK | `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| 5 | Установка | `adb install -r <apk>` |

Подпись — `src-tauri/gen/android/keystore.properties` (не в git) с полями `keyAlias`,
`password`, `storeFile`. Без файла release-APK остаётся неподписанным: `signingConfig` не
назначается, и установить его поверх подписанного релиза нельзя.

### C3. Хранение модели

| Вопрос | Решение |
|---|---|
| Куда | Приватный каталог приложения (`appDataDir` → `/data/user/0/com.bilingify.readest/files/...`), не SD-карта и не SAF |
| Откуда | Тот же менеджер моделей (Settings → Offline engine), 1 133 080 448 Б; проверка свободного места и SHA-256 уже есть |
| В APK | Модель не входит; в APK только код и ассеты (словарь ~6.5 МБ, шрифты ~3.1 МБ) |
| Риск | 1.13 ГБ в приватном хранилище; на устройствах с 32 ГБ это заметно — нужен экран удаления (есть) и предупреждение о размере |

### C4. Цели по латентности и памяти

Ориентиры с десктопа: загрузка модели 2.3 с, короткое предложение 475 мс, 29 tok/s,
RSS 1.9 ГиБ (`docs/local-engine.md`). Для телефона цели:

| Метрика | Цель | Как мерить |
|---|---|---|
| Первый токен после загрузки модели | ≤ 3 с | лог `translate_local` (`ms`, `tokens`) |
| Устойчивая скорость | ≥ 10 tok/s | длинное предложение 40+ слов |
| RSS процесса с моделью | ≤ 2.5 ГиБ | `adb shell dumpsys meminfo <pkg>` |
| Холодный старт приложения | ≤ 5 с | `adb shell am start -W` |
| Отмена перевода | ≤ 1 с | `cancel_translation` + замер |

### C5. Матрица тестовых устройств

| Класс | Пример | Что проверяем |
|---|---|---|
| Минимум | 4 ГБ RAM, Android 8 (API 26) | запуск, чтение, перевод не падает по OOM |
| Средний | 6–8 ГБ RAM, Android 13 (API 33) | полный сценарий `docs/manual-test.md` B1–B17 |
| Флагман | 12 ГБ RAM, Android 15/16 (API 35/36) | скорость, RSS, удержание строки |
| Планшет | 10″+, API 33+ | вёрстка, линейка, словарь |

**Критерий готовности C:** APK `arm64-v8a` собирается из чистого клона по шагам C2;
на среднем устройстве проходят B1–B17; цели C4 достигнуты или зафиксированы как отклонение.
**Оценка:** 5–8 дней.

## D. Релиз v0.1.0 на GitHub

Зависимости: Linux-артефакты (есть), решение по подписи апдейтера, тексты.

| # | Пункт | Детали |
|---|---|---|
| D1 | Тег | `git tag -a v0.1.0 -m "BiliReader 0.1.0" <commit>`; версия уже 0.1.0 в `apps/readest-app/package.json` |
| D2 | Ассеты | `BiliReader_0.1.0_amd64.AppImage`, `BiliReader_0.1.0_amd64.deb`, `SHA256SUMS` (+ `.rpm`, если нужен) |
| D3 | Контрольные суммы | `sha256sum BiliReader_0.1.0_amd64.* > SHA256SUMS`; приложить к релизу, проверить `sha256sum -c` |
| D4 | Гид | README релиза: установка AppImage/deb, первый запуск, скачивание модели (1.06 ГиБ / 1.13 ГБ, нужен интернет), `docs/manual-test.md` как приёмка |
| D5 | Скриншоты | библиотека, читалка с темой Sepia, карточка словаря, попап перевода, панель Offline engine |
| D6 | NOTICE / AGPL | `LICENSE` — AGPL-3.0; отдельного `NOTICE` нет. Добавить `NOTICE` с копирайтом Bilingify LLC, списком сторонних компонентов (llama.cpp MIT, Hy-MT2 Apache-2.0, FreeDict CC BY-SA 3.0, PT Fonts OFL 1.1) и ссылкой на исходники |
| D7 | Обновления | `tauri.conf.json` → `bundle.updater.endpoints` указывают на `download.readest.com` и `readest/readest`; для форка нужно либо сменить эндпоинты, либо выпускать без апдейтера. Локальная сборка идёт с `--no-sign` — подпись/`latest.json` отсутствуют |

Порядок:

```sh
scripts/bilireader-build-linux.sh          # ≥ 8 ГБ свободно, 25–45 мин
cd dist && sha256sum BiliReader_0.1.0_amd64.* > SHA256SUMS
gh release create v0.1.0 dist/* --repo MariganMarigam/BiliReader \
  --title "BiliReader 0.1.0" --notes-file <notes.md>
```

Как выпускать обновление: поднять `version` в `apps/readest-app/package.json` → пересобрать →
новый `SHA256SUMS` → `gh release create vX.Y.Z` (не перезаписывать старый тег: установленные
сборки проверяют контрольные суммы).

**Критерий готовности D:** релиз виден на странице, оба ассета скачиваются, `sha256sum -c`
на скачанном проходит, чистая машина ставит `.deb` и запускает AppImage.
**Оценка:** 1–2 дня.

## E. Опционально

| Пункт | Зависимости | Критерий | Оценка |
|---|---|---|---|
| Зеркало модели | GitHub Release `models-v1` с GGUF (1.13 ГБ; лимит ассета GitHub — 2 ГБ) | `curl -sIL` на ассет даёт 302/200; URL добавлен вторым в `urls` манифеста | 0.5 дня + загрузка |
| Windows-сборка | [PORTING.md](PORTING.md#4-windows): WebView2, MSVC Build Tools, Rust MSVC | `pnpm tauri build` даёт NSIS/MSI, приложение открывает EPUB и словарь | 2–3 дня |
| macOS-сборка | Xcode CLT, `aarch64-apple-darwin`, минимум macOS 12.0 | `.app`/`.dmg`, чтение и словарь работают | 2–3 дня |
| SRS | Дизайн повторений, хранилище карточек, UI | карточки переживают перезапуск, интервалы считаются по алгоритму | 5–10 дней |
| TTS | Нативный TTS-плагин уже наследуется от Readest; опционально — офлайн-голоса | озвучка главы без сети на выбранном языке | 3–5 дней |
| iOS | Xcode, `aarch64-apple-ios`, `developmentTeam` уже прописан | сборка на устройстве, чтение и перевод | 5–8 дней |

## 4. Блокеры и риски

| Риск | Влияние | Митигация |
|---|---|---|
| Мало места на диске | Скрипт сборки отказывается стартовать при < 8 ГБ | `df -h /` до старта; `scripts/bilireader-clean.sh --yes`; правило — собирать только на чекпоинте (`docs/lean-workflow.md`) |
| OOM при упаковке AppImage | `mkdwarfs` убит при ~8.9 ГБ RSS | обёртка вокруг `dwarfs-universal` с симлинком `mkdwarfs` и флагами `-N 4 --num-scanner-workers 4 --num-segmenter-workers 4 -L 4g`, затем `appimagetool` по готовому `BiliReader.AppDir` |
| Сеть до CDN | 404/таймауты при скачивании CEF, uruntime, модели | `RUNTIME`/`DWARFS_CMD` из curl; пиннинг ревизии HF; зеркало (E) |
| Android не проверялся | Оценки C4 могут не выполниться | сначала собрать APK и прогнать на среднем устройстве, потом оптимизировать |
| Подпись апдейтера | Обновления не устанавливаются | решить D7 до первого релиза: новые эндпоинты + ключ или отключить updater |
| AGPL | Претензии при раздаче бинарников без исходников | публичный репозиторий + `NOTICE`; исходники форка доступны |
| CI форка | `nightly.yml`/`release.yml` публикуют в upstream/R2 и требуют секретов | релизы форка делать вручную по D; CI не переиспользовать без правки |
| Размер APK/модели | 1.13 ГБ в приватном хранилище | предупреждение о размере, удаление модели, проверка свободного места до загрузки |
