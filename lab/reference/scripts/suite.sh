#!/usr/bin/env bash
# Usage: scripts/suite.sh <run id> <port> [suite test files relative to lab/suite ...]
# Starts a fresh API + two workers on <port> with a fresh SQLite file under lab/reference-out/<run id>/,
# runs the hidden suite against them and always stops every process it started.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB="$(cd "$ROOT/.." && pwd)"
SUITE="$LAB/suite"
RUN_ID="${1:-}"
PORT="${2:-}"
shift 2 || true

if [[ -z "$RUN_ID" || -z "$PORT" ]]; then
  echo "usage: $0 <run id> <port> [tests/<file>.test.ts ...]" >&2
  exit 2
fi

RUN_DIR="$LAB/reference-out/$RUN_ID"
rm -rf "$RUN_DIR/db" "$RUN_DIR/emails.jsonl" "$RUN_DIR"/*.log "$RUN_DIR"/*.pid
mkdir -p "$RUN_DIR/db"

cat >"$RUN_DIR/env.sh" <<ENV
TASKWELL_DATABASE_URL=sqlite://$RUN_DIR/db/taskwell.db
TASKWELL_BIND=127.0.0.1
TASKWELL_PORT=$PORT
TASKWELL_TEST_MODE=true
TASKWELL_TRUST_PROXY=true
TASKWELL_WEBHOOK_TIMEOUT_MS=1000
TASKWELL_AUDIT_RETENTION_DAYS=${TASKWELL_AUDIT_RETENTION_DAYS:-30}
TASKWELL_EMAIL_SINK_PATH=$RUN_DIR/emails.jsonl
TASKWELL_LOG_LEVEL=${TASKWELL_LOG_LEVEL:-warn}
ENV

API_PID=""
cleanup() {
  "$ROOT/scripts/workers.sh" stop "$RUN_DIR" || true
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

(
  set -a
  # shellcheck disable=SC1091
  source "$RUN_DIR/env.sh"
  set +a
  cd "$ROOT"
  ./bin/setup >/dev/null
)

(
  set -a
  # shellcheck disable=SC1091
  source "$RUN_DIR/env.sh"
  set +a
  cd "$ROOT"
  exec ./bin/api </dev/null >>"$RUN_DIR/api.log" 2>&1
) &
API_PID=$!

"$ROOT/scripts/workers.sh" start "$RUN_DIR"

export TASKWELL_BASE_URL="http://127.0.0.1:$PORT"
export SUITE_WORKER_STOP_CMD="'$ROOT/scripts/workers.sh' stop '$RUN_DIR'"
export SUITE_WORKER_START_CMD="'$ROOT/scripts/workers.sh' start '$RUN_DIR'"
export SUITE_EMAIL_SINK_PATH="$RUN_DIR/emails.jsonl"
export SUITE_HEALTH_WAIT_S="${SUITE_HEALTH_WAIT_S:-30}"

cd "$SUITE"
bash scripts/run.sh "$RUN_DIR/suite" "$@"
