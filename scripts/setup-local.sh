#!/usr/bin/env bash
# One-command local setup: checks Docker is available, generates docker/.env
# if missing, starts/waits for the Neo4j container, then configures the
# plugin against it. Safe to re-run any time (idempotent).
# Usage: ./scripts/setup-local.sh   (or from repo root: scripts/setup-local.sh)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Docker is not installed (or not on PATH), so the bundled local Neo4j
container can't be started. Two ways forward:

  1. Install Docker, then re-run this script:
       https://docs.docker.com/get-docker/

  2. Skip Docker and point the plugin at a remote Neo4j instance instead
     (e.g. Neo4j Aura's free tier: https://console.neo4j.io):
       node scripts/configure.mjs --mode remote \
         --uri neo4j+s://xxxxx.databases.neo4j.io \
         --username neo4j --password '...' --database neo4j
EOF
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but its daemon isn't reachable. Start Docker Desktop (or the docker service), then re-run this script." >&2
  exit 1
fi

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

if ! docker inspect claude-neo4j-memory >/dev/null 2>&1; then
  echo "Container claude-neo4j-memory not found, starting it..."
  (cd docker && docker compose up -d)
fi

echo "Waiting for claude-neo4j-memory container to be healthy..."
for _ in $(seq 1 30); do
  status="$(docker inspect -f '{{.State.Health.Status}}' claude-neo4j-memory 2>/dev/null || echo "missing")"
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$status" = "missing" ]; then
    echo "Container claude-neo4j-memory not found. Run: (cd docker && docker compose up -d)" >&2
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
