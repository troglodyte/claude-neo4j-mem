#!/usr/bin/env bash
# Runs arbitrary Cypher against the memory graph, without needing cypher-shell
# installed on the host: in local mode it falls back to the copy that ships
# inside the Neo4j container. Credentials come from env vars, then
# ~/.claude-neo4j/config.json, then docker/.env.
#
# Usage:
#   scripts/cypher.sh "MATCH (e:Entity) RETURN count(e) AS entities;"
#   echo "MATCH ... RETURN ...;" | scripts/cypher.sh
#   scripts/cypher.sh --format verbose "MATCH ... RETURN ...;"
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="claude-neo4j-memory"
CONFIG_FILE="$HOME/.claude-neo4j/config.json"
FORMAT="plain"

while [ $# -gt 0 ]; do
  case "$1" in
    --format) FORMAT="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) break ;;
  esac
done

# Query from argv, or stdin when nothing was passed.
if [ $# -gt 0 ]; then
  QUERY="$*"
elif [ ! -t 0 ]; then
  QUERY="$(cat)"
else
  echo "cypher.sh: no query given (pass one as an argument or on stdin)" >&2
  exit 2
fi

# --- credential resolution -------------------------------------------------
URI="${NEO4J_URI:-}"; USERNAME="${NEO4J_USERNAME:-}"; PASSWORD="${NEO4J_PASSWORD:-}"
DATABASE="${NEO4J_DATABASE:-}"; MODE="${NEO4J_MODE:-}"

if [ -r "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
  eval "$(jq -r '
    @sh "CFG_URI=\(.uri // "")",
    @sh "CFG_USERNAME=\(.username // "")",
    @sh "CFG_PASSWORD=\(.password // "")",
    @sh "CFG_DATABASE=\(.database // "")",
    @sh "CFG_MODE=\(.mode // "")"
  ' "$CONFIG_FILE" 2>/dev/null)"
  URI="${URI:-${CFG_URI:-}}"; USERNAME="${USERNAME:-${CFG_USERNAME:-}}"
  PASSWORD="${PASSWORD:-${CFG_PASSWORD:-}}"; DATABASE="${DATABASE:-${CFG_DATABASE:-}}"
  MODE="${MODE:-${CFG_MODE:-}}"
fi

# docker/.env is the last resort — it only carries credentials, not a URI.
if [ -z "$PASSWORD" ] && [ -r "$REPO_ROOT/docker/.env" ]; then
  set -a; . "$REPO_ROOT/docker/.env"; set +a
  USERNAME="${USERNAME:-${NEO4J_USERNAME:-}}"
  PASSWORD="${PASSWORD:-${NEO4J_PASSWORD:-}}"
fi

URI="${URI:-bolt://localhost:7687}"
USERNAME="${USERNAME:-neo4j}"
DATABASE="${DATABASE:-neo4j}"
if [ -z "$MODE" ]; then
  case "$URI" in
    bolt://localhost*|bolt://127.0.0.1*) MODE="local" ;;
    *) MODE="remote" ;;
  esac
fi

if [ -z "$PASSWORD" ]; then
  cat >&2 <<EOF
cypher.sh: no Neo4j password found.
  Looked in: \$NEO4J_PASSWORD, $CONFIG_FILE, $REPO_ROOT/docker/.env
  Fix: run 'npm run configure' in the plugin directory (or 'scripts/setup-local.sh' for local mode).
EOF
  exit 1
fi

# --- pick a cypher-shell ---------------------------------------------------
# Prefer the host binary; otherwise use the one inside the container, which
# means local-mode users never have to install anything.
if command -v cypher-shell >/dev/null 2>&1; then
  exec cypher-shell -a "$URI" -u "$USERNAME" -p "$PASSWORD" -d "$DATABASE" \
    --format "$FORMAT" "$QUERY"
fi

if [ "$MODE" = "local" ] && docker inspect "$CONTAINER" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
    echo "cypher.sh: container $CONTAINER exists but is not running (run: cd docker && docker compose up -d)" >&2
    exit 1
  fi
  # Inside the container Neo4j is always at the default bolt port, regardless
  # of whatever host port mapping NEO4J_BOLT_PORT set up.
  exec docker exec -i "$CONTAINER" cypher-shell \
    -a "bolt://localhost:7687" -u "$USERNAME" -p "$PASSWORD" -d "$DATABASE" \
    --format "$FORMAT" "$QUERY"
fi

# Nothing available: remote mode (or no container) and no host cypher-shell.
cat >&2 <<EOF
cypher.sh: cypher-shell is not installed on this host, and no local Neo4j
container is available to borrow it from (mode: $MODE, uri: $URI).

You do not need cypher-shell for everyday use — these work without it:
  npm run memory -- projects     list projects, counts, last activity
  npm run memory -- status       connection info + counts
  npm run memory -- search <q>   full-text search
  scripts/memory-usage.sh        (needs cypher-shell; the CLI above does not)

To install cypher-shell:
  Debian/Ubuntu  sudo apt-get install cypher-shell
  macOS          brew install cypher-shell
  Any platform   https://neo4j.com/deployment-center/#cypher-shell
                 (unzip, then put bin/cypher-shell on your PATH)

For local mode, starting the container also gives you one for free:
  cd docker && docker compose up -d
EOF
exit 1
