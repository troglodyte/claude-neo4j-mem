#!/usr/bin/env bash
# One-shot Docker -> Podman migration for the local memory graph.
#
# Podman cannot see Docker's named volumes (separate storage backends), so the
# graph moves by dump/load. Both sides run the identical Neo4j 5 Community
# image, so the dump is version-neutral and NEO4J_AUTH sets the new container's
# password on first start.
#
# Docker's data is never modified destructively. This script stops and starts
# the Docker container (a clean shutdown, which checkpoints the database) but
# never deletes or overwrites its volume, so rollback stays available right up
# until the reclaim commands printed at the end are run by hand. The graph is
# briefly offline twice: during the Step 0 dump (neo4j-admin refuses to dump a
# mounted database) and during the few-second cutover window itself. Until the
# reclaim commands are run, rollback is always:
#   podman stop claude-neo4j-memory && podman rm claude-neo4j-memory && docker start claude-neo4j-memory
# and nothing else: resolve_engine follows whichever engine is running the
# container, so that last command is what hands the tooling back to Docker.
set -euo pipefail

PROG="migrate-to-podman.sh"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || SCRIPT_DIR=""
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || REPO_ROOT=""
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
  echo "$PROG: resolved repo root '$REPO_ROOT' is not this repo" >&2
  exit 1
}
cd "$REPO_ROOT"

# shellcheck source=scripts/lib-engine.sh
source "$REPO_ROOT/scripts/lib-engine.sh"
# This script drives both engines explicitly by name (never via
# resolve_engine), but container_health reads the shared $ENGINE global, and
# every container it is asked to check here (the rehearsal, then the cutover
# container) is on the Podman side.
ENGINE="podman"

CONTAINER="claude-neo4j-memory"
REHEARSAL="claude-neo4j-rehearsal"
# Fully qualified, deliberately: Docker expands the unqualified spelling to
# this, but Podman refuses to guess a registry unless the host configures
# `unqualified-search-registries` (Debian and Ubuntu ship it commented out), and
# Neo4j is not one of the short-name aliases in shortnames.conf. The short form
# therefore fails on a stock Podman host while working fine under Docker.
# Docker accepts the long form unchanged, so one spelling serves both.
IMAGE="docker.io/library/neo4j:5-community"
die() { echo "$PROG: $*" >&2; exit 1; }

command -v podman >/dev/null 2>&1 || die "podman is not installed (run scripts/setup-local.sh)"
# The hint matters most on macOS: a reboot leaves podman-machine-default
# stopped, `podman info` fails, and this is the first thing a user hits when
# they (reasonably) re-run the migration to get memory back. Without it the
# message is a dead end where the actual fix is one command.
podman info >/dev/null 2>&1 || die "podman is installed but not usable.$(engine_hint podman)"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "no Docker container $CONTAINER to migrate from"

# CRITICAL: a second run must never load a stale dump over an already-
# migrated volume. The post-migration steady state is: the Podman container
# exists, the Docker container is deliberately kept but stopped, and Docker's
# volume still holds the PRE-migration graph. Podman does not survive a reboot
# without the mechanism scripts/setup-local.sh installs (a systemd user unit
# on Linux, a login agent running `podman machine start` on macOS), so after
# a reboot memory is offline and re-running this script is the obvious user
# response - and without this guard, that re-run would fingerprint the stale
# Docker graph, dump it, and load it over claude_neo4j_data with
# --overwrite-destination=true, silently destroying everything captured since
# the original migration (both fingerprints would still match, because both
# would be equally stale).
podman inspect "$CONTAINER" >/dev/null 2>&1 && die "a Podman container $CONTAINER already exists — this migration has already run. To re-run deliberately, remove it first: podman rm -f $CONTAINER"

# A volume left behind by a prior aborted run keeps its own already-
# initialized 'system' database, so NEO4J_AUTH is never re-applied by a later
# `podman run` and every retry then fails un-authenticatable with no hint why.
podman volume inspect claude_neo4j_data >/dev/null 2>&1 && die "podman volume claude_neo4j_data already exists from a prior attempt — remove it first: podman volume rm claude_neo4j_data claude_neo4j_logs"
podman volume inspect claude_neo4j_logs >/dev/null 2>&1 && die "podman volume claude_neo4j_logs already exists from a prior attempt — remove it first: podman volume rm claude_neo4j_data claude_neo4j_logs"

set -a; . "$REPO_ROOT/docker/.env"; set +a
: "${NEO4J_USERNAME:=neo4j}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD is not set in docker/.env}"

cleanup_rehearsal() { podman rm -f -v "$REHEARSAL" >/dev/null 2>&1 || true; }
trap cleanup_rehearsal EXIT

echo
echo "==> Before you continue: close every other Claude Code session on this"
echo "    machine (or anything else writing to the graph). This repo's own"
echo "    SessionEnd/PreCompact hooks write to it. Writes landing in Docker"
echo "    between the baseline fingerprint below and the pre-cutover re-check"
echo "    will be caught and aborted on, but the cleanest run has nothing"
echo "    writing at all."
echo

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
# `|| true` on the assignment: under pipefail, a non-matching glob makes `ls`
# exit non-zero even though `head` (the last pipeline stage) succeeds on empty
# input, which would trip `set -e` on the assignment itself and abort with a
# raw `ls` error - never reaching the friendly die() below.
DUMP="$(ls -t "${CLAUDE_NEO4J_BACKUP_DIR:-$HOME/.claude-neo4j/backups}"/*.dump 2>/dev/null | head -1)" || true
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
  s="$(container_health "$REHEARSAL" || echo unknown)"
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

