#!/usr/bin/env bash
# Prints a content fingerprint of the graph inside a running container, so the
# same graph can be compared across engines. Counts alone can match while the
# content differs, so every count is paired with a hash of the sorted content.
# The counts= line is five comma-separated numbers, in order: Entity nodes,
# Observation nodes, RELATES_TO edges, Session nodes, PRODUCED edges. Session/
# PRODUCED get counts only (no content hash) - they carry no free-text payload
# of their own, so a count is sufficient evidence a migration didn't drop them.
# Usage: scripts/fingerprint.sh <engine> <container>
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || SCRIPT_DIR=""
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || REPO_ROOT=""
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
  echo "fingerprint.sh: resolved repo root '$REPO_ROOT' is not this repo" >&2
  exit 1
}

ENGINE="${1:?usage: fingerprint.sh <engine> <container>}"
CONTAINER="${2:?usage: fingerprint.sh <engine> <container>}"

set -a; . "$REPO_ROOT/docker/.env"; set +a
: "${NEO4J_USERNAME:=neo4j}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD is not set in docker/.env}"

# Always the in-container port: host mappings differ between the two sides.
q() {
  "$ENGINE" exec -i "$CONTAINER" cypher-shell \
    -a bolt://localhost:7687 -u "$NEO4J_USERNAME" -p "$NEO4J_PASSWORD" \
    -d neo4j --format plain "$1"
}

h() { sha256sum | cut -d' ' -f1; }

# Aliased to a single word (`AS counts`) rather than left as the bare
# expression: with no alias, cypher-shell's plain-format header is the
# expression text verbatim, and once that expression itself spans more than
# one physical line (as it does now, five fields in), the header does too -
# `tail -n +2` only drops the header's first line, and its leftover second
# line survives into what `tr` then flattens onto the real data row.
counts="$(q '
MATCH (e:Entity) WITH count(e) AS entities
MATCH (o:Observation) WITH entities, count(o) AS observations
RETURN entities + "," + observations + "," + COUNT { ()-[:RELATES_TO]->() } + "," +
       COUNT { (:Session) } + "," + COUNT { ()-[:PRODUCED]->() } AS counts
' | tail -n +2 | tr -d '"[:space:]')"

# Free-text fields (o.text, and defensively every other concatenated string
# field) can themselves contain the tab we join columns with or a newline
# that would split one logical row across two output lines and break the
# whole line-oriented hashing scheme. Escape both to a literal two-character
# `\t` / `\n` before concatenating, so the row stays exactly one line and the
# `\t` join separator stays unambiguous.
entities="$(q '
MATCH (e:Entity)
RETURN replace(replace(coalesce(e.name, ""), "\t", "\\t"), "\n", "\\n") + "\t" +
       replace(replace(coalesce(e.project, ""), "\t", "\\t"), "\n", "\\n") + "\t" +
       replace(replace(coalesce(e.type, ""), "\t", "\\t"), "\n", "\\n") AS row ORDER BY row
' | tail -n +2 | h)"

# OPTIONAL MATCH on ABOUT (not a plain MATCH) so an observation whose ABOUT
# edge was dropped or reattached to the wrong entity still appears in the
# hash - with empty entity fields - rather than silently vanishing from the
# row set, which would look like a clean difference while hiding which
# observation was affected. o.id alone (randomUUID, not a content hash) would
# not catch corrupted/truncated/mis-encoded text, so text and subsystem are
# included too.
observations="$(q '
MATCH (o:Observation)
OPTIONAL MATCH (o)-[:ABOUT]->(e:Entity)
RETURN o.id + "\t" +
       replace(replace(coalesce(e.name, ""), "\t", "\\t"), "\n", "\\n") + "\t" +
       replace(replace(coalesce(e.project, ""), "\t", "\\t"), "\n", "\\n") + "\t" +
       replace(replace(coalesce(o.text, ""), "\t", "\\t"), "\n", "\\n") + "\t" +
       replace(replace(coalesce(o.subsystem, ""), "\t", "\\t"), "\n", "\\n") AS row ORDER BY row
' | tail -n +2 | h)"

relations="$(q '
MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
RETURN replace(replace(coalesce(a.name, ""), "\t", "\\t"), "\n", "\\n") + "\t" +
       replace(replace(coalesce(a.project, ""), "\t", "\\t"), "\n", "\\n") + "\t" +
       replace(replace(coalesce(r.type, ""), "\t", "\\t"), "\n", "\\n") + "\t" +
       replace(replace(coalesce(b.name, ""), "\t", "\\t"), "\n", "\\n") + "\t" +
       replace(replace(coalesce(b.project, ""), "\t", "\\t"), "\n", "\\n") AS row ORDER BY row
' | tail -n +2 | h)"

# The composite (name, project) constraint and the full-text index memory_search
# runs on are the two pieces a bad import would silently drop.
#
# Each query is captured into its own variable rather than combined inside a
# `{ a; b; }` group piped to `h`: a group's exit status is only the LAST
# command's, so a failure in the first query would be swallowed and the hash
# computed from the second query alone - with exit 0. A plain `var=$(q ...)`
# assignment's exit status is the substitution's own, so `set -e` aborts the
# script (and prints nothing) if either query fails.
constraints="$(q 'SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name')"
indexes="$(q 'SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name')"
schema="$(printf '%s\n%s\n' "$constraints" "$indexes" | h)"

printf 'counts=%s\nentities=%s\nobservations=%s\nrelations=%s\nschema=%s\n' \
  "$counts" "$entities" "$observations" "$relations" "$schema"
