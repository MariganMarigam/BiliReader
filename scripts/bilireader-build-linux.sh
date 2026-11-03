#!/usr/bin/env bash
# BiliReader — release build for Linux (x86_64).
#
# Runs the same command CI uses (`.github/workflows/nightly.yml`, step
# "build desktop bundles"): `pnpm tauri build` from apps/readest-app. On Linux
# that wrapper (apps/readest-app/scripts/tauri.mjs) switches to the CEF runtime,
# passing `--features cef --no-default-features --config src-tauri/.cargo/cef.toml`
# to cargo and swapping Cargo.cef.lock in as Cargo.lock for the duration of the
# build. Do not call `tauri build` directly: that builds the wry/WebKitGTK
# runtime, which this project does not ship on Linux.
#
# AppImage bundling needs the tauri CLI that CI compiles from readest/tauri
# (`TAURI_CEF_CARGO=1`). The published npm `@tauri-apps/cli-cef` tracks the
# Anylinux-AppImages `main` branch, whose helper sources moved in 2026 and now
# return 404, so the AppImage step fails with "Failed to download 5 times"
# (`lib/anylinux.c`). Install the pinned CLI once, after which this script picks
# it up automatically:
#
#   cargo install tauri-cli --git https://github.com/readest/tauri \
#     --rev 6beeb209b5514f597a26f48b7a5b9fe4c59b5f12 --locked --force
#
# Usage:
#   scripts/bilireader-build-linux.sh [extra tauri build args...]
#   scripts/bilireader-build-linux.sh --bundles appimage
#
# Artifacts land in target/release/bundle/{appimage,deb,rpm}/ and are printed at
# the end. The first build downloads the CEF distribution (~150 MB) and compiles
# Chromium's wrapper; expect 25-45 minutes on 16 cores.
#
# If appimagetool cannot resolve release-assets.githubusercontent.com on this
# host (`io: failed to lookup address information`), pre-download the two tools
# with curl and point the bundler at them; both are honoured when exported:
#
#   curl -Lso /tmp/uruntime https://github.com/pkgforge-dev/Anylinux-uruntime/releases/download/1.0.0/uruntime-appimage-lite-x86_64
#   curl -Lso /tmp/dwarfs-universal https://github.com/mhx/dwarfs/releases/download/v0.15.6/dwarfs-universal-0.15.6-Linux-x86_64
#   ln -sf /tmp/dwarfs-universal /tmp/mkdwarfs
#   export RUNTIME=/tmp/uruntime DWARFS_CMD=/tmp/mkdwarfs
#

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname -- "$script_dir")"
app_dir="$repo_root/apps/readest-app"
bundle_dir="$repo_root/target/release/bundle"

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# --- toolchain on PATH ------------------------------------------------------
# The harness and non-login shells do not run ~/.bashrc, so nvm and rustup go
# missing even though they are installed. Do not source nvm.sh here: in a
# non-interactive shell it may switch to an older default Node that has no pnpm.
# Prepend the newest local Node 24 toolchain instead.
node_bin=""
for candidate in "$HOME"/.nvm/versions/node/v24*/bin; do
  if [ -x "$candidate/node" ]; then
    node_bin="$candidate"
  fi
done
if [ -n "$node_bin" ]; then
  case ":${PATH:-}:" in
    *":$node_bin:"*) ;;
    *) PATH="$node_bin:$PATH" ;;
  esac
  export PATH
fi
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi

command -v node >/dev/null 2>&1 || die "node not found. Install Node 24 (nvm install 24) and retry."
command -v pnpm >/dev/null 2>&1 || die "pnpm not found. Install: npm install -g pnpm@11.1.1"
command -v cargo >/dev/null 2>&1 || die "cargo not found. Install: rustup default stable (rustc >= 1.95)"
command -v cmake >/dev/null 2>&1 || die "cmake not found (needed to build libcef_dll_wrapper): sudo apt install cmake ninja-build"
command -v pkg-config >/dev/null 2>&1 || die "pkg-config not found: sudo apt install pkg-config"

# Linux desktop libs the bundle links against. Keep in sync with
# scripts/bilireader-check-toolchain.sh.
missing=""
for module in glib-2.0 gtk+-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 \
  alsa fontconfig librsvg-2.0 ayatana-appindicator3-0.1; do
  pkg-config --exists "$module" || missing="$missing $module"
