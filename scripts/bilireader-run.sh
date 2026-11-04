#!/usr/bin/env bash
# BiliReader — development run in one of three modes.
#
#   web      (default) Next.js in the browser. No Rust, no disk cost. 5-15 s.
#   --desktop          Tauri window on WebKitGTK (wry, no CEF). 10-15 min cold,
#                      2-3 GB of target/debug, then 10-60 s per restart.
#   --cef              Tauri window on the CEF runtime (scripts/tauri.mjs).
#                      Same as before this script grew modes: 20+ min, 8 GB.
#
# Usage:
#   scripts/bilireader-run.sh [--web|--desktop|--cef] [extra args...]
#
# Extra arguments after the mode are forwarded to `next dev` (web) or
# `tauri dev` (desktop/cef). Stop with Ctrl-C.
#
# What web mode cannot do: Tauri IPC (file system access, native dialogs),
# TTS, the updater, and the native page-curl cover effect. Everything else —
# library, reader, styles, sync scaffolding — works.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname -- "$script_dir")"
app_dir="$repo_root/apps/readest-app"

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

usage() {
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

mode="web"
while [ $# -gt 0 ]; do
  case "$1" in
    --web) mode="web"; shift ;;
    --desktop) mode="desktop"; shift ;;
    --cef) mode="cef"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option: $1
  Modes: --web (default), --desktop, --cef. See --help." ;;
    *) break ;;
  esac
done

# --- toolchain on PATH ------------------------------------------------------
# Non-login shells skip ~/.bashrc, so nvm and rustup are not on PATH even when
# installed. Sourcing nvm.sh can switch to an older default Node without pnpm,
# so prepend the newest local Node 24 toolchain instead.
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

# --- checks shared by every mode -------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found.
  Node 24 is required: nvm install 24 && nvm use 24"
command -v pnpm >/dev/null 2>&1 || die "pnpm not found.
  Install it: npm install -g pnpm@11.1.1"
[ -d "$app_dir/node_modules" ] || die "dependencies are not installed.
  Run: pnpm install --frozen-lockfile"

require_rust_toolchain() {
  command -v cargo >/dev/null 2>&1 || die "cargo not found.
  Install it: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  Then reopen the shell or run: . \"\$HOME/.cargo/env\""
  command -v pkg-config >/dev/null 2>&1 || die "pkg-config not found: sudo apt install pkg-config"

  local missing="" module
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

  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    die "no graphical session: DISPLAY and WAYLAND_DISPLAY are both unset.
  Run from a desktop terminal, or: DISPLAY=:0 $0 --$mode"
  fi
}

check_vendors() {
  [ -f "$app_dir/public/vendor/pdfjs/pdf.worker.min.mjs" ] ||
    printf 'warning: pdf.js assets look missing; run: pnpm --filter @readest/readest-app setup-vendors\n' >&2
}

case "$mode" in
  web)
    [ -f "$app_dir/.env.web" ] || die "missing $app_dir/.env.web (copy .env.web.example and set NEXT_PUBLIC_APP_PLATFORM=web)"
    check_vendors
    printf '==> Next.js dev server (browser mode, no Rust).\n'
    printf '    open: http://localhost:3000\n'
    printf '    not available here: Tauri IPC, TTS, updater, native page-curl cover.\n'
    printf '    Ctrl-C to stop.\n'
    cd -- "$app_dir"
    exec pnpm dev-web "$@"
    ;;
  desktop)
    [ -f "$app_dir/.env.tauri" ] || die "missing $app_dir/.env.tauri (copy .env.tauri.example and set NEXT_PUBLIC_APP_PLATFORM=tauri)"
    require_rust_toolchain
    check_vendors
    printf '==> Tauri dev on WebKitGTK (no CEF).\n'
    printf '    First build: 10-15 min and 2-3 GB in target/debug; later restarts 10-60 s.\n'
    printf '    Ctrl-C to stop.\n'
    cd -- "$app_dir"
    # CARGO_PROFILE_DEV_DEBUG=0 drops debuginfo: the release-derived dev profile
    # otherwise produced an ~8 GB target tree. GDB backtraces lose line info.
    export CARGO_PROFILE_DEV_DEBUG=0
    exec pnpm exec tauri dev "$@"
    ;;
  cef)
    [ -f "$app_dir/.env.tauri" ] || die "missing $app_dir/.env.tauri (copy .env.tauri.example and set NEXT_PUBLIC_APP_PLATFORM=tauri)"
    require_rust_toolchain
    check_vendors
    if [ -z "${LIBCLANG_PATH:-}" ] && [ -d /usr/lib/llvm-18/lib ]; then
      export LIBCLANG_PATH=/usr/lib/llvm-18/lib
    fi
    printf '==> Tauri dev on CEF (scripts/tauri.mjs adds --features cef --no-default-features).\n'
    printf '    First build: 20+ min and ~8 GB in target/debug; downloads the CEF distribution once.\n'
    printf '    Needs a graphical session; the CEF runtime forces X11.\n'
    printf '    Ctrl-C to stop.\n'
    cd -- "$app_dir"
    exec pnpm tauri dev "$@"
    ;;
  *) die "unreachable mode: $mode" ;;
esac
