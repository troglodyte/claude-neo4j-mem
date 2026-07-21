#!/usr/bin/env bash
# Launches Claude Code with the neo4j-memory plugin loaded from this repo,
# so you don't have to remember the --plugin-dir flag/path.
# Usage: scripts/claude-with-memory.sh [any other claude args...]
set -euo pipefail

# Resolve in two steps and verify the result. Written as `cd "$(dirname X)/.."`
# this silently degrades to `cd /..` -> "/" if the substitution yields nothing,
# and `set -e` does not catch it because `cd /` succeeds. Claude Code then
# accepts `--plugin-dir /` without complaint, so the session starts looking
# entirely normal but with no memory plugin loaded.
# The `|| =""` keeps set -e from aborting here with a bare "cd: null directory",
# so the explanatory check below is what the user actually sees.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || SCRIPT_DIR=""
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || REPO_ROOT=""

if [[ ! -f "$REPO_ROOT/.claude-plugin/plugin.json" ]]; then
  echo "claude-with-memory: resolved plugin dir '$REPO_ROOT' is not this repo" >&2
  echo "  (no .claude-plugin/plugin.json there). Refusing to launch without the" >&2
  echo "  memory plugin. Run this script by its path from a checkout, e.g." >&2
  echo "  bash /path/to/claude-neo4j/scripts/claude-with-memory.sh" >&2
  exit 1
fi

exec claude --plugin-dir "$REPO_ROOT" "$@"
