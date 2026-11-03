#!/usr/bin/env bash
# BiliReader — development run (Tauri dev server + Next.js, Linux/CEF).
#
# Starts `pnpm tauri dev` from apps/readest-app, which on Linux runs the CEF
# runtime (apps/readest-app/scripts/tauri.mjs). The first run downloads the CEF
# distribution and compiles the Rust backend (10-20 min); later runs are fast.
#
# Usage:
#   scripts/bilireader-run.sh [extra tauri dev args...]
#   scripts/bilireader-run.sh --features devtools
#
# Stop with Ctrl-C. Dev logs go to stdout and to the terminal only.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname -- "$script_dir")"
app_dir="$repo_root/apps/readest-app"

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

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

command -v node >/dev/null 2>&1 || die "node not found.
  Node 24 is required: nvm install 24 && nvm use 24"
command -v pnpm >/dev/null 2>&1 || die "pnpm not found.
  Install it: npm install -g pnpm@11.1.1"
command -v cargo >/dev/null 2>&1 || die "cargo not found.
  Install it: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  Then reopen the shell or run: . \"\$HOME/.cargo/env\""

command -v pkg-config >/dev/null 2>&1 || die "pkg-config not found: sudo apt install pkg-config"

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

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  die "no graphical session: DISPLAY and WAYLAND_DISPLAY are both unset.
  Run from a desktop terminal, or: DISPLAY=:0 scripts/bilireader-run.sh
  (the CEF runtime forces X11, so DISPLAY is the one that matters)"
fi

if [ -z "${LIBCLANG_PATH:-}" ] && [ -d /usr/lib/llvm-18/lib ]; then
  export LIBCLANG_PATH=/usr/lib/llvm-18/lib
fi

[ -f "$app_dir/.env.tauri" ] || die "missing $app_dir/.env.tauri (copy .env.tauri.example and set NEXT_PUBLIC_APP_PLATFORM=tauri)"
[ -d "$app_dir/node_modules" ] || die "dependencies are not installed: pnpm install --frozen-lockfile"
[ -f "$repo_root/apps/readest-app/public/vendor/pdfjs/pdf.worker.min.mjs" ] ||
  printf 'warning: pdf.js assets look missing; run: pnpm --filter @readest/readest-app setup-vendors\n' >&2

printf '==> pnpm tauri dev (Linux/CEF). First run compiles Rust and downloads CEF; Ctrl-C to stop.\n'
cd -- "$app_dir"
exec pnpm tauri dev "$@"
