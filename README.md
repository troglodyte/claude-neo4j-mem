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

- **`SessionStart` hook** injects a compact, fixed-cost snapshot of the current
  project's memory: the standing facts that always apply (user preferences and
  constraints, quoted verbatim) followed by a one-line-per-subsystem index of
  everything else, so Claude knows what exists and can `memory_search` into it
  rather than being handed a recency dump. It also prints a short visible banner
  in the terminal (e.g. `🧠 Neo4j memory: 223 observation(s) across 6
  subsystem(s) for <project>.`) — or, if the plugin isn't configured or Neo4j
  isn't reachable yet, a banner pointing you at `scripts/setup-local.sh` /
  `README.md` instead of failing silently.
- **MCP server** (`neo4j-memory`) exposes tools Claude can call any time during
  a session: `memory_search`, `memory_get_entity`, `memory_recent`,
  `memory_add_observations`, `memory_create_relation`,
  `memory_delete_observations`, `memory_delete_entity`, `memory_prune`,
  `memory_timeline`, `memory_status`. Every observation carries a `subsystem`
  tag (e.g. `capture`, `search`, `backup`) inferred at write time; `memory_search`,
  `memory_recent`, and `memory_timeline` all accept an optional `subsystem`
  parameter to scope a read to one tag, and `memory_add_observations` accepts
  a call-level `subsystem` to tag the whole batch being written. The write tools (`memory_add_observations`,
  `memory_create_relation`, `memory_delete_observations`,
  `memory_delete_entity`, `memory_prune`) return a `confirmation` string that
  Claude relays as a short line (e.g. "🧠 remembered 2 observation(s) on ...")
  so mid-session writes aren't silent. Turn this off with `npm run memory --
  mute` (persists in `~/.claude-neo4j/config.json`) or `CLAUDE_NEO4J_QUIET=1`
  (session-only); `npm run memory -- unmute` turns it back on.
- **`PreCompact`/`SessionEnd` hooks** read the new part of the transcript since
  the last capture and shell out to a locked-down, one-shot headless
  `claude -p` call (Haiku, no tools, no MCP servers, no settings/CLAUDE.md
  inheritance, structured output via `--json-schema`) to extract durable facts
  as entities/observations/relations, then write them into Neo4j automatically
  — a backstop for anything Claude didn't explicitly save with
  `memory_add_observations`. Because this runs through the `claude` CLI itself
  rather than the Anthropic SDK, it rides on your existing logged-in session
  instead of needing a separate `ANTHROPIC_API_KEY`. The extraction prompt is
  seeded with the current project's existing entity names so it reuses them
  instead of inventing near-duplicates, and a lexical-similarity check
  (`src/lib/dedup.js`) catches any that still drift (typos, `-` vs `:`) before
  a new entity gets created. Set `CLAUDE_NEO4J_DISABLE_CAPTURE=1` to turn it
  off; everything else keeps working either way.
- Because `SessionEnd`'s capture runs detached (see below) and `PreCompact`'s
  confirmation may not survive to be seen, the next `SessionStart` banner
  reports anything auto-capture saved in the background since your last
  session ("Auto-capture also saved N observation(s) ...") so it's never
  silent.
- Recall uses Neo4j's built-in full-text indexes and relationship traversal —
  no embedding API, no vector store, no extra cost for search itself.
  `memory_search` ranking blends full-text score with recency (a 30-day
  half-life-ish decay), so a stale but lexically strong match doesn't always
  outrank something you actually talked about recently.
- **`memory_prune`** / `npm run memory -- prune` deletes observations older
  than a given age (default 180 days), always keeping the most recent few per
  entity regardless of age. Defaults to a dry run everywhere (CLI flag and MCP
  tool) — nothing is deleted until you explicitly ask for it. Nothing prunes
  automatically.

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

Each capture reads up to `CLAUDE_NEO4J_CAPTURE_WINDOW` characters (default
50,000) of new transcript, and covers longer sessions with up to
`CLAUDE_NEO4J_CAPTURE_MAX_CHUNKS` windows (default 3) taken from the end — so a
session past the ceiling loses its oldest content, not its most recent, and
`~/.claude-neo4j/capture.log` records how much was dropped. Raise either to
trade tokens for coverage, or lower them to spend less.

A capture that fails (Neo4j restarting, a timed-out extraction) keeps its input
and is retried at the next session start, up to 3 attempts — transcripts stay on
disk, so a capture that failed days ago still works when it finally runs. The
session-start banner tells you when a retry is happening.

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
  `add`, `relate`, `timeline`, `forget-obs`, `forget`, `prune`, `projects`,
  `mute`, `unmute`) — query/edit the graph from a terminal. Run with no args
  for full usage. `npm run memory -- projects` lists every project tracked
  anywhere in the db (not scoped to the current cwd), with entity/observation
  counts and last activity — same data as `memory_list_projects` from inside a
  session.
- `scripts/check-health.sh` — verifies Docker container health, plugin config,
  Neo4j auth, and the MCP handshake in one shot.
- `npm run backfill-subsystems` — tags pre-existing observations that predate
  subsystem tagging. Idempotent and resumable (only ever selects
  `subsystem IS NULL`, writes per batch), and processes entities largest-first
  per project so the vocabulary early batches establish is what later,
  smaller batches reuse. `--dry-run` previews without writing; `--project`
  scopes to one project.
- A statusline showing `<model> · 🧠 <entities>e/<observations>o` can be wired
  via `scripts/statusline.mjs` (see `.claude/settings.local.json`).
- The full graph is also browsable directly in Neo4j's own UI at
  `http://localhost:7474` (local mode) — no custom viewer needed.

