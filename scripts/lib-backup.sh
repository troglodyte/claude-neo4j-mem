#!/usr/bin/env bash
# Shared plumbing for backup.sh / restore.sh. Sourced, never executed.
#
# Both scripts drive neo4j-admin against the *stopped* container's data volume,
# so they need the same three things: the repo root, the local-mode config, and
# a way to stop the container that is guaranteed to start it again afterwards.

CONTAINER="claude-neo4j-memory"
BACKUP_DIR="${CLAUDE_NEO4J_BACKUP_DIR:-$HOME/.claude-neo4j/backups}"
CONFIG_FILE="$HOME/.claude-neo4j/config.json"

# Resolved in two steps and checked: as a single `cd "$(dirname X)/.."` this
# degrades to "/" when the substitution yields nothing, and set -e can't see it.
resolve_repo_root() {
  local self="$1" script_dir
  script_dir="$(cd -- "$(dirname -- "$self")" && pwd -P)" || script_dir=""
  REPO_ROOT="$(cd -- "$script_dir/.." && pwd -P)" || REPO_ROOT=""
  [ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
    echo "$(basename -- "$self"): resolved repo root '$REPO_ROOT' is not this repo" >&2
    exit 1
  }
}

die() { echo "$PROG: $*" >&2; exit 1; }

# mode + database only; the dump operates on store files, so no credentials are
# needed here. Same resolution order as cypher.sh.
load_config() {
  MODE="${NEO4J_MODE:-}"; DATABASE="${NEO4J_DATABASE:-}"
  if [ -r "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
    local cfg_mode cfg_database cfg_uri
    eval "$(jq -r '
      @sh "cfg_mode=\(.mode // "")",
      @sh "cfg_database=\(.database // "")",
      @sh "cfg_uri=\(.uri // "")"
    ' "$CONFIG_FILE" 2>/dev/null)"
    MODE="${MODE:-${cfg_mode:-}}"
    DATABASE="${DATABASE:-${cfg_database:-}}"
    if [ -z "$MODE" ]; then
      case "${cfg_uri:-}" in
        bolt://localhost*|bolt://127.0.0.1*) MODE="local" ;;
        "") ;;
        *) MODE="remote" ;;
      esac
    fi
  fi
  DATABASE="${DATABASE:-neo4j}"
  MODE="${MODE:-local}"
}

# A dump/load reads and writes store files directly, so it can only ever reach
# a database on this machine. Say so plainly instead of failing inside docker.
require_local_mode() {
  [ "$MODE" = "local" ] && return 0
  cat >&2 <<EOF
$PROG: this only works in local mode (current mode: $MODE).

neo4j-admin dump/load operate on the database's files, so they cannot reach a
remote instance such as Neo4j Aura. For a remote database, use the provider's
own snapshot feature — Aura takes daily backups and can restore from the
console at https://console.neo4j.io.
EOF
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed (or not on PATH)"
  docker info >/dev/null 2>&1 || die "docker is installed but its daemon isn't reachable"
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container $CONTAINER not found (run: scripts/setup-local.sh)"
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

# Match the image the container actually runs, so a pinned or upgraded Neo4j
# version dumps with its own neo4j-admin rather than whatever :5-community is.
container_image() {
  docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null
}

# The container must come back on *every* exit path — a failed dump or a Ctrl-C
# must not leave the memory graph offline. Callers install this before stopping.
WAS_RUNNING=0
restart_container() {
  [ "$WAS_RUNNING" = "1" ] || return 0
  container_running && return 0
  echo "Restarting $CONTAINER..."
  docker start "$CONTAINER" >/dev/null || {
    echo "$PROG: FAILED to restart $CONTAINER — start it with: docker start $CONTAINER" >&2
    return 1
  }
}

stop_container_with_restart_trap() {
  if container_running; then
    WAS_RUNNING=1
    trap restart_container EXIT INT TERM
    echo "Stopping $CONTAINER (neo4j-admin cannot touch a mounted database)..."
    docker stop "$CONTAINER" >/dev/null || die "failed to stop $CONTAINER"
  else
    echo "$CONTAINER is already stopped; leaving it that way."
  fi
}

wait_for_health() {
  local status="" i
  for i in $(seq 1 30); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] && return 0
    sleep 2
  done
  echo "$PROG: $CONTAINER did not become healthy in time (status: $status)" >&2
  return 1
}

human_size() {
  local bytes="$1"
  if command -v numfmt >/dev/null 2>&1; then
    numfmt --to=iec --suffix=B "$bytes"
  else
    echo "${bytes}B"
  fi
}

file_size() {
  # stat's flags differ between GNU and BSD; try both rather than assume.
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null
}
