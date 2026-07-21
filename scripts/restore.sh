#!/usr/bin/env bash
# Restores the local Neo4j memory graph from an archive made by backup.sh.
#
# This REPLACES the current database. The archive is verified and the current
# contents are counted and shown before anything is destroyed, and you have to
# type the database name to confirm.
#
# Usage:
#   scripts/restore.sh --latest             restore the newest backup
#   scripts/restore.sh FILE                 restore a specific archive
#   scripts/restore.sh --latest --force     skip the confirmation prompt
#   scripts/restore.sh --info FILE          inspect an archive, restore nothing
#
# Accepts both .dump.xz and plain .dump. Local mode only.
set -uo pipefail

PROG="restore.sh"
# The shared library lives next to this script, so it has to be located before
# resolve_repo_root can run. Resolve in two steps and assert, for the same
# reason resolve_repo_root does: a bare `cd "$(dirname X)"` silently yields "/"
# when the substitution fails, and set -e cannot see it.
_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || _SCRIPT_DIR=""
if [ -z "$_SCRIPT_DIR" ] || [ ! -f "$_SCRIPT_DIR/../.claude-plugin/plugin.json" ]; then
  echo "restore.sh: resolved repo root '$_SCRIPT_DIR/..' is not this repo" >&2
  exit 1
fi
# shellcheck source=scripts/lib-backup.sh
source "$_SCRIPT_DIR/lib-backup.sh" || exit 1
resolve_repo_root "${BASH_SOURCE[0]}"

FILE=""
LATEST=0
FORCE=0
INFO_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --latest) LATEST=1; shift ;;
    --force) FORCE=1; shift ;;
    --info) INFO_ONLY=1; shift ;;
    --help|-h) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option '$1' (try --help)" ;;
    *) [ -z "$FILE" ] || die "more than one archive given"; FILE="$1"; shift ;;
  esac
done

if [ "$LATEST" = "1" ]; then
  [ -z "$FILE" ] || die "pass either --latest or a file, not both"
  FILE="$(ls -1t "$BACKUP_DIR"/neo4j-*.dump "$BACKUP_DIR"/neo4j-*.dump.xz 2>/dev/null | head -1)"
  [ -n "$FILE" ] || die "no backups found in $BACKUP_DIR"
fi
[ -n "$FILE" ] || die "no archive given (pass a path, or --latest)"
[ -r "$FILE" ] || die "cannot read '$FILE'"

load_config
require_local_mode
require_docker

IMAGE="$(container_image)"
[ -n "$IMAGE" ] || die "could not determine the image for $CONTAINER"

# Decompress by content, not by extension, so a renamed or hand-decompressed
# archive still restores.
if head -c 6 "$FILE" | grep -q $'\xfd7zXZ'; then
  DECOMPRESS=(xz -dc "$FILE")
  command -v xz >/dev/null 2>&1 || die "'$FILE' is xz-compressed but xz is not installed"
else
  DECOMPRESS=(cat "$FILE")
fi

# Verify the archive BEFORE stopping anything. --info reports the format and
# byte count without loading, so a truncated or non-Neo4j file fails here while
# the existing graph is still intact and online.
echo "Verifying $(basename "$FILE")..."

# Checksum first, because it is the only check that catches truncation.
# neo4j-admin's `load --info` parses just the archive header and happily
# reports a partial file as complete, so without a sidecar an archive that
# passes verification can still fail halfway through the load — after the
# existing database has already been overwritten.
if [ -r "$FILE.sha256" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    check=(sha256sum -c --status)
  elif command -v shasum >/dev/null 2>&1; then
    check=(shasum -a 256 -c --status)
  else
    check=()
  fi
  if [ "${#check[@]}" -gt 0 ]; then
    if (cd "$(dirname "$FILE")" && "${check[@]}" "$(basename "$FILE").sha256"); then
      echo "  checksum: ok"
    else
      die "checksum mismatch for '$FILE' — the archive is truncated or corrupted; nothing was changed"
    fi
  fi
else
  echo "  checksum: no .sha256 sidecar; a truncated archive cannot be detected" >&2
fi

# Output goes to a file rather than a command substitution: PIPESTATUS inside
# $(...) describes the substitution itself, not the pipeline within it, so the
# docker exit status would be invisible.
INFO_OUT="$(mktemp)"
"${DECOMPRESS[@]}" 2>/dev/null | docker run --rm -i --volumes-from "$CONTAINER" "$IMAGE" \
  neo4j-admin database load "$DATABASE" --info --from-stdin >"$INFO_OUT" 2>&1
info_status="${PIPESTATUS[1]}"
if [ "$info_status" -ne 0 ]; then
  sed 's/^/  /' "$INFO_OUT" >&2
  rm -f "$INFO_OUT"
  die "'$FILE' is not a readable Neo4j archive; nothing was changed"
fi
sed 's/^/  /' "$INFO_OUT"
rm -f "$INFO_OUT"

if [ "$INFO_ONLY" = "1" ]; then
  exit 0
fi

# Show what is about to be destroyed. Best-effort: if the container is down or
# credentials are missing we still restore, we just cannot report the counts.
if [ "$FORCE" != "1" ] && container_running; then
  counts="$("$REPO_ROOT/scripts/cypher.sh" \
    "MATCH (e:Entity) WITH count(e) AS entities MATCH (o:Observation) RETURN entities, count(o) AS observations;" \
    2>/dev/null | tail -n +2)"
  echo
  if [ -n "$counts" ]; then
    echo "Current database '$DATABASE' holds: ${counts//,/ entities, } observations"
  else
    echo "Current database '$DATABASE' contents could not be read (counts unavailable)."
  fi
fi

if [ "$FORCE" != "1" ]; then
  cat <<EOF

This will REPLACE database '$DATABASE' with the archive above.
Everything currently in it is destroyed and is not recoverable without another backup.

EOF
  printf "Type the database name (%s) to confirm: " "$DATABASE"
  read -r reply
  [ "$reply" = "$DATABASE" ] || die "confirmation did not match; nothing was changed"
fi

stop_container_with_restart_trap

echo "Loading database '$DATABASE'..."
"${DECOMPRESS[@]}" | docker run --rm -i --volumes-from "$CONTAINER" "$IMAGE" \
  neo4j-admin database load "$DATABASE" --from-stdin --overwrite-destination
status="${PIPESTATUS[1]}"
[ "$status" -eq 0 ] || die "neo4j-admin load failed (exit $status); the database may be in a partial state — restore again from a known-good archive"

restart_container
trap - EXIT INT TERM
wait_for_health || die "load completed, but the container is unhealthy"

# Report the restored counts rather than assuming the round trip worked.
echo
echo "Restored from $FILE"
after="$("$REPO_ROOT/scripts/cypher.sh" \
  "MATCH (e:Entity) WITH count(e) AS entities MATCH (o:Observation) RETURN entities, count(o) AS observations;" \
  2>/dev/null | tail -n +2)"
if [ -n "$after" ]; then
  echo "Database '$DATABASE' now holds: ${after//,/ entities, } observations"
else
  echo "Restored, but the counts could not be read back — check: npm run memory -- status"
fi
