#!/usr/bin/env bash
# Usage: [SUITE_CR=none|CR-1|CR-2|CR-3] [SUITE_LEGACY_MANIFEST=<file>] scripts/run.sh <output-dir> [test-file-or-glob ...]
set -uo pipefail

OUT_DIR="${1:-}"
if [[ -z "$OUT_DIR" ]]; then
  echo "usage: $0 <output-dir> [test files...]" >&2
  exit 2
fi
shift

if [[ -z "${TASKWELL_BASE_URL:-}" ]]; then
  echo "TASKWELL_BASE_URL must be set (e.g. http://127.0.0.1:8080)" >&2
  exit 2
fi

case "${SUITE_CR:-none}" in
  ''|none|NONE) CR_LEVEL=0 ;;
  CR-1|cr-1|CR1|cr1) CR_LEVEL=1 ;;
  CR-2|cr-2|CR2|cr2) CR_LEVEL=2 ;;
  CR-3|cr-3|CR3|cr3) CR_LEVEL=3 ;;
  *) echo "SUITE_CR must be none, CR-1, CR-2 or CR-3 (got ${SUITE_CR})" >&2; exit 2 ;;
esac
if (( CR_LEVEL == 0 )); then export SUITE_CR=none; else export SUITE_CR="CR-${CR_LEVEL}"; fi
if [[ -n "${SUITE_LEGACY_MANIFEST:-}" ]]; then
  if [[ ! -s "$SUITE_LEGACY_MANIFEST" ]]; then
    echo "SUITE_LEGACY_MANIFEST=${SUITE_LEGACY_MANIFEST} does not exist" >&2
    exit 2
  fi
  SUITE_LEGACY_MANIFEST="$(cd "$(dirname "$SUITE_LEGACY_MANIFEST")" && pwd)/$(basename "$SUITE_LEGACY_MANIFEST")"
  export SUITE_LEGACY_MANIFEST
fi

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
HEALTH_WAIT_S="${SUITE_HEALTH_WAIT_S:-60}"
GLOBAL_TIMEOUT_S="${SUITE_GLOBAL_TIMEOUT_S:-3600}"
TEST_TIMEOUT_MS="${SUITE_TEST_TIMEOUT_MS:-180000}"
BASE="${TASKWELL_BASE_URL%/}"

echo "waiting up to ${HEALTH_WAIT_S}s for ${BASE}/healthz"
deadline=$((SECONDS + HEALTH_WAIT_S))
until curl -fsS -m 5 "${BASE}/healthz" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "candidate not healthy at ${BASE}/healthz after ${HEALTH_WAIT_S}s" >&2
    exit 3
  fi
  sleep 1
done
echo "candidate healthy"

cd "$SUITE_DIR"

# A change-request file tests/crN-*.test.ts belongs to the run only when SUITE_CR is at least CR-N.
in_mode() {
  local name
  name="$(basename "$1")"
  if [[ "$name" =~ ^cr([1-3])- ]]; then (( BASH_REMATCH[1] <= CR_LEVEL )); else return 0; fi
}

is_legacy() {
  [[ "$(basename "$1")" =~ ^cr[1-3]-legacy.*\.test\.ts$ ]]
}

if [[ $# -gt 0 ]]; then
  REQUESTED=("$@")
else
  shopt -s nullglob
  REQUESTED=()
  for f in tests/*.test.ts; do in_mode "$f" && REQUESTED+=("$f"); done
fi

# Legacy files read the pre-migration dataset, so they run first, before any test resets the database.
LEGACY=()
MAIN=()
for f in "${REQUESTED[@]}"; do
  if [[ -n "${SUITE_LEGACY_MANIFEST:-}" ]] && is_legacy "$f"; then LEGACY+=("$f"); else MAIN+=("$f"); fi
done

rm -f "$OUT_DIR/results.json" "$OUT_DIR/results.md" "$OUT_DIR/legacy-results.json" "$OUT_DIR/spec.log"
DEADLINE=$((SECONDS + GLOBAL_TIMEOUT_S))
status=0

run_node() {
  local results="$1" spec="$2"
  shift 2
  local left=$((DEADLINE - SECONDS))
  (( left > 0 )) || return 124
  SUITE_RESULTS_JSON="$results" timeout --signal=TERM --kill-after=15 "$left" \
    node --test \
      --test-concurrency=1 \
      --test-timeout="$TEST_TIMEOUT_MS" \
      --test-reporter=spec --test-reporter-destination="$spec" \
      --test-reporter=./reporter/scoring.ts --test-reporter-destination=stdout \
      "$@"
}

if (( ${#LEGACY[@]} > 0 )); then
  echo "legacy phase (${SUITE_CR}, manifest ${SUITE_LEGACY_MANIFEST}): ${LEGACY[*]}"
  run_node "$OUT_DIR/legacy-results.json" "$OUT_DIR/spec.log" "${LEGACY[@]}"
  status=$?
  [[ -s "$OUT_DIR/legacy-results.json" ]] && export SUITE_RESULTS_PRELOAD="$OUT_DIR/legacy-results.json"
fi

if (( ${#MAIN[@]} > 0 )) && [[ $status -ne 124 && $status -ne 137 ]]; then
  run_node "$OUT_DIR/results.json" "$OUT_DIR/spec-main.log" "${MAIN[@]}"
  status=$?
  cat "$OUT_DIR/spec-main.log" >> "$OUT_DIR/spec.log" 2>/dev/null
  rm -f "$OUT_DIR/spec-main.log"
elif [[ -s "$OUT_DIR/legacy-results.json" ]]; then
  cp "$OUT_DIR/legacy-results.json" "$OUT_DIR/results.json"
fi

note=""
if [[ $status -eq 124 || $status -eq 137 ]]; then
  note="Global timeout of ${GLOBAL_TIMEOUT_S}s reached; results are partial."
  echo "$note" >&2
fi

if [[ ! -s "$OUT_DIR/results.json" ]]; then
  echo "no results.json produced (node exit $status); see $OUT_DIR/spec.log" >&2
  exit 4
fi

node reporter/render-md.ts "$OUT_DIR/results.json" "$OUT_DIR/results.md" "$note"
echo "results (SUITE_CR=${SUITE_CR}): $OUT_DIR/results.json, $OUT_DIR/results.md, $OUT_DIR/spec.log (node exit $status)"
exit 0
