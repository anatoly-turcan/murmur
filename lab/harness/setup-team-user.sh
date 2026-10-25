#!/usr/bin/env bash
# One-time host setup for the isolated team user (EXPERIMENT §3, gate G9).
# Run as root:  sudo bash harness/setup-team-user.sh [runs-root]
# Afterwards launch a run with:  sudo -u "$LAB_TEAM_USER" -i bash <run dir>/launch.sh
#
# Environment (all optional):
#   LAB_OWNER       the account that owns the lab and the Claude Code login   (default: $SUDO_USER)
#   LAB_TEAM_USER   the isolated account the team sessions run as             (default: labteam)
#   LAB_ROOT        the lab directory, made 700 so the team user cannot read it (default: parent of this script)
#   LAB_NODE_BIN    directory holding the Node 26 binary                       (default: newest v26 under the owner's nvm)
# The runs root defaults to $LAB_RUNS_ROOT, else <lab>/../../murmur-runs, exactly as the harness resolves it.
set -euo pipefail

OWNER=${LAB_OWNER:-${SUDO_USER:?set LAB_OWNER or run through sudo}}
TEAM=${LAB_TEAM_USER:-labteam}
HOME_OWNER=$(getent passwd "$OWNER" | cut -d: -f6)
LAB=$(realpath "${LAB_ROOT:-$(dirname "${BASH_SOURCE[0]}")/..}")
RUNS=$(realpath -m "${1:-${LAB_RUNS_ROOT:-$LAB/../../murmur-runs}}")
NODE_BIN=${LAB_NODE_BIN:-$(ls -d "$HOME_OWNER"/.nvm/versions/node/v26*/bin | tail -1)}
SHARED=("$NODE_BIN" "$HOME_OWNER/.local/share/claude" "$HOME_OWNER/.local/bin")

traverse_ancestors() {
  local dir
  dir=$(dirname "$1")
  while [[ "$dir" != / && "$dir" != "$(dirname "$HOME_OWNER")" ]]; do
    setfacl -m "u:$TEAM:x" "$dir"
    dir=$(dirname "$dir")
  done
}

id "$TEAM" >/dev/null 2>&1 || useradd -m -s /bin/bash "$TEAM"

chmod 700 "$LAB"
mkdir -p "$RUNS"
chown "$OWNER:$OWNER" "$RUNS"
chmod 711 "$RUNS"
traverse_ancestors "$RUNS"

for path in "${SHARED[@]}"; do
  [[ -e "$path" ]] || continue
  traverse_ancestors "$path"
  setfacl -R -m "u:$TEAM:rX" "$path"
done
case "$NODE_BIN" in "$HOME_OWNER"/.nvm/*) setfacl -R -m "u:$TEAM:rX" "$(dirname "$NODE_BIN")" ;; esac

install -d -o "$TEAM" -g "$TEAM" -m 700 "/home/$TEAM/.claude"
install -o "$TEAM" -g "$TEAM" -m 600 "$HOME_OWNER/.claude/.credentials.json" "/home/$TEAM/.claude/.credentials.json"
cat > "/home/$TEAM/.bash_profile" <<PROFILE
export PATH=$NODE_BIN:$HOME_OWNER/.local/bin:\$PATH
export LAB_RUNS_ROOT=$RUNS
[ -f ~/.bashrc ] && . ~/.bashrc
PROFILE
chown "$TEAM:$TEAM" "/home/$TEAM/.bash_profile"

echo "$TEAM ready: lab $LAB is 700, runs root $RUNS, node from $NODE_BIN"
echo "leak probe (G9): sudo -u $TEAM -i cat $LAB/experiment/TRAPS.md  -> must be 'Permission denied'"