### Token cost

Reads are bounded by a character budget, not just a row count — see
`src/lib/budget.js`. Observation length varies by source (bulk-imported history
runs ~5x longer than natively-captured observations), so a row limit alone
makes a call's cost unpredictable. Trimmed content is always marked in-band
(`…[+N chars]`), and `memory_timeline` returns `{events, total, returned,
truncated}` so a partial history is never mistaken for a complete one.

`npm run token-cost [-- --all]` measures every read path and exits non-zero if
one exceeds its per-call ceiling:

```
PATH                        CHARS  ~TOKENS  STATUS  NOTE
SessionStart injection       8640     2160  ok       per session, always
memory_timeline             31975     7994  ok       default limit
```

### Usage report

`scripts/memory-usage.sh` (or `npm run usage`) prints every project registered
in the database — entity/observation counts, first-seen date, observations in
the last 7 days, and last activity — followed by database totals and hygiene
warnings (projects recorded under two different names, entities hoarding 100+
observations, empty entity stubs). Pass `--quiet` for just the table.

```
PROJECT                                    ENTITIES      OBS   OBS/7D FIRST        LAST ACTIVITY
github.com/you/your-repo                         21      149      149 2026-07-20   2026-07-20T17:58

Totals: 5 project(s), 51 entities, 1041 observations, 57 relations
```

The same per-project listing is available in-session as the
`memory_list_projects` MCP tool, and as `npm run memory -- projects`.

### Backup and restore

The memory graph lives in a Docker volume, so it is the only copy of everything
the plugin has learned. `npm run backup` snapshots it; `npm run restore` puts it
back.

```
npm run backup                  # -> ~/.claude-neo4j/backups/neo4j-<timestamp>.dump
npm run backup -- --keep 7      # afterwards, keep only the 7 newest
npm run backup -- --list        # show existing backups

npm run restore -- --latest     # restore the newest backup
npm run restore -- --info FILE  # inspect an archive without restoring
```

Both use Neo4j's official `neo4j-admin database dump`/`load`, which capture the
whole store — indexes and constraints included, not just the entities and
observations the plugin models. That format cannot operate on a mounted
database, so each script stops the container and restarts it afterwards
**including when the dump fails or you interrupt it**. A backup takes about 13
seconds.

