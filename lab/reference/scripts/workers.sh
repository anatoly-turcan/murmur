#!/usr/bin/env bash
# Usage: scripts/workers.sh start|stop <run dir>
# The run dir holds env.sh (exported TASKWELL_* settings) and receives worker-N.pid / worker-N.log.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-}"
RUN_DIR="${2:-}"
COUNT="${WORKER_COUNT:-2}"

if [[ -z "$ACTION" || -z "$RUN_DIR" ]]; then
  echo "usage: $0 start|stop <run dir>" >&2
  exit 2
fi

alive() {
  [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null
}

start_one() {
  local pidfile="$RUN_DIR/worker-$1.pid"
  if alive "$pidfile"; then
    return
  fi
  (
    set -a
    # shellcheck disable=SC1091
    source "$RUN_DIR/env.sh"
    set +a
    cd "$ROOT"
    setsid nohup ./bin/worker </dev/null >>"$RUN_DIR/worker-$1.log" 2>&1 &
    echo $! >"$pidfile"
  )
}

stop_one() {
  local pidfile="$RUN_DIR/worker-$1.pid"
  if alive "$pidfile"; then
    local pid
    pid="$(cat "$pidfile")"
    kill -9 "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do sleep 0.01; done
  fi
  rm -f "$pidfile"
}

case "$ACTION" in
  start) for i in $(seq 1 "$COUNT"); do start_one "$i"; done ;;
  stop) for i in $(seq 1 "$COUNT"); do stop_one "$i"; done ;;
  *) echo "unknown action $ACTION" >&2; exit 2 ;;
esac
