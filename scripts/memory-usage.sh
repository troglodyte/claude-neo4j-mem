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

# A fragmented map is one that has stopped being a table of contents, usually
# because of near-synonyms ("capture" and "auto-capture") the lexical deduper
# can't merge. Counting distinct tags measures project size instead: a real
# 818-observation product carried 15 subsystems, none holding fewer than 9
# observations, and tripped a `tags > 12` rule that a half-empty project with
# three one-observation slivers slipped under.
#
# So this measures what the map costs to read, the same way every path in
# src/lib/budget.js is bounded by characters rather than by rows - the map is
# injected into every session, and a tag's name length matters as much as the
# tag count. Cells are sized as src/lib/injection.js renders them:
# "<tag> (<n>, MM-DD)" joined by " . ", i.e. tag + digits + 10, plus 3 per gap.
# Live maps measure 170-336 chars, so 800 is roughly 30 average tags: past that
# the map is both expensive per session and too long to skim. The smallest tags
# are named because they are the merge candidates.
TAGS="$(run_query "
MATCH (o:Observation)-[:ABOUT]->(e:Entity) WHERE o.subsystem IS NOT NULL
WITH e.project AS project, o.subsystem AS tag, count(o) AS n
ORDER BY n ASC
WITH project, collect(tag + ' (' + toString(n) + ')') AS smallest,
     collect(size(tag) + size(toString(n)) + 10) AS lens, count(tag) AS tags
WITH project, tags, smallest,
     reduce(total = 0, l IN lens | total + l) + 3 * (tags - 1) AS chars
WHERE chars > 800
RETURN '  ' + coalesce(project,'no project') + ': ' + toString(chars) + ' chars across ' +
       toString(tags) + ' subsystems; smallest are ' +
       reduce(s = '', c IN smallest[0..3] | CASE WHEN s = '' THEN c ELSE s + ', ' + c END) AS row
ORDER BY chars DESC;")"
if [ -n "$TAGS" ]; then
  WARNINGS="${WARNINGS}Projects whose subsystem map is costly to inject every session (merge near-synonyms):
${TAGS}

"
fi

# The opposite failure to fragmentation, and invisible to the check above: one
# tag that isn't a subsystem at all. A mandatory `subsystem` field in the
# backfill's schema once left the model no way to say "cross-cutting", so its
# prompt named an escape hatch and 20% of every project's history ended up
# behind it - 85% of that not cross-cutting, merely unclassified. Cross-cutting
# facts are stored with no subsystem now (they are surfaced by the pinned-facts
# block instead), so any of these names in the graph is either pre-fix data or
# a hand-written Cypher update. src/lib/subsystem.js holds the same list.
JUNK="$(run_query "
MATCH (o:Observation)-[:ABOUT]->(e:Entity)
WHERE o.subsystem IN ['general','misc','miscellaneous','other','others','uncategorized',
                      'uncategorised','unclassified','various','untagged','none','n-a']
WITH e.project AS project, o.subsystem AS tag, count(o) AS n
RETURN '  ' + coalesce(project,'no project') + ': ' + tag + ' holds ' + toString(n) + ' observation(s)' AS row
ORDER BY n DESC;")"
if [ -n "$JUNK" ]; then
  WARNINGS="${WARNINGS}Catch-all subsystem tags (reclassify: npm run backfill-subsystems -- --retag TAG):
${JUNK}

"
fi

# Concentration, the mirror image of the fragmentation check above - and equally
# invisible to it. A project whose tags have collapsed into one bucket has a
# *small* map: five tags render well under 800 chars while telling the reader
# almost nothing. The reported case was 133 of 202 tagged observations under
# "infrastructure" in an OAuth authorization server whose `oauth` tag held 8.
#
# The catch-all check can't see this either: it matches tag names that admit to
# being junk drawers, and "infrastructure" is a plausible domain word. It then
# compounds, because both extraction prompts seed their vocabulary from
# listSubsystems with "prefer one of these" - the biggest tag is offered first
# to every later batch. A junk drawer named after the domain is invisible to
# every rule that looks at names.
#
# Calibrated against the nine projects in this database, which is enough to see
# the band but not enough to call it universal: projects reading as healthy span
# 16-36%, the one flagged here sits at 44%, and the reported case was 66%. So 40
# clears every healthy project by only four points - re-measure before trusting
# it on a graph whose projects are shaped differently, and expect the first
# false positive to be a project legitimately dominated by one subsystem.
#
# The 40-observation floor is load-bearing, not a rounding guard: without it the
# three smallest projects here (12-22 observations) trip at 33-55% purely on
# sample size - five observations in one bucket out of nine tagged.
DOMINANT="$(run_query "
MATCH (o:Observation)-[:ABOUT]->(e:Entity) WHERE o.subsystem IS NOT NULL
WITH e.project AS project, o.subsystem AS tag, count(o) AS n
ORDER BY n DESC
WITH project, collect({tag: tag, n: n})[0] AS top, sum(n) AS tagged
WITH project, top, tagged, toInteger(100.0 * top.n / tagged) AS pct
WHERE tagged >= 40 AND pct > 40
RETURN '  ' + coalesce(project,'no project') + ': ' + top.tag + ' holds ' + toString(top.n) +
       ' of ' + toString(tagged) + ' tagged observation(s) (' + toString(pct) + '%)' AS row
