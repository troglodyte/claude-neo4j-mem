#!/usr/bin/env bash
# Waits for the local Neo4j container to be healthy, then runs the configure
# wizard non-interactively using the credentials already in docker/.env.
# Usage: ./scripts/setup-local.sh   (or from repo root: scripts/setup-local.sh)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="docker/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Run: cp docker/.env.example docker/.env && edit the password." >&2
  exit 1
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
