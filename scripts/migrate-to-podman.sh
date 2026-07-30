#!/usr/bin/env bash
# One-shot Docker -> Podman migration for the local memory graph.
#
# Podman cannot see Docker's named volumes (separate storage backends), so the
# graph moves by dump/load. Both sides run the identical neo4j:5-community
# image, so the dump is version-neutral and NEO4J_AUTH sets the new container's
# password on first start.
#
# Nothing here writes to the Docker container or its volume. Until the reclaim
# command printed at the end is run by hand, rollback is always:
#   podman stop claude-neo4j-memory && docker start claude-neo4j-memory
set -euo pipefail

PROG="migrate-to-podman.sh"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || SCRIPT_DIR=""
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || REPO_ROOT=""
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
  echo "$PROG: resolved repo root '$REPO_ROOT' is not this repo" >&2
  exit 1
}
cd "$REPO_ROOT"

CONTAINER="claude-neo4j-memory"
REHEARSAL="claude-neo4j-rehearsal"
IMAGE="neo4j:5-community"
die() { echo "$PROG: $*" >&2; exit 1; }

command -v podman >/dev/null 2>&1 || die "podman is not installed (run scripts/setup-local.sh)"
podman info >/dev/null 2>&1 || die "podman is installed but not usable"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "no Docker container $CONTAINER to migrate from"

set -a; . "$REPO_ROOT/docker/.env"; set +a
: "${NEO4J_USERNAME:=neo4j}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD is not set in docker/.env}"

cleanup_rehearsal() { podman rm -f -v "$REHEARSAL" >/dev/null 2>&1 || true; }
trap cleanup_rehearsal EXIT

# --- Step 1: baseline fingerprint (Docker still serving) --------------------
echo "==> Fingerprinting the live Docker graph..."
docker start "$CONTAINER" >/dev/null 2>&1 || true
BEFORE="$(scripts/fingerprint.sh docker "$CONTAINER")"
echo "$BEFORE" | sed 's/^/    /'

# --- Step 0: safety net, and the migration source ---------------------------
# Same artifact for both roles: what is verified in rehearsal is byte-identical
# to what would be restored in an emergency.
echo "==> Taking a backup (safety net AND migration source)..."
CLAUDE_NEO4J_ENGINE=docker bash scripts/backup.sh
DUMP="$(ls -t "${CLAUDE_NEO4J_BACKUP_DIR:-$HOME/.claude-neo4j/backups}"/*.dump | head -1)"
[ -n "$DUMP" ] || die "backup produced no .dump"
echo "    $DUMP"
( cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256" ) \
  || die "backup checksum failed; refusing to migrate from an unverified dump"

# --- Step 2: rehearse on 7688 (Docker untouched on 7687) --------------------
echo "==> Rehearsing on port 7688..."
podman volume create claude_neo4j_data >/dev/null 2>&1 || true
podman volume create claude_neo4j_logs >/dev/null 2>&1 || true

podman run --rm -i -v claude_neo4j_data:/data "$IMAGE" \
  neo4j-admin database load neo4j --from-stdin --overwrite-destination=true \
  < "$DUMP" || die "load into the Podman volume failed; Docker is untouched"

podman run -d --name "$REHEARSAL" \
  -p 7688:7687 -p 7475:7474 \
  -e NEO4J_AUTH="${NEO4J_USERNAME}/${NEO4J_PASSWORD}" \
  -v claude_neo4j_data:/data -v claude_neo4j_logs:/logs \
  --health-cmd "wget -O /dev/null -q http://localhost:7474 || exit 1" \
  --health-interval 5s --health-timeout 5s --health-retries 30 \
  "$IMAGE" >/dev/null

echo "    waiting for the rehearsal container..."
for _ in $(seq 1 40); do
  s="$(podman inspect -f '{{.State.Health.Status}}' "$REHEARSAL" 2>/dev/null)"
  [ -n "$s" ] || s="$(podman inspect -f '{{.State.Healthcheck.Status}}' "$REHEARSAL" 2>/dev/null)"
  [ "$s" = "healthy" ] && break
  sleep 2
done
[ "${s:-}" = "healthy" ] || die "rehearsal container never became healthy (status: ${s:-unknown}); Docker is untouched"

AFTER="$(scripts/fingerprint.sh podman "$REHEARSAL")"
echo "$AFTER" | sed 's/^/    /'

if [ "$BEFORE" != "$AFTER" ]; then
  echo >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  die "fingerprint mismatch — the Podman copy differs from Docker. Nothing was cut over; Docker is still serving 7687."
fi
echo "    fingerprints match."

# --- Step 3: cut over --------------------------------------------------------
echo "==> Cutting over to Podman on 7687..."
podman rm -f -v "$REHEARSAL" >/dev/null 2>&1 || true
trap - EXIT
docker stop "$CONTAINER" >/dev/null || die "could not stop the Docker container; nothing changed"

podman run -d --name "$CONTAINER" --restart unless-stopped \
  -p "${NEO4J_HTTP_PORT:-7474}:7474" -p "${NEO4J_BOLT_PORT:-7687}:7687" \
  -e NEO4J_AUTH="${NEO4J_USERNAME}/${NEO4J_PASSWORD}" \
  -e NEO4J_dbms_memory_pagecache_size=512M \
  -e NEO4J_server_memory_heap_max__size=512M \
  -v claude_neo4j_data:/data -v claude_neo4j_logs:/logs \
  --health-cmd "wget -O /dev/null -q http://localhost:7474 || exit 1" \
  --health-interval 5s --health-timeout 5s --health-retries 30 \
  "$IMAGE" >/dev/null || {
    echo "$PROG: Podman container failed to start; rolling back to Docker." >&2
    docker start "$CONTAINER" >/dev/null || true
    exit 1
  }

cat <<EOF

Migration complete. Podman now serves the graph on 7687.

  Verify:   scripts/check-health.sh
  Rollback: podman stop $CONTAINER && podman rm $CONTAINER && docker start $CONTAINER

The Docker container and its 544MB volume are untouched. Once you are
satisfied, reclaim that space with:

  docker rm $CONTAINER
  docker volume rm docker_claude_neo4j_data docker_claude_neo4j_logs

Backup kept at: $DUMP
EOF
