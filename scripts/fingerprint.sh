#!/usr/bin/env bash
# Prints a content fingerprint of the graph inside a running container, so the
# same graph can be compared across engines. Counts alone can match while the
# content differs, so every count is paired with a hash of the sorted content.
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

counts="$(q '
MATCH (e:Entity) WITH count(e) AS entities
MATCH (o:Observation) WITH entities, count(o) AS observations
RETURN entities + "," + observations + "," + COUNT { ()-[:RELATES_TO]->() }
' | tail -n +2 | tr -d '"[:space:]')"

entities="$(q '
MATCH (e:Entity)
RETURN e.name + "\t" + coalesce(e.project, "") AS row ORDER BY row
' | tail -n +2 | h)"

observations="$(q '
MATCH (o:Observation) RETURN o.id AS row ORDER BY row
' | tail -n +2 | h)"

relations="$(q '
MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
RETURN a.name + "\t" + coalesce(a.project, "") + "\t" + r.type + "\t" +
       b.name + "\t" + coalesce(b.project, "") AS row ORDER BY row
' | tail -n +2 | h)"

# The composite (name, project) constraint and the full-text index memory_search
# runs on are the two pieces a bad import would silently drop.
schema="$( { q 'SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name'
             q 'SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name'; } | h)"

printf 'counts=%s\nentities=%s\nobservations=%s\nrelations=%s\nschema=%s\n' \
  "$counts" "$entities" "$observations" "$relations" "$schema"