Restoring replaces the database. Before anything is touched, `restore.sh`
verifies the archive's checksum, prints its metadata and the current entity and
observation counts, and requires you to type the database name (`neo4j`) to
confirm; `--force` skips the prompt. Afterwards it prints the restored counts,
so a round trip is verified rather than assumed.

Two limitations worth knowing:

- **Local mode only.** A dump reads store files, so it cannot reach Neo4j Aura.
  Use the provider's own snapshots for a remote database.
- **Compression is off by default.** The `.dump` format is already
  zstd-compressed internally: on a real 78-entity/1187-observation graph, `xz`
  took 898KB down to 890KB — 0.9%. `--xz` is available if you are shipping the
  archive somewhere that charges by the byte, and `restore.sh` detects
  compressed input by content rather than by file extension.

Each backup gets a `.sha256` sidecar. This is not decoration: `neo4j-admin
load --info` parses only the archive header and will report a truncated dump as
complete, so the sidecar is the only thing standing between a partial archive
and a half-finished load over a database that has already been overwritten.

### Cypher-shell cheatsheet

`scripts/cypher.sh "<query>"` runs arbitrary Cypher with no setup: it resolves
credentials from `$NEO4J_*`, then `~/.claude-neo4j/config.json`, then
`docker/.env`, and picks a `cypher-shell` binary automatically — preferring one
on your `PATH` but otherwise **borrowing the copy inside the Neo4j container**,
so local-mode users never have to install anything. It accepts a query as an
argument or on stdin:

```bash
scripts/cypher.sh "MATCH (e:Entity) RETURN count(e);"
echo "MATCH (o:Observation) RETURN count(o);" | scripts/cypher.sh
```

Only a remote database (Aura) on a host without `cypher-shell` needs a real
install; the script prints platform-specific instructions if you hit that. Note
that the `memory_*` MCP tools and `npm run memory -- <cmd>` talk to Neo4j over
Bolt via the driver library and never require `cypher-shell` at all.

