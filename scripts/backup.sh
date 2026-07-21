#!/usr/bin/env bash
# Snapshots the local Neo4j memory graph to a single compressed archive using
# neo4j-admin's official dump format. The container is stopped for the dump
# (neo4j-admin refuses to touch a mounted database) and restarted afterwards,
# including if the dump fails.
#
# Usage:
#   scripts/backup.sh                 dump to ~/.claude-neo4j/backups/
#   scripts/backup.sh --out FILE      dump to a specific path
#   scripts/backup.sh --keep 7        afterwards, keep only the 7 newest backups
#   scripts/backup.sh --xz            additionally compress with xz
#   scripts/backup.sh --list          list existing backups and exit
#
# Local mode only: a dump reads store files, so it cannot reach Neo4j Aura.
#
# Compression is OFF by default on purpose. Neo4j's .dump format is already
# internally compressed: measured on a real 78-entity/1187-observation graph,
# xz -T0 took 898KB down to 890KB — 0.9%, for a slower backup and an extra
# decompression step on restore. --xz is kept for the rare case where the
# archive is being shipped somewhere that charges by the byte.
set -uo pipefail

PROG="backup.sh"
# The shared library lives next to this script, so it has to be located before
# resolve_repo_root can run. Resolve in two steps and assert, for the same
# reason resolve_repo_root does: a bare `cd "$(dirname X)"` silently yields "/"
# when the substitution fails, and set -e cannot see it.
_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || _SCRIPT_DIR=""
if [ -z "$_SCRIPT_DIR" ] || [ ! -f "$_SCRIPT_DIR/../.claude-plugin/plugin.json" ]; then
  echo "backup.sh: resolved repo root '$_SCRIPT_DIR/..' is not this repo" >&2
  exit 1
fi
# shellcheck source=scripts/lib-backup.sh
source "$_SCRIPT_DIR/lib-backup.sh" || exit 1
resolve_repo_root "${BASH_SOURCE[0]}"

OUT=""
KEEP=""
COMPRESS=0
LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; [ -n "$OUT" ] || die "--out needs a path"; shift 2 ;;
    --keep) KEEP="${2:-}"; shift 2 ;;
    --xz) COMPRESS=1; shift ;;
    --no-compress) COMPRESS=0; shift ;;  # accepted for symmetry; already the default
    --list) LIST=1; shift ;;
    --help|-h) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option '$1' (try --help)" ;;
  esac
done

if [ -n "$KEEP" ]; then
  case "$KEEP" in
    ''|*[!0-9]*) die "--keep needs a positive integer, got '$KEEP'" ;;
    0) die "--keep 0 would delete every backup including the one just taken" ;;
  esac
fi

list_backups() {
  # Newest first. Nothing here recurses or globs outside BACKUP_DIR.
  ls -1t "$BACKUP_DIR"/neo4j-*.dump "$BACKUP_DIR"/neo4j-*.dump.xz 2>/dev/null
}

if [ "$LIST" = "1" ]; then
  if [ ! -d "$BACKUP_DIR" ] || [ -z "$(list_backups)" ]; then
    echo "No backups in $BACKUP_DIR"
    exit 0
  fi
  echo "Backups in $BACKUP_DIR (newest first):"
  while IFS= read -r f; do
    printf '  %-42s %s\n' "$(basename "$f")" "$(human_size "$(file_size "$f")")"
  done < <(list_backups)
  exit 0
fi

load_config
require_local_mode
require_docker

if [ "$COMPRESS" = "1" ] && ! command -v xz >/dev/null 2>&1; then
  die "--xz given but xz is not installed (or: drop --xz; it only saves ~1% anyway)"
fi

if [ -z "$OUT" ]; then
  mkdir -p "$BACKUP_DIR" || die "cannot create $BACKUP_DIR"
  OUT="$BACKUP_DIR/neo4j-$(date +%Y%m%d-%H%M%S).dump"
  [ "$COMPRESS" = "1" ] && OUT="$OUT.xz"
fi
[ -e "$OUT" ] && die "refusing to overwrite existing file: $OUT"
mkdir -p "$(dirname "$OUT")" || die "cannot create $(dirname "$OUT")"

IMAGE="$(container_image)"
[ -n "$IMAGE" ] || die "could not determine the image for $CONTAINER"

stop_container_with_restart_trap

echo "Dumping database '$DATABASE'..."
# A sibling container borrows the stopped container's volumes, so nothing has
# to be bind-mounted and the archive never lands inside the container. stdout
# carries the archive, so neo4j-admin's own diagnostics have to be caught
# separately rather than discarded — they are the only clue when a dump fails.
ERRLOG="$(mktemp)"
if [ "$COMPRESS" = "1" ]; then
  docker run --rm --volumes-from "$CONTAINER" "$IMAGE" \
    neo4j-admin database dump "$DATABASE" --to-stdout 2>"$ERRLOG" | xz -T0 -c > "$OUT"
else
  docker run --rm --volumes-from "$CONTAINER" "$IMAGE" \
    neo4j-admin database dump "$DATABASE" --to-stdout 2>"$ERRLOG" > "$OUT"
fi
status="${PIPESTATUS[0]}"
if [ "$status" -ne 0 ]; then
  rm -f "$OUT"
  cat "$ERRLOG" >&2
  rm -f "$ERRLOG"
  die "neo4j-admin dump failed (exit $status); no backup written"
fi
rm -f "$ERRLOG"

SIZE="$(file_size "$OUT")"
[ "${SIZE:-0}" -gt 0 ] || { rm -f "$OUT"; die "dump produced an empty file; no backup written"; }

# Checksum sidecar. neo4j-admin's own `load --info` only parses the archive
# header, so it reports a truncated dump as perfectly valid (verified: a 5KB
# head of a 877KB dump still printed the full file/byte counts). The sidecar is
# what actually lets restore.sh detect a partial or corrupted archive before it
# overwrites the graph. Stored bare-filename so the pair stays relocatable.
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT")" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
else
  echo "note: no sha256sum/shasum available, so no checksum sidecar was written;" >&2
  echo "      restore.sh will not be able to detect a truncated archive." >&2
fi

restart_container
trap - EXIT INT TERM
wait_for_health || die "backup written to $OUT, but the container is unhealthy"

echo
echo "Backup: $OUT"
echo "Size:   $(human_size "$SIZE")"

if [ -n "$KEEP" ]; then
  mapfile -t all < <(list_backups)
  if [ "${#all[@]}" -gt "$KEEP" ]; then
    echo
    echo "Pruning to the $KEEP newest backups:"
    for f in "${all[@]:$KEEP}"; do
      echo "  removing $(basename "$f")"
      rm -f "$f" "$f.sha256"
    done
  fi
fi
