#!/usr/bin/env bash
# BiliReader toolchain gate (Phase 0, step 0.2).
#
# Checks the tool versions and system libraries required for the Linux Tauri/CEF
# baseline build. Prints one line per check:
#   OK   <tool> <version>
#   FAIL <tool> <reason>
#   SKIP <tool> <reason>
# and exits 1 if any check failed.
#
# Usage: bash scripts/bilireader-check-toolchain.sh

set -uo pipefail

required_node_major=24
required_pnpm="11.1.1"
required_rust_minor=95  # rustc >= 1.95

failures=0
fail() {
  printf 'FAIL %s %s\n' "$1" "$2"
  failures=$((failures + 1))
}
ok() { printf 'OK %s %s\n' "$1" "$2"; }
skip() { printf 'SKIP %s %s\n' "$1" "$2"; }

# --- Node.js ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail node "not found in PATH (run: nvm use 24)"
else
  node_version="$(node -v 2>/dev/null | sed 's/^v//')"
  node_major="${node_version%%.*}"
  if [ "${node_major:-0}" -eq "$required_node_major" ]; then
    ok node "v$node_version"
  else
    fail node "v$node_version (required ${required_node_major}.x)"
  fi
fi

# --- pnpm ------------------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  fail pnpm "not found in PATH"
else
  pnpm_version="$(pnpm -v 2>/dev/null | tail -1)"
  if [ "$pnpm_version" = "$required_pnpm" ]; then
    ok pnpm "$pnpm_version"
  else
    fail pnpm "$pnpm_version (required $required_pnpm)"
  fi
fi

# --- rustc -----------------------------------------------------------------
if ! command -v rustc >/dev/null 2>&1; then
  fail rustc "not found in PATH (run: rustup default stable)"
else
  rustc_version="$(rustc -V 2>/dev/null | awk '{print $2}')"
  rustc_major="${rustc_version%%.*}"
  rustc_rest="${rustc_version#*.}"
  rustc_minor="${rustc_rest%%.*}"
  if [ "$rustc_major" -gt 1 ] 2>/dev/null ||
    { [ "$rustc_major" -eq 1 ] && [ "$rustc_minor" -ge "$required_rust_minor" ]; }; then
    ok rustc "$rustc_version"
  else
    fail rustc "$rustc_version (required >= 1.${required_rust_minor})"
  fi
fi

# --- JDK (Android, step 0.4) ----------------------------------------------
if ! command -v java >/dev/null 2>&1; then
  fail java "not found in PATH (required JDK 17 for Android builds)"
else
  java_version="$(java -version 2>&1 | head -1 | sed -n 's/.*"\([^"]*\)".*/\1/p')"
  case "$java_version" in
    17.*) ok java "$java_version" ;;
    *) fail java "$java_version (required 17.x)" ;;
  esac
fi

# --- Android NDK (step 0.4, deferred in the Linux-only bootstrap) ----------
if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -x "$ANDROID_NDK_HOME/ndk-build" ]; then
  ok ndk "$("$ANDROID_NDK_HOME/ndk-build" --version 2>/dev/null | tail -1)"
else
  skip ndk "not configured (Android is step 0.4, out of scope for this run)"
fi

# --- System libraries required to link the Linux build --------------------
# pkg-config module -> Debian/Ubuntu package that provides it.
pkg_checks="gtk+-3.0:libgtk-3-dev webkit2gtk-4.1:libwebkit2gtk-4.1-dev
javascriptcoregtk-4.1:libjavascriptcoregtk-4.1-dev libsoup-3.0:libsoup-3.0-dev
alsa:libasound2-dev fontconfig:libfontconfig-dev libclang:libclang-dev
appindicator3-0.1:libayatana-appindicator3-dev librsvg-2.0:librsvg2-dev"

if ! command -v pkg-config >/dev/null 2>&1; then
  fail pkg-config "not found in PATH"
else
  for entry in $pkg_checks; do
    module="${entry%%:*}"
    package="${entry#*:}"
    if pkg-config --exists "$module" 2>/dev/null; then
      ok "$module" "$(pkg-config --modversion "$module")"
    else
      fail "$module" "missing (apt: $package)"
    fi
  done
fi

# --- Build helpers ---------------------------------------------------------
for tool in cmake ninja patchelf; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool" "$("$tool" --version 2>/dev/null | head -1)"
  else
    fail "$tool" "not found in PATH"
  fi
done

if [ "$failures" -gt 0 ]; then
  printf '\n%d check(s) failed\n' "$failures"
  exit 1
fi
printf '\nall checks passed\n'
exit 0
