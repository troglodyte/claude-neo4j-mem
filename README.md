# neo4j-memory

A Claude Code plugin that gives Claude persistent, graph-based memory — like
[claude-mem](https://github.com/thedotmack/claude-mem), but backed by
[Neo4j](https://neo4j.com/) instead of a local vector store. Facts, decisions,
and preferences are stored as an entity/observation/relation graph, scoped per
project (by git remote), and are recallable across sessions and machines.

Works against either:

- **Local**: a Neo4j container run via Docker Compose (default).
- **Remote / web-based**: any hosted Neo4j reachable over `bolt`/`neo4j+s` — e.g.
  [Neo4j Aura](https://neo4j.com/product/auradb/), or a self-hosted server on the
  network. Only the connection URI and credentials change.

## How it works

- **`SessionStart` hook** injects a compact, fixed-cost snapshot of the current
  project's memory: the standing facts that always apply (preferences and
  constraints, quoted verbatim) followed by a one-line-per-subsystem index of
  everything else — so Claude knows what exists and can `memory_search` into it
  rather than being handed a recency dump. It also prints a short banner
  (`🧠 Neo4j memory: 223 observation(s) across 6 subsystem(s) for <project>.`),
  or, if the plugin isn't configured or Neo4j isn't reachable, one pointing at
  `scripts/setup-local.sh` rather than failing silently.
- **MCP server** (`neo4j-memory`) exposes eleven tools Claude can call mid-session:
  `memory_search`, `memory_get_entity`, `memory_recent`, `memory_timeline`,
  `memory_status`, `memory_list_projects`, `memory_add_observations`,
  `memory_create_relation`, `memory_delete_observations`, `memory_delete_entity`,
  `memory_prune`.
  - Observations carry a **`subsystem` tag** (e.g. `capture`, `search`,
    `backup`) inferred at write time. Cross-cutting facts — preferences,
    project-wide constraints — carry none, because they reach Claude through
    the standing-facts block rather than the index. `memory_search`,
    `memory_recent`, and `memory_timeline` take an optional `subsystem` to
    scope a read to one tag; `memory_add_observations` takes a call-level
    `subsystem` to tag a batch.
  - The five write tools return a `confirmation` string Claude relays as a short
    line (`🧠 remembered 2 observation(s) on ...`) so mid-session writes aren't
    silent. Mute with `npm run memory -- mute` (persistent) or
    `CLAUDE_NEO4J_QUIET=1` (session-only); `unmute` reverses it.
- **`PreCompact`/`SessionEnd` hooks** read the new part of the transcript since
  the last capture and shell out to a locked-down, one-shot headless `claude -p`
  call (Haiku, no tools, no MCP servers, no settings/CLAUDE.md inheritance,
  structured output via `--json-schema`) to extract durable facts, then write
  them into Neo4j — a backstop for anything Claude didn't explicitly save.
  Because it runs through the `claude` CLI rather than the Anthropic SDK, it
  rides your existing logged-in session instead of needing a separate
  `ANTHROPIC_API_KEY`. The extraction prompt is seeded with the project's known
  entity names and subsystem tags so it reuses them, and a lexical-similarity
  check (`src/lib/dedup.js`) catches any that still drift (typos, `-` vs `:`).
  See [Automatic capture](#automatic-capture) to tune or disable it.
- **Nothing is silent.** `SessionEnd` capture runs detached and `PreCompact`'s
  confirmation may not survive to be seen, so the next `SessionStart` banner
  reports whatever background capture saved since your last session — and says
  when it's retrying one that previously failed.
- **Recall uses Neo4j's own full-text indexes and relationship traversal** — no
  embedding API, no vector store, no per-search cost. `memory_search` ranking
  blends full-text score with recency (roughly a 30-day half-life), so a stale
  but lexically strong match doesn't always outrank something recent.
- **`memory_prune`** / `npm run memory -- prune` deletes observations past a
  given age (default 180 days), always keeping the most recent few per entity.
  Dry run by default in both the CLI and the MCP tool. Nothing prunes
  automatically.

All hook scripts fail open: if Neo4j is unreachable or unconfigured they log to
stderr and exit 0 without blocking your session.

### Graph model

```
(:Entity {name, type, project})
(:Observation {id, text, subsystem, createdAt, sessionId})-[:ABOUT]->(:Entity)
(:Entity)-[:RELATES_TO {type}]->(:Entity)
(:Session {id, cwd, project})-[:PRODUCED]->(:Observation)
```

Entity identity is `(name, project)`, not `name` alone, so unrelated repos using
the same entity name don't collide. `project` comes from
`git remote get-url origin` (falling back to the cwd basename); a
`project IS NULL` entity is treated as global and shows up everywhere.

## Setup

**Quick start (local Docker):** `npm install && scripts/setup-local.sh` does
everything below — generates `docker/.env` with a random password if missing,
starts the container, waits for health, and configures the plugin against it.
Safe to re-run any time. Without Docker, use the remote/Aura path in step 2.

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

**Remote (e.g. Aura):** create an instance at
[console.neo4j.io](https://console.neo4j.io) and note its `neo4j+s://...` URI,
username, and password. No local container needed.

### 3. Configure the plugin

Run this yourself in a terminal (not via Claude — it collects a password):

```bash
npm run configure
```

It prompts for local vs. remote, tests connectivity, and saves to
`~/.claude-neo4j/config.json` (mode 0600). Skip the prompts with flags:

```bash
node scripts/configure.mjs --mode remote \
  --uri neo4j+s://xxxxx.databases.neo4j.io \
  --username neo4j --password '...' --database neo4j
```

Resolution order at runtime: env vars (`NEO4J_URI`, `NEO4J_USERNAME`,
`NEO4J_PASSWORD`, `NEO4J_DATABASE`) > `~/.claude-neo4j/config.json` > local
Docker defaults. Env vars are handy for pointing one session at a different
database without touching the saved config.

> **`docker/.env` and `~/.claude-neo4j/config.json` are two separate files,
> synced once at setup time and never linked at runtime.** `docker/.env` only
> feeds Docker — `docker compose` auto-loads the `.env` beside the
> `docker-compose.yml` it runs (hence `cd docker` first) and interpolates
> `NEO4J_USERNAME`/`NEO4J_PASSWORD`/`NEO4J_HTTP_PORT`/`NEO4J_BOLT_PORT` into the
> container. `~/.claude-neo4j/config.json` is what Claude actually reads (via
> `src/lib/config.js`), populated by copying those same values out once. **Change
> the password in `docker/.env` later and Claude won't pick it up** — re-run
> `npm run configure` or `scripts/setup-local.sh`.

### 4. Load the plugin

```bash
scripts/claude-with-memory.sh
```

This wraps `claude --plugin-dir /path/to/claude-neo4j` so you don't have to
remember the path; extra args pass through, e.g.
`scripts/claude-with-memory.sh -p "..."`. Run `/reload-plugins` in-session after
changing plugin code.

`scripts/setup-local.sh` collapses steps 2–3 for local mode into one command.

## Automatic capture

On by default. It uses the `claude` CLI already on your PATH (your logged-in
session — no separate API key) and Claude Haiku.

| variable | effect |
| --- | --- |
| `CLAUDE_NEO4J_DISABLE_CAPTURE=1` | turn capture off entirely |
| `CLAUDE_NEO4J_CAPTURE_MODEL` | override the extraction model |
| `CLAUDE_NEO4J_CAPTURE_CLI` | override the CLI it shells out to |
| `CLAUDE_NEO4J_CAPTURE_WINDOW` | characters of new transcript per window (default 50,000) |
| `CLAUDE_NEO4J_CAPTURE_MAX_CHUNKS` | windows per capture (default 3) |

Windows are taken from the end, so a session past the ceiling loses its oldest
content rather than its most recent, and `~/.claude-neo4j/capture.log` records
how much was dropped. Raise either to trade tokens for coverage.

A capture that fails (Neo4j restarting, a timed-out extraction) keeps its input
and retries at the next session start, up to 3 attempts — transcripts stay on
disk, so a capture that failed days ago still works when it finally runs.

## Usage

- "What do you remember about X" — uses the `memory-search` skill / `memory_search`.
- "Is memory working?" / "what's my memory status" — `memory-status` / `memory_status`.
- "Give me a timeline report" / "journey into this project" — the
  `timeline-report` skill / `memory_timeline`, narrating the project's history.
- Tell Claude to forget something — `memory_delete_entity` /
  `memory_delete_observations`.

### Outside a Claude session

- `npm run memory -- status` (or `search`, `recent`, `get`, `add`, `relate`,
  `timeline`, `forget-obs`, `forget`, `prune`, `projects`, `mute`, `unmute`) —
  query and edit the graph from a terminal. Run with no args for full usage.
- `scripts/check-health.sh` — container health, plugin config, Neo4j auth, and
  the MCP handshake in one shot, PASS/FAIL per check.
- `npm run usage` — every project in the database with entity/observation
  counts, first-seen, observations in the last 7 days, and last activity,
  followed by totals and hygiene warnings (a project recorded under two names,
  entities hoarding 100+ observations, empty stubs, subsystem maps too
  fragmented to inject cheaply). `--quiet` for just the table.
- `npm run token-cost [-- --all]` — see [Token cost](#token-cost).
- `npm run backfill-subsystems` — tags observations predating subsystem
  tagging. Idempotent and resumable (selects `subsystem IS NULL`, writes per
  batch), and processes entities largest-first per project so the vocabulary
  early batches establish is what later ones reuse. `--dry-run` previews;
  `--project` scopes to one project; `--retag TAG` reclassifies observations
  already carrying a tag, which is how a catch-all gets emptied.
- `scripts/cypher.sh "<query>"` — arbitrary Cypher with no install needed. See
  the [Cypher cheatsheet](docs/cypher-cheatsheet.md).
- `scripts/statusline.mjs` — a statusline showing
  `<model> · 🧠 <entities>e/<observations>o`, wired via
  `.claude/settings.local.json`.
- The graph is browsable directly in Neo4j Browser at `http://localhost:7474`
  (local mode) — no custom viewer needed.

### Token cost

Reads are bounded by a character budget, not just a row count — see
`src/lib/budget.js`. Observation length varies by source (bulk-imported history
runs ~5x longer than natively-captured observations), so a row limit alone makes
a call's cost unpredictable. Trimmed content is always marked in-band
(`…[+N chars]`), and `memory_timeline` returns `{events, total, returned,
truncated}` so a partial history is never mistaken for a complete one.

`npm run token-cost [-- --all]` measures every read path and exits non-zero if
one exceeds its per-call ceiling. Run it after changing anything that shapes a
read payload:

```
PATH                        CHARS  ~TOKENS  STATUS  NOTE
SessionStart injection       2887      722  ok       per session, always
memory_timeline             20628     5157  ok       default limit
```

## Backup and restore

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
**including when the dump fails or you interrupt it**. A backup takes ~13
seconds.

Restoring replaces the database. Before anything is touched, `restore.sh`
verifies the archive's checksum, prints its metadata alongside the current
entity and observation counts, and requires you to type the database name
(`neo4j`) to confirm; `--force` skips the prompt. Afterwards it prints the
restored counts, so a round trip is verified rather than assumed.

Two limitations worth knowing:

- **Local mode only.** A dump reads store files, so it cannot reach Aura. Use
  the provider's own snapshots for a remote database.
- **Compression is off by default.** The `.dump` format is already
  zstd-compressed internally: on a real 78-entity/1187-observation graph, `xz`
  took 898KB down to 890KB — 0.9%. `--xz` exists for when you're shipping the
  archive somewhere that charges by the byte, and `restore.sh` detects
  compressed input by content rather than by extension.

Each backup gets a `.sha256` sidecar. This is not decoration: `neo4j-admin load
--info` parses only the archive header and will report a truncated dump as
complete, so the sidecar is the only thing standing between a partial archive
and a half-finished load over a database that has already been overwritten.

## Project layout

```
.claude-plugin/plugin.json     plugin manifest
hooks/hooks.json               SessionStart / PreCompact / SessionEnd wiring
.mcp.json                      bundled MCP server registration
skills/                        memory-search, memory-status, timeline-report
src/mcp/server.js              MCP tools
src/hooks/                     session-start.js, capture.js
src/lib/                       config, Neo4j client, schema, graph ops, project detection,
                                 read budgets, SessionStart injection, subsystem tags,
                                 entity-name dedup, extraction, capture digest
docker/                        docker-compose.yml for local Neo4j
scripts/                       setup, configure, health check, CLI, statusline,
                                 backup/restore, cypher, usage, backfill, migration
tests/                         node --test suites + the launcher-path guard
docs/                          cypher cheatsheet, design specs
CLAUDE.md                      traps and conventions for working on this repo
CHANGELOG.md                   per-release detail
```

## Notes

- `docker/.env` and `~/.claude-neo4j/config.json` hold credentials — never
  commit either (the former is gitignored; the latter lives outside the repo).
- Switching between local and remote is just `npm run configure` again, or
  setting `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD` — no code changes.
- Marketplace installs compare the `version` in `.claude-plugin/plugin.json`, so
  a release that doesn't move it never reaches other projects. See `CLAUDE.md`
  for the snapshot-drift notes.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
