#!/usr/bin/env bash
# BiliReader — local machine-translation bridge (llama.cpp server + Hy-MT2-1.8B).
#
# Serves an OpenAI-compatible /v1/chat/completions endpoint on 127.0.0.1:8080
# that the app's "OpenAI Compatible" custom translator can talk to.
#
# Usage:
#   scripts/bilireader-mt-server.sh start     # background, wait for /health (<= 180 s)
#   scripts/bilireader-mt-server.sh stop
#   scripts/bilireader-mt-server.sh status
#   scripts/bilireader-mt-server.sh logs [N]  # last N lines (default 100), then follow
#
# Environment overrides:
#   BILIREADER_MT_PORT (8080)   BILIREADER_MT_CTX (512)
#   BILIREADER_MT_THREADS (2)   BILIREADER_MT_LOG (/tmp/opencode/mt-server.log)
#
# Everything outside the repository lives under ~/.local/share/bilireader/;
# see docs/local-mt-server.md.

set -euo pipefail

data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/bilireader"
model_dir="$data_dir/models"
model="$model_dir/Hy-MT2-1.8B-Q4_K_M.gguf"

host="127.0.0.1"
port="${BILIREADER_MT_PORT:-8080}"
ctx="${BILIREADER_MT_CTX:-512}"
threads="${BILIREADER_MT_THREADS:-2}"
log="${BILIREADER_MT_LOG:-/tmp/opencode/mt-server.log}"
pidfile="$(dirname -- "$log")/mt-server.pid"
alias_name="hy-mt2-1.8b"

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# Newest extracted llama.cpp build under ~/.local/share/bilireader/llama/.
find_server() {
  local candidate
  candidate="$(find "$data_dir/llama" -maxdepth 2 -name llama-server -type f -perm -u+x 2>/dev/null | sort | tail -n 1)"
  [ -n "$candidate" ] || die "llama-server not found under $data_dir/llama
  Install a prebuilt release: see docs/local-mt-server.md"
  printf '%s\n' "$candidate"
}

running_pid() {
  local pid
  [ -f "$pidfile" ] || return 1
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s\n' "$pid"
}

healthy() {
  curl -fsS -m 2 "http://$host:$port/health" >/dev/null 2>&1
}

wait_ready() {
  local pid="$1" deadline=$(( SECONDS + 180 )) body
  while (( SECONDS < deadline )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf 'error: llama-server exited during startup; last log lines:\n' >&2
      tail -n 20 "$log" >&2 || true
      return 1
    fi
    if healthy; then
      return 0
    fi
    sleep 0.5
  done
  printf 'error: server not healthy after 180 s; see %s\n' "$log" >&2
  return 1
}

cmd_start() {
  local pid server started
  if pid="$(running_pid)"; then
    printf 'already running (pid %s) on http://%s:%s\n' "$pid" "$host" "$port"
    return 0
  fi
  [ -f "$model" ] || die "model not found: $model
  See docs/local-mt-server.md (download + sha256)."
  server="$(find_server)"
  mkdir -p "$(dirname -- "$log")"
  started=$SECONDS
  # -ngl 0 keeps every layer on the CPU; --alias is the model id the app must use.
  nohup "$server" \
    --model "$model" \
    --host "$host" --port "$port" \
    --alias "$alias_name" \
    --ctx-size "$ctx" \
    --threads "$threads" \
    --n-gpu-layers 0 \
    --no-webui \
    >>"$log" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" > "$pidfile"
  trap '' HUP
  if wait_ready "$pid"; then
    printf 'ready in %ss: http://%s:%s/v1 (pid %s, ctx %s, threads %s)\n' \
      "$(( SECONDS - started ))" "$host" "$port" "$pid" "$ctx" "$threads"
  else
    cmd_stop
    return 1
  fi
}

cmd_stop() {
  local pid i
  if ! pid="$(running_pid)"; then
    rm -f "$pidfile"
    printf 'not running\n'
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
  printf 'stopped (pid %s)\n' "$pid"
}

cmd_status() {
  local pid
  if ! pid="$(running_pid)"; then
    printf 'stopped\n'
    return 1
  fi
  if healthy; then
    printf 'running (pid %s): http://%s:%s/v1 model=%s rss=%s\n' \
      "$pid" "$host" "$port" "$alias_name" \
      "$(ps -o rss= -p "$pid" | awk '{printf "%.0f MiB", $1/1024}')"
  else
    printf 'process %s alive but /health is not answering (starting?); log: %s\n' "$pid" "$log"
    return 1
  fi
}

cmd_logs() {
  local lines="${1:-100}"
  [ -f "$log" ] || die "no log yet: $log"
  tail -n "$lines" -f "$log"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "${1:-100}" ;;
  -h|--help|help|"") usage ;;
  *) die "unknown command: $1
  Commands: start, stop, status, logs. See --help." ;;
esac
