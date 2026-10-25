#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node_ok() {
  command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)'
}

if ! node_ok && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  set +u
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use 26 >/dev/null
  set -u
fi

if ! node_ok; then
  echo "Node.js 26 or newer is required" >&2
  exit 1
fi

NODE_FLAGS=(--disable-warning=ExperimentalWarning)
