#!/usr/bin/env bash
# Usage report for the Neo4j memory graph: every project registered in the db
# with its entity/observation counts and activity window, plus totals and a
# few hygiene warnings. Reads the whole database, not just the current project.
#
# Usage:
#   scripts/memory-usage.sh            full report
#   scripts/memory-usage.sh --quiet    projects table only, no warnings
set -uo pipefail

# Resolved in two steps and checked: as a single `cd "$(dirname X)/.."` this
# degrades to "/" when the substitution yields nothing, and set -e can't see it.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
  echo "memory-usage.sh: resolved repo root '$REPO_ROOT' is not this repo" >&2
  exit 1
}
CYPHER="$REPO_ROOT/scripts/cypher.sh"
QUIET=0

case "${1:-}" in
  --quiet) QUIET=1 ;;
  --help|-h) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "memory-usage.sh: unknown option '$1'" >&2; exit 2 ;;
esac

# Rows come back as one pipe-joined string per record so we never have to
# unpick cypher-shell's CSV quoting. `tail -n +2` drops the header line.
run_query() {
  local out status
  out="$("$CYPHER" "$1" 2>&1)"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "memory-usage.sh: query failed:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out" | tail -n +2 | sed 's/^"//; s/"$//'
}

PROJECTS="$(run_query "
MATCH (e:Entity) WHERE e.project IS NOT NULL
OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
WITH e.project AS project, count(DISTINCT e) AS entities, count(o) AS observations,
     min(o.createdAt) AS firstAt, max(o.createdAt) AS lastAt,
     count(CASE WHEN o.createdAt >= datetime() - duration({days:7}) THEN 1 END) AS last7d
RETURN project + '|' + toString(entities) + '|' + toString(observations) + '|' +
       toString(last7d) + '|' + coalesce(substring(toString(firstAt),0,10),'-') + '|' +
       coalesce(substring(toString(lastAt),0,16),'-') AS row
ORDER BY lastAt DESC;")"

if [ -z "$PROJECTS" ]; then
  echo "No projects tracked in the memory graph yet."
  exit 0
fi
if printf '%s' "$PROJECTS" | grep -q "^cypher.sh:"; then
  printf '%s\n' "$PROJECTS" >&2
  exit 1
fi

echo "Projects in the memory graph"
echo
printf '%s\n' "$PROJECTS" | awk -F'|' '
  BEGIN { printf "%-42s %8s %8s %8s %-12s %-17s\n", "PROJECT", "ENTITIES", "OBS", "OBS/7D", "FIRST", "LAST ACTIVITY" }
  { printf "%-42s %8s %8s %8s %-12s %-17s\n", $1, $2, $3, $4, $5, $6 }
'

TOTALS="$(run_query "
MATCH (e:Entity)
OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
WITH count(DISTINCT e) AS entities, count(o) AS observations,
     count(DISTINCT e.project) AS projects,
     count(DISTINCT CASE WHEN e.project IS NULL THEN e END) AS unscoped
RETURN 'Totals: ' + toString(projects) + ' project(s), ' + toString(entities) +
       ' entities, ' + toString(observations) + ' observations, ' +
       toString(COUNT { ()-[:RELATES_TO]->() }) + ' relations' +
       CASE WHEN unscoped > 0 THEN ' (' + toString(unscoped) + ' entity/entities have no project)' ELSE '' END AS row;")"
echo
printf '%s\n' "$TOTALS"

[ "$QUIET" -eq 1 ] && exit 0

WARNINGS=""

# Near-duplicate project names: same trailing path segment recorded under two
# different identifiers (e.g. "foo" and "github.com/someone/foo"), which means
# the same repo's memory is split in two and neither session sees the other.
DUPES="$(printf '%s\n' "$PROJECTS" | awk -F'|' '
  { p = $1; n = p; sub(/.*\//, "", n); if (n in seen) seen[n] = seen[n] ", " p; else seen[n] = p; cnt[n]++ }
  END { for (n in cnt) if (cnt[n] > 1) print "  " n ": " seen[n] }
')"
if [ -n "$DUPES" ]; then
  WARNINGS="${WARNINGS}Projects recorded under more than one name (memory is split between them):
${DUPES}

"
fi

# Entities hoarding observations, usually a sign of a bulk import or an
# over-broad entity that should have been split up.
FAT="$(run_query "
MATCH (o:Observation)-[:ABOUT]->(e:Entity)
WITH e, count(o) AS obs WHERE obs >= 100
RETURN '  ' + e.name + ' (' + coalesce(e.project,'no project') + '): ' + toString(obs) + ' observations' AS row
ORDER BY obs DESC LIMIT 10;")"
if [ -n "$FAT" ]; then
  WARNINGS="${WARNINGS}Entities with 100+ observations (consider splitting or pruning):
${FAT}

"
fi

# Entities that carry no observations at all are leftover stubs.
ORPHANS="$(run_query "
MATCH (e:Entity) WHERE NOT (:Observation)-[:ABOUT]->(e)
RETURN '  ' + e.name + ' (' + coalesce(e.project,'no project') + ')' AS row
ORDER BY e.name LIMIT 10;")"
if [ -n "$ORPHANS" ]; then
  WARNINGS="${WARNINGS}Entities with zero observations (empty stubs):
${ORPHANS}

"
fi

if [ -n "$WARNINGS" ]; then
  echo
  printf '%s' "$WARNINGS"
  echo "Clean up with: npm run memory -- prune --dry-run   (or 'forget <entity>' to drop one)"
fi
