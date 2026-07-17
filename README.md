# neo4j-memory

A Claude Code plugin that gives Claude persistent, graph-based memory — like
[claude-mem](https://github.com/thedotmack/claude-mem), but backed by
[Neo4j](https://neo4j.com/) instead of a local vector store. Facts, decisions,
and preferences are stored as an entity/observation/relation graph, scoped per
project (by git remote), and are recallable across sessions and machines.

Works against either:

- **Local**: a Neo4j container run via Docker Compose (default).
- **Remote / web-based**: any hosted Neo4j instance reachable over `bolt`/`neo4j+s`
  — e.g. [Neo4j Aura](https://neo4j.com/product/auradb/), or a self-hosted server
  exposed on the network. Only the connection URI/credentials change; everything
  else behaves identically.

## How it works

- **`SessionStart` hook** queries the graph for the current project's most
  relevant recent entities/observations and injects them as context, plus a
  note telling Claude which memory tools are available.
- **MCP server** (`neo4j-memory`) exposes tools Claude can call any time during
  a session: `memory_search`, `memory_get_entity`, `memory_recent`,
  `memory_add_observations`, `memory_create_relation`,
  `memory_delete_observations`, `memory_delete_entity`, `memory_status`.
- **`PreCompact`/`SessionEnd` hooks** read the new part of the transcript since
  the last capture, ask a small model (Claude Haiku, via the Anthropic API) to
  extract durable facts as structured entities/observations/relations, and
  write them into Neo4j automatically — a backstop for anything Claude didn't
  explicitly save with `memory_add_observations`. This step is **optional**:
  if `ANTHROPIC_API_KEY` isn't set, it's silently skipped and everything else
  keeps working.
- Recall uses Neo4j's built-in full-text indexes and relationship traversal —
  no embedding API, no vector store, no extra cost for search itself.

All hook scripts fail open: if Neo4j is unreachable or unconfigured, they log
to stderr and exit 0 without blocking your session.

### Graph model

```
(:Entity {name, type, project})
(:Observation {id, text, createdAt, sessionId})-[:ABOUT]->(:Entity)
(:Entity)-[:RELATES_TO {type}]->(:Entity)
(:Session {id, cwd, project})-[:PRODUCED]->(:Observation)
```

`project` is derived from `git remote get-url origin` (falling back to the cwd
basename), so memory from unrelated repos doesn't bleed into each other; a
`project IS NULL` entity is treated as global and shows up everywhere.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start Neo4j

**Local (Docker):**

```bash
cd docker
cp .env.example .env
# edit .env and set a real NEO4J_PASSWORD
docker compose up -d
```

**Remote / web-based (e.g. Aura):** create a free or paid instance at
[console.neo4j.io](https://console.neo4j.io), and note its `neo4j+s://...`
connection URI, username, and password. No local container needed.

### 3. Configure the plugin

Run this yourself in a terminal (not via Claude — it collects a password):

```bash
npm run configure
```

It prompts for local vs. remote, connection details, tests connectivity, and
saves to `~/.claude-neo4j/config.json` (mode 0600). You can skip the prompts
with flags, e.g.:

```bash
node scripts/configure.mjs --mode remote \
  --uri neo4j+s://xxxxx.databases.neo4j.io \
  --username neo4j --password '...' --database neo4j
```

Config resolution order at runtime: env vars (`NEO4J_URI`, `NEO4J_USERNAME`,
`NEO4J_PASSWORD`, `NEO4J_DATABASE`) > `~/.claude-neo4j/config.json` > local
Docker defaults. Env vars are handy for switching a single session to a
different database without touching the saved config.

### 4. (Optional) enable automatic capture

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Without this, memory only grows when Claude explicitly calls
`memory_add_observations` (which the injected context encourages it to do).
With it, `PreCompact`/`SessionEnd` also extract anything Claude didn't
explicitly save. Uses Claude Haiku by default; override with
`CLAUDE_NEO4J_CAPTURE_MODEL`.

### 5. Load the plugin

```bash
scripts/claude-with-memory.sh
```

This wraps `claude --plugin-dir /path/to/claude-neo4j` so you don't have to
remember the path. Any extra args pass through, e.g.
`scripts/claude-with-memory.sh -p "..."`. Run `/reload-plugins` inside a
session after making changes to the plugin.

### Local setup, one command

`scripts/setup-local.sh` does steps 2-3 for local mode in one shot: starts the
Docker container if it isn't running, waits for it to be healthy, and runs
the configure wizard against it using the credentials in `docker/.env`.

## Usage

- Ask "what do you remember about X" — Claude will use the `memory-search`
  skill / `memory_search` tool.
- Ask "is memory working?" / "what's my memory status" — uses `memory-status`
  / `memory_status`.
- Tell Claude to forget something — it can call `memory_delete_entity` /
  `memory_delete_observations`.

## Project layout

```
.claude-plugin/plugin.json   plugin manifest
hooks/hooks.json             SessionStart / PreCompact / SessionEnd wiring
.mcp.json                    bundled MCP server registration
skills/                      memory-search, memory-status
src/lib/                     config resolution, Neo4j client, schema, graph ops, project detection
src/mcp/server.js            MCP tools
src/hooks/                   session-start.js, capture.js
docker/                      docker-compose.yml for local Neo4j
scripts/configure.mjs        interactive setup wizard
scripts/setup-local.sh       one-shot: start container + configure (local mode)
scripts/claude-with-memory.sh  launch `claude --plugin-dir` without retyping the path
CLAUDE.md                    current build status / continuation notes for this repo
```

## Notes

- `docker/.env` and `~/.claude-neo4j/config.json` hold credentials — never
  commit either (the former is gitignored; the latter lives outside the repo).
- Switching from local to remote (or back) is just `npm run configure` again,
  or setting `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD` env vars — no code
  changes.
