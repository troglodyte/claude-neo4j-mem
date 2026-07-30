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

# Replaced in Task 5 by the consent-gated installer.
offer_engine_install() {
  cat >&2 <<'EOF'
No container engine found. Install Podman (recommended) or Docker, then re-run.

  Debian/Ubuntu  sudo apt-get install -y podman
  macOS          brew install podman && podman machine init && podman machine start

Or skip containers entirely and point the plugin at a remote Neo4j
(e.g. Neo4j Aura's free tier: https://console.neo4j.io):
  node scripts/configure.mjs --mode remote \
    --uri neo4j+s://xxxxx.databases.neo4j.io \
    --username neo4j --password '...' --database neo4j
EOF
  return 1
}

# shellcheck source=scripts/lib-engine.sh
. "$REPO_ROOT/scripts/lib-engine.sh"

if ! resolve_engine; then
  offer_engine_install || exit 1     # defined in Task 5
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