# The rehearsal above can take minutes, and Docker keeps serving 7687 for all
# of it. Anything written in that window would be silently absent from the
# migrated copy and caught by nothing. Re-fingerprinting right before the stop
# shrinks that window to seconds and turns a silent loss into a detected,
# aborted mismatch instead.
echo "==> Re-checking the Docker graph immediately before cutover..."
RECHECK="$(scripts/fingerprint.sh docker "$CONTAINER")"
if [ "$BEFORE" != "$RECHECK" ]; then
  echo >&2
  diff <(echo "$BEFORE") <(echo "$RECHECK") >&2 || true
  die "the Docker graph changed since the baseline fingerprint — something wrote to it during the rehearsal (close other Claude Code sessions and re-run). Docker is untouched and still serving 7687."
fi

# From here until the Podman container is confirmed healthy, `docker stop`
# below can leave Docker down and Podman unproven. `docker stop` itself blocks
# for seconds while Neo4j shuts down, and a Ctrl-C during that wait is exactly
# as dangerous as one after it - so the trap is armed BEFORE the stop, not
# after, and covers the stop itself, not just the window that follows it.
# `docker start` on an already-running container is a harmless no-op, so
# arming this early costs nothing. It is cleared only once the health check
# below passes.
CUTOVER_HEALTHY=0
cutover_recover() {
  [ "$CUTOVER_HEALTHY" = "1" ] && return
  echo "$PROG: rolling back to Docker." >&2
  if docker start "$CONTAINER" >/dev/null 2>&1; then
    echo "$PROG: Docker is back up on 7687." >&2
  else
    echo "$PROG: rollback ALSO failed - Docker is down. Recover manually with: docker start $CONTAINER" >&2
  fi
}
trap cutover_recover EXIT INT TERM

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
    echo "$PROG: Podman container failed to start." >&2
    podman rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
    exit 1
  }

# `podman run -d` returning 0 only means the container started, not that Neo4j
# inside it is serving. Prove that before declaring success - a container that
# dies seconds later must still trigger the same rollback, not a false
# "Migration complete".
echo "    waiting for the Podman container to become healthy..."
cs="unknown"
for _ in $(seq 1 40); do
  cs="$(container_health "$CONTAINER" || echo unknown)"
  [ "$cs" = "healthy" ] && break
  sleep 2
done
if [ "$cs" != "healthy" ]; then
  echo "$PROG: Podman container never became healthy (status: $cs)." >&2
  podman rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
  exit 1
fi

CUTOVER_HEALTHY=1
trap - EXIT INT TERM

# The persistence advice is platform-specific, and printing the Linux one on a
# Mac was worse than printing nothing: setup-local.sh's systemd path returns
# early on Darwin, so "run it to persist across reboots" pointed at a step that
# installs nothing there and left the real answer -- `podman machine start` --
# unsaid. ENGINE is pinned to podman at the top of this script, so
# boot_persistence_kind here is deciding purely on the platform.
case "$(boot_persistence_kind)" in
  launchagent)
    PERSIST_BLOCK="  Persist across logins: scripts/setup-local.sh
            On macOS the container lives inside the podman-machine-default
            VM, which does not come back on its own - so --restart never gets
            to fire. setup-local.sh offers a login agent that runs
            'podman machine start' (Podman Desktop's 'Start Podman on login'
            does the same job). Safe to run now: it skips container creation
            since $CONTAINER already exists.
            If memory is offline after a reboot, the fix is
            'podman machine start' - NOT another run of this script, which
            the guard at the top refuses anyway." ;;
  *)
    PERSIST_BLOCK="  Persist across reboots: scripts/setup-local.sh
            Rootless Podman does NOT survive a reboot without the systemd
            unit this installs. Safe to run now: it skips container creation
            since $CONTAINER already exists. Skipping this step is the most
            likely way to end up wanting to re-run this script after a
            reboot - which the guard above now refuses to do silently, but
            it is simpler to just persist the container correctly the first
            time." ;;
esac

cat <<EOF

Migration complete. Podman now serves the graph on 7687.

$PERSIST_BLOCK
  Verify:   scripts/check-health.sh
  Rollback: podman stop $CONTAINER && podman rm $CONTAINER && docker start $CONTAINER
            That is the whole rollback - no environment variable to set or
            unset. resolve_engine picks whichever engine is actually running
            $CONTAINER, so starting Docker's again is what points
            check-health.sh, backup.sh, restore.sh and cypher.sh back at it.
            Pin it with CLAUDE_NEO4J_ENGINE=docker only if you want to
            override that for some other reason.

The Docker container and its volume are untouched. Once you are satisfied,
reclaim that space with:

  docker rm $CONTAINER
  docker volume rm docker_claude_neo4j_data docker_claude_neo4j_logs

Backup kept at: $DUMP
EOF