done
if [ -n "$missing" ]; then
  die "missing system libraries:$missing
  sudo apt-get install -y libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev \\
    libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libasound2-dev libfontconfig-dev \\
    librsvg2-dev libayatana-appindicator3-dev libclang-dev patchelf cmake ninja-build"
fi

if [ -z "${LIBCLANG_PATH:-}" ] && [ -d /usr/lib/llvm-18/lib ]; then
  export LIBCLANG_PATH=/usr/lib/llvm-18/lib
fi

# AppImage bundling runs quick-sharun, whose strace mode is ON by default and
# launches the freshly built GUI binary under `LD_DEBUG=libs` for a few seconds.
# It stops the child with `kill -TERM -$pid` (a process-group signal), which
# needs job control; the npm CLI starts the script under /bin/sh (dash on
# Debian and Ubuntu), where `set -m` does not create the group, so the kill
# misses and the build waits on the still-running GUI forever. CI sets this for
# the same reason (.github/workflows/nightly.yml, "build desktop bundles").
export STRACE_MODE="${STRACE_MODE:-0}"

# Prefer the pinned CEF CLI from readest/tauri when it is installed: it runs the
# bundler with bash (the dash hang above) and pins Anylinux-AppImages to a
# revision whose helper sources still exist. See the header for the install
# command; without it only .deb/.rpm are reliably produced.
if cargo tauri --version >/dev/null 2>&1; then
  export TAURI_CEF_CARGO=1
else
  printf 'warning: cargo-tauri is not installed; AppImage bundling will fail on the\n' >&2
  printf '         published npm CLI (upstream helper sources moved). See the header of\n' >&2
  printf '         this script for the one-time `cargo install` command. .deb/.rpm still build.\n' >&2
fi

# --- disk budget ------------------------------------------------------------
free_kb="$(df -Pk "$repo_root" | awk 'NR==2 {print $4}')"
free_gb=$((free_kb / 1024 / 1024))
if [ "$free_gb" -lt 8 ]; then
  printf 'warning: only %s GiB free on the build volume; a CEF build needs ~8 GiB\n' "$free_gb" >&2
fi

[ -f "$app_dir/.env.tauri" ] || die "missing $app_dir/.env.tauri (copy .env.tauri.example and set NEXT_PUBLIC_APP_PLATFORM=tauri)"

printf '==> vendored assets (pdf.js)\n'
pnpm --dir "$app_dir" run setup-vendors

printf '==> pnpm tauri build (Linux/CEF) — this takes 25-45 min on a cold cache\n'
# `bundle.createUpdaterArtifacts` is true in tauri.conf.json and the updater
# pubkey is baked in, so the bundler insists on signing the artifacts. CI passes
# TAURI_SIGNING_PRIVATE_KEY; a local build has no key and would fail *after*
# producing the bundles, with rc=1. Skip signatures instead of failing.
sign_args=()
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  sign_args+=(--no-sign)
  printf 'note: TAURI_SIGNING_PRIVATE_KEY is unset — updater signatures are skipped (--no-sign)\n'
fi

started_at=$(date +%s)
(
  cd -- "$app_dir"
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}" pnpm tauri build "$@" "${sign_args[@]}"
)
elapsed=$(( $(date +%s) - started_at ))

printf '\n==> build finished in %dm %02ds\n' $((elapsed / 60)) $((elapsed % 60))

printf '\n==> artifacts under %s\n' "$bundle_dir"
found=0
for pattern in "appimage/*.AppImage" "deb/*.deb" "rpm/*.rpm"; do
  for artifact in "$bundle_dir"/$pattern; do
    [ -e "$artifact" ] || continue
    found=1
    printf '  %s (%s)\n' "$artifact" "$(du -h -- "$artifact" | cut -f1)"
  done
done
if [ "$found" -eq 0 ]; then
  printf '  none: check whether the bundle targets were disabled (bundle.targets in src-tauri/tauri.conf.json)\n' >&2
  exit 1
fi

free_gb=$(( $(df -Pk "$repo_root" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
printf '\n==> free disk after build: %s GiB\n' "$free_gb"
if [ "$free_gb" -lt 3 ]; then
  printf 'warning: less than 3 GiB left on the build volume\n' >&2
fi