ORDER BY pct DESC;")"
if [ -n "$DOMINANT" ]; then
  WARNINGS="${WARNINGS}Subsystem maps that have collapsed into one bucket (split it: npm run backfill-subsystems -- --retag TAG):
${DOMINANT}

"
fi

# Untagged history, which the map reports as an honest count but no rule acts on.
# Pinned-type entities are excluded deliberately: a user preference or a
# project-wide constraint has no subsystem by design and reaches the model
# through the pinned-facts block, so counting those as unclassified would
# indict correct behaviour. The predicate matches src/lib/graph.js PINNED_MATCH.
# The exclusion is worth its cost: this project holds 62 untagged observations,
# 15 of them pinned, so the honest figure is 47 (16%) rather than 62 (21%).
# Same calibration caveat as above, and thinner here - healthy projects measure
# 0-25%, the flagged one 34%, the reported case 41%. 30% leaves only five points
# of daylight above the healthiest, so this is the likelier of the two to cry
# wolf on a project that simply hasn't been backfilled yet.
UNCLASSIFIED="$(run_query "
MATCH (o:Observation)-[:ABOUT]->(e:Entity)
WITH e.project AS project, o,
     (any(t IN ['user','preference','constraint','convention']
          WHERE toLower(coalesce(e.type,'')) STARTS WITH t) OR e.name = 'user') AS pinned
WITH project, count(o) AS total,
     sum(CASE WHEN o.subsystem IS NULL AND NOT pinned THEN 1 ELSE 0 END) AS unclassified
WITH project, total, unclassified, toInteger(100.0 * unclassified / total) AS pct
WHERE total >= 40 AND pct > 30
RETURN '  ' + coalesce(project,'no project') + ': ' + toString(unclassified) + ' of ' +
       toString(total) + ' observation(s) carry no subsystem (' + toString(pct) +
       '%), excluding cross-cutting facts where null is correct' AS row
ORDER BY pct DESC;")"
if [ -n "$UNCLASSIFIED" ]; then
  WARNINGS="${WARNINGS}Projects with a large unclassified history (tag it: npm run backfill-subsystems -- --dry-run):
${UNCLASSIFIED}

"
fi

# A tag named after the project itself. Every observation in a project is about
# that project, so such a tag partitions nothing by construction - it is a junk
# drawer whichever share it holds, which is what the two checks above cannot
# see. Measured live: context-watch-plugin's biggest tag was "context-watch",
# and once its untagged history was backfilled the share check fell to 36% and
# went quiet while the tag went on meaning exactly as little as before.
#
# Matched on tokens rather than as a substring, because a substring test fires
# on accidents: 'malleus' contains "alle", so a three-letter tag can match a
# project it has nothing to do with. Tokens are compared against the last path
# segment only, so 'github' and a user name can never be a tag's whole meaning.
# This catches one species of vacuous tag precisely rather than vacuity in
# general - a tag can partition nothing without borrowing the project's name.
SELFNAMED="$(run_query "
MATCH (o:Observation)-[:ABOUT]->(e:Entity)
WHERE o.subsystem IS NOT NULL AND e.project IS NOT NULL
WITH e.project AS project, o.subsystem AS tag, count(o) AS n
WITH project, tag, n,
     split(replace(last(split(project,'/')),'_','-'),'-') AS baseTokens,
     split(tag,'-') AS tagTokens
WHERE all(t IN tagTokens WHERE t IN baseTokens)
RETURN '  ' + project + ': ' + tag + ' (' + toString(n) + ' observation(s)) repeats the project name' AS row
ORDER BY n DESC;")"
if [ -n "$SELFNAMED" ]; then
  WARNINGS="${WARNINGS}Subsystem tags named after their own project, which separate nothing (npm run backfill-subsystems -- --retag TAG):
${SELFNAMED}

"
fi

if [ -n "$WARNINGS" ]; then
  echo
  printf '%s' "$WARNINGS"
  echo "Clean up with: npm run memory -- prune --dry-run   (or 'forget <entity>' to drop one)"
fi
