#!/usr/bin/env bash
# Runs the whole harness against the in-repo stub (healthz + reset only) to prove the plumbing works.
set -euo pipefail

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="$(echo "${SUITE_CR:-none}" | tr '[:upper:]' '[:lower:]')"
OUT_DIR="${1:-$SUITE_DIR/out/selftest${SUITE_CR:+-$MODE}}"
PORT="${STUB_PORT:-18080}"

cd "$SUITE_DIR"
STUB_PORT="$PORT" node stub/server.ts &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT

export TASKWELL_BASE_URL="http://127.0.0.1:${PORT}"
export SUITE_HEALTH_WAIT_S="${SUITE_HEALTH_WAIT_S:-15}"
export SUITE_GLOBAL_TIMEOUT_S="${SUITE_GLOBAL_TIMEOUT_S:-900}"
bash scripts/run.sh "$OUT_DIR"
