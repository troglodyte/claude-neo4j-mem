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
  note telling Claude which memory tools are available. It also prints a short
  visible banner in the terminal (e.g. `🧠 Neo4j memory: loaded 12
  observation(s) across 5 entities for <project>.`) — or, if the plugin isn't
  configured or Neo4j isn't reachable yet, a banner pointing you at
  `scripts/setup-local.sh` / `README.md` instead of failing silently.
- **MCP server** (`neo4j-memory`) exposes tools Claude can call any time during
  a session: `memory_search`, `memory_get_entity`, `memory_recent`,
  `memory_add_observations`, `memory_create_relation`,
  `memory_delete_observations`, `memory_delete_entity`, `memory_timeline`,
  `memory_status`. The write tools (`memory_add_observations`,
  `memory_create_relation`, `memory_delete_observations`,
  `memory_delete_entity`) return a `confirmation` string that Claude relays as
  a short line (e.g. "🧠 remembered 2 observation(s) on ...") so mid-session
  writes aren't silent. Turn this off with `npm run memory -- mute` (persists
  in `~/.claude-neo4j/config.json`) or `CLAUDE_NEO4J_QUIET=1` (session-only);
  `npm run memory -- unmute` turns it back on.
- **`PreCompact`/`SessionEnd` hooks** read the new part of the transcript since
  the last capture and shell out to a locked-down, one-shot headless
  `claude -p` call (Haiku, no tools, no MCP servers, no settings/CLAUDE.md
  inheritance, structured output via `--json-schema`) to extract durable facts
  as entities/observations/relations, then write them into Neo4j automatically
  — a backstop for anything Claude didn't explicitly save with
  `memory_add_observations`. Because this runs through the `claude` CLI itself
  rather than the Anthropic SDK, it rides on your existing logged-in session
  instead of needing a separate `ANTHROPIC_API_KEY`. Set
  `CLAUDE_NEO4J_DISABLE_CAPTURE=1` to turn it off; everything else keeps
  working either way.
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

**Quick start (local Docker):** if you have Docker installed, `npm install &&
scripts/setup-local.sh` does everything below for you — generates
`docker/.env` with a random password if missing, starts the container, waits
for it to be healthy, and configures the plugin against it. Safe to re-run any
time. If you don't have Docker (or would rather not use it), skip to the
manual steps below and use the remote/Aura path instead.

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

**`docker/.env` vs `~/.claude-neo4j/config.json` — two separate files, synced
once at setup time, not linked at runtime:**

- `docker/.env` only feeds Docker. `docker compose` auto-loads a file named
  `.env` sitting next to the `docker-compose.yml` it's running (hence `cd
  docker && docker compose up -d`) and interpolates `NEO4J_USERNAME` /
  `NEO4J_PASSWORD` / `NEO4J_HTTP_PORT` / `NEO4J_BOLT_PORT` from it into the
  container's `NEO4J_AUTH` env var and port mappings.
- `~/.claude-neo4j/config.json` is the file Claude actually reads (via
  `src/lib/config.js`) to connect from hooks/MCP. `npm run configure` /
  `scripts/setup-local.sh` populate it by copying the *same* values out of
  `docker/.env` — that copy only happens once, at setup time.
- If you change the password in `docker/.env` later, Claude won't pick it up
  automatically — re-run `npm run configure` (or `scripts/setup-local.sh`) so
  `~/.claude-neo4j/config.json` gets the new value too.

### 4. (Optional) disable automatic capture

Automatic capture is on by default: `PreCompact`/`SessionEnd` shell out to a
headless `claude -p` call to extract anything Claude didn't explicitly save
via `memory_add_observations`. It uses the `claude` CLI already on your PATH
(your existing logged-in session — no separate API key needed) and Claude
Haiku by default; override the model with `CLAUDE_NEO4J_CAPTURE_MODEL` or the
CLI it shells out to with `CLAUDE_NEO4J_CAPTURE_CLI`. To turn it off:

```bash
export CLAUDE_NEO4J_DISABLE_CAPTURE=1
```

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
- Ask for a "timeline report" / "journey into this project" — uses the
  `timeline-report` skill / `memory_timeline` tool to narrate the project's
  history from the graph.
- Tell Claude to forget something — it can call `memory_delete_entity` /
  `memory_delete_observations`.

### Outside a Claude session

- `npm run memory -- status` (or any subcommand: `search`, `recent`, `get`,
  `add`, `relate`, `timeline`, `forget-obs`, `forget`, `mute`, `unmute`) —
  query/edit the graph from a terminal. Run with no args for full usage.
- `scripts/check-health.sh` — verifies Docker container health, plugin config,
  Neo4j auth, and the MCP handshake in one shot.
- A statusline showing `<model> · 🧠 <entities>e/<observations>o` can be wired
  via `scripts/statusline.mjs` (see `.claude/settings.local.json`).
- The full graph is also browsable directly in Neo4j's own UI at
  `http://localhost:7474` (local mode) — no custom viewer needed.

## Project layout

```
.claude-plugin/plugin.json   plugin manifest
hooks/hooks.json             SessionStart / PreCompact / SessionEnd wiring
.mcp.json                    bundled MCP server registration
skills/                      memory-search, memory-status, timeline-report
src/lib/                     config resolution, Neo4j client, schema, graph ops, project detection
src/mcp/server.js            MCP tools
src/hooks/                   session-start.js, capture.js
docker/                      docker-compose.yml for local Neo4j
scripts/configure.mjs        interactive setup wizard
scripts/setup-local.sh       one-shot: start container + configure (local mode)
scripts/claude-with-memory.sh  launch `claude --plugin-dir` without retyping the path
scripts/check-health.sh      end-to-end health check (container/config/auth/MCP handshake)
scripts/memory-cli.mjs       terminal CLI for the memory graph (search/add/timeline/etc.)
scripts/statusline.mjs       Claude Code statusLine command showing live memory counts
CLAUDE.md                    current build status / continuation notes for this repo
```

## Notes

- `docker/.env` and `~/.claude-neo4j/config.json` hold credentials — never
  commit either (the former is gitignored; the latter lives outside the repo).
- Switching from local to remote (or back) is just `npm run configure` again,
  or setting `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD` env vars — no code
  changes.
