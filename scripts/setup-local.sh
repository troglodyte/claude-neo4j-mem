#!/usr/bin/env bash
# One-command local setup: checks Docker is available, generates docker/.env
# if missing, starts/waits for the Neo4j container, then configures the
# plugin against it. Safe to re-run any time (idempotent).
# Usage: ./scripts/setup-local.sh   (or from repo root: scripts/setup-local.sh)
set -euo pipefail

# Resolved in two steps and checked: as a single `cd "$(dirname X)/.."` this
# degrades to "/" when the substitution yields nothing, and set -e can't see it.
# The `|| =""` keeps set -e from aborting here with a bare "cd: null directory",
# so the explanatory check below is what the user actually sees.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || SCRIPT_DIR=""
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || REPO_ROOT=""
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
  echo "setup-local.sh: resolved repo root '$REPO_ROOT' is not this repo" >&2
  exit 1
}
cd "$REPO_ROOT"

# Podman has no supported user-local tarball, so Linux installs need sudo.
# It is never escalated silently: print the exact command, then ask.
offer_engine_install() {
  local cmd=""
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 && cmd="brew install podman" ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        cmd="sudo apt-get install -y podman"
      elif command -v dnf >/dev/null 2>&1; then
        cmd="sudo dnf install -y podman"
      elif command -v pacman >/dev/null 2>&1; then
        cmd="sudo pacman -S --noconfirm podman"
      fi ;;
  esac

  if [ -z "$cmd" ]; then
    cat >&2 <<'EOF'
No container engine found, and no supported package manager was detected.

Install Podman (recommended) or Docker by hand, then re-run this script.
  https://podman.io/docs/installation

Or point the plugin at a remote Neo4j instead (e.g. Neo4j Aura's free tier):
  node scripts/configure.mjs --mode remote \
    --uri neo4j+s://xxxxx.databases.neo4j.io \
    --username neo4j --password '...' --database neo4j
EOF
    return 1
  fi

  echo "No container engine found. Podman can be installed with:"
  echo
  echo "    $cmd"
  echo

  # No tty means no consent. Print and stop rather than assume.
  if [ ! -t 0 ]; then
    echo "Not running interactively — run the command above, then re-run this script." >&2
    return 1
  fi

  local reply=""
  read -r -p "Run it now? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Skipped. Run the command above, then re-run this script." >&2; return 1 ;;
  esac

  # shellcheck disable=SC2086
  $cmd || { echo "Install failed. Run '$cmd' by hand and re-check the output." >&2; return 1; }

  if [ "$(uname -s)" = "Darwin" ]; then
    echo "Provisioning the Podman VM (this can take a few minutes)..."
    podman machine init 2>/dev/null || true   # already-initialised is not an error
    podman machine start 2>/dev/null || true
  fi

  resolve_engine || {
    echo "Podman installed but still not usable.$(engine_hint podman)" >&2
    return 1
  }
  return 0
}

# shellcheck source=scripts/lib-engine.sh
. "$REPO_ROOT/scripts/lib-engine.sh"

if ! resolve_engine; then
  offer_engine_install || exit 1
fi
echo "Using container engine: $ENGINE"

ENV_FILE="docker/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE yet — generating one with a random password."
  cp docker/.env.example "$ENV_FILE"
  if command -v openssl >/dev/null 2>&1; then
    generated_password="$(openssl rand -hex 16)"
  else
    generated_password="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  # Portable in-place edit: write to a temp file, then replace (macOS `sed -i`
  # requires a backup-suffix arg; this form works the same on both GNU and BSD sed).
  sed "s/^NEO4J_PASSWORD=.*/NEO4J_PASSWORD=${generated_password}/" "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

: "${NEO4J_USERNAME:=neo4j}"
: "${NEO4J_BOLT_PORT:=7687}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD is not set in docker/.env}"

# Volume names are the ones compose already created ("docker_" prefix and all).
# Renaming them would strand the existing graph in a detached volume and hand
# the user a silently empty database.
DATA_VOLUME="docker_claude_neo4j_data"
LOGS_VOLUME="docker_claude_neo4j_logs"

start_container() {
  "$ENGINE" run -d \
    --name claude-neo4j-memory \
    --restart unless-stopped \
    -p "${NEO4J_HTTP_PORT:-7474}:7474" \
    -p "${NEO4J_BOLT_PORT:-7687}:7687" \
    -e NEO4J_AUTH="${NEO4J_USERNAME}/${NEO4J_PASSWORD}" \
    -e NEO4J_dbms_memory_pagecache_size=512M \
    -e NEO4J_server_memory_heap_max__size=512M \
    -v "$DATA_VOLUME:/data" \
    -v "$LOGS_VOLUME:/logs" \
    --health-cmd "wget -O /dev/null -q http://localhost:7474 || exit 1" \
    --health-interval 5s \
    --health-timeout 5s \
    --health-retries 30 \
    neo4j:5-community >/dev/null
}

if ! "$ENGINE" inspect claude-neo4j-memory >/dev/null 2>&1; then
  echo "Container claude-neo4j-memory not found, starting it under $ENGINE..."
  start_container
fi

echo "Waiting for claude-neo4j-memory container to be healthy..."
for _ in $(seq 1 30); do
  status="$(container_health claude-neo4j-memory)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$status" = "unknown" ]; then
    echo "Container claude-neo4j-memory not found. Run: scripts/setup-local.sh" >&2
    exit 1
  fi
  sleep 2
done

if [ "$status" != "healthy" ]; then
  echo "Container did not become healthy in time (status: $status)." >&2
  exit 1
fi

echo "Container healthy. Configuring plugin..."
node scripts/configure.mjs \
  --mode local \
  --uri "bolt://localhost:${NEO4J_BOLT_PORT}" \
  --username "$NEO4J_USERNAME" \
  --password "$NEO4J_PASSWORD" \
  --database neo4j
