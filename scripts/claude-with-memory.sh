#!/usr/bin/env bash
# Launches Claude Code with the neo4j-memory plugin loaded from this repo,
# so you don't have to remember the --plugin-dir flag/path.
# Usage: scripts/claude-with-memory.sh [any other claude args...]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec claude --plugin-dir "$REPO_ROOT" "$@"