The queries below work the same way if pasted into the Neo4j Browser at
`http://localhost:7474`. All of these respect the graph model in
[Graph model](#graph-model) above.

```cypher
// List every project tracked in the db, with entity/observation counts and
// last activity (same data as `npm run memory -- projects` / memory_list_projects)
MATCH (e:Entity) WHERE e.project IS NOT NULL
OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
RETURN e.project AS project, count(DISTINCT e) AS entities, count(o) AS observations,
       max(o.createdAt) AS lastActivity
ORDER BY lastActivity DESC;

// All entities for one project, with observation counts
MATCH (e:Entity {project: "github.com/you/your-repo"})
OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
RETURN e.name, e.type, count(o) AS observations
ORDER BY observations DESC;

// Full detail for one entity: every observation + every relation in/out
MATCH (e:Entity {name: "user"})
OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
OPTIONAL MATCH (e)-[r:RELATES_TO]-(other)
RETURN e, collect(DISTINCT o) AS observations, collect(DISTINCT {type: r.type, entity: other.name}) AS relations;

// Most recently created observations across all projects (recent activity feed)
MATCH (o:Observation)-[:ABOUT]->(e:Entity)
RETURN o.createdAt AS createdAt, e.project AS project, e.name AS entity, o.text AS text
ORDER BY o.createdAt DESC
LIMIT 25;

// Whole relationship graph for one project (visualize in Neo4j Browser)
MATCH (e:Entity {project: "github.com/you/your-repo"})
OPTIONAL MATCH (e)-[r:RELATES_TO]-(other)
RETURN e, r, other;

// Sessions and how many observations each one produced
MATCH (s:Session)
OPTIONAL MATCH (s)-[:PRODUCED]->(o:Observation)
RETURN s.id, s.project, s.startedAt, count(o) AS observationsProduced
ORDER BY s.startedAt DESC;

// Possible near-duplicate entity names within a project (eyeball before merging -
// see `src/lib/dedup.js` for the automated version applied at write time)
MATCH (a:Entity), (b:Entity)
WHERE a.project = b.project AND a.name < b.name
  AND (toLower(a.name) CONTAINS toLower(b.name) OR toLower(b.name) CONTAINS toLower(a.name))
RETURN a.project, a.name, b.name;

// Orphan entities with zero observations (candidates for cleanup)
MATCH (e:Entity) WHERE NOT (e)<-[:ABOUT]-(:Observation)
RETURN e.project, e.name, e.type;

// Manually merge two duplicate entities (rewire b's observations/relations onto a, delete b)
// Run only after confirming they really are the same thing.
MATCH (a:Entity {project: "github.com/you/your-repo", name: "canonical-name"})
MATCH (b:Entity {project: "github.com/you/your-repo", name: "duplicate-name"})
MATCH (b)<-[:ABOUT]-(o:Observation)
MERGE (o)-[:ABOUT]->(a)
WITH a, b
DETACH DELETE b;
```

## Project layout

```
.claude-plugin/plugin.json   plugin manifest
hooks/hooks.json             SessionStart / PreCompact / SessionEnd wiring
.mcp.json                    bundled MCP server registration
skills/                      memory-search, memory-status, timeline-report
src/lib/                     config resolution, Neo4j client, schema, graph ops, project detection,
                              entity-name dedup, cross-session capture digest
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

## Changelog

Newest first. Kept brief — see `git log` for full detail.

### 0.2.0 — 2026-07-21

First version bump since the plugin was created. Marketplace installs compare
this number, so everything landed since `0.1.0` only reaches other projects
now — see the snapshot-drift notes in `CLAUDE.md`.

- Added `npm run backup` / `npm run restore` (`scripts/backup.sh`,
  `scripts/restore.sh`) — full `neo4j-admin` dump/load of the local database,
  with checksum-verified archives, a confirm-by-name restore prompt, and
  `--keep N` retention. Local mode only.
- **Breaking:** `getTimeline` returns `{total, returned, truncated}` rather
  than a bare array, from the token-budget work.
- Added per-read-path character budgets (`src/lib/budget.js`), cutting a
  default `memory_timeline` from ~60k tokens to ~8k, plus `npm run token-cost`
  to catch regressions.
- Fixed `memory_search` returning an entity's newest observations instead of
  the ones that actually matched, and escaped Lucene syntax so entity names
  like `feature:capture-visibility` are findable.
- Capped `memory_get_entity` at the 50 newest observations by default.
- Made auto-capture recoverable (failed captures retry from `SessionStart`)
  and widened its window from 15k to 50k characters across up to 3 chunks.
- Rewrote `scripts/migrate-from-claude-mem.mjs` to map project scope onto the
  git-remote identifier and split observations by claude-mem's `type`.
- Hardened all `scripts/*.sh` against resolving the plugin directory to `/`,
  which silently started memory-less sessions; guarded by `npm test`.

### 2026-07-20

- Added a cypher-shell query cheatsheet to the README, plus `memory_list_projects`
  / `npm run memory -- projects` to list every project tracked in the db.
- Added `memory_prune` / `npm run memory -- prune` (dry-run by default) to
  delete old observations while always keeping the most recent few per entity.
- Added recency-weighted ranking to `memory_search` so stale-but-lexically-strong
  matches don't always outrank recent ones.
- Added a cross-session capture digest — the next `SessionStart` banner reports
  what background auto-capture saved since your last session.
- Added entity-name dedup: capture extraction reuses known project entity
  names, backed by a lexical-similarity fallback (`src/lib/dedup.js`).
- Fixed the `PreCompact` hook to emit `systemMessage` instead of an invalid
  `hookSpecificOutput.additionalContext`, which was failing schema validation.
- Added `scripts/migrate-from-claude-mem.mjs` (one-off, explicit-only) plus a
  `SessionStart` hint suggesting it when unmigrated claude-mem data is found.
- Documented the `docker/.env` vs `~/.claude-neo4j/config.json` credential
  flow; gitignored `.claude/settings.local.json`.
