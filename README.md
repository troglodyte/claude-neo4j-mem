# neo4j-memory

A Claude Code plugin that gives Claude persistent memory in a local SQLite file,
`~/.claude-neo4j/memory.sqlite`, through Node's built-in `node:sqlite`: no server, no
container, no embedding API. Facts, decisions and preferences are stored as entities,
observations and relations, scoped per project (by git remote), and recalled across
sessions. Session start injects the standing facts and a subsystem index, capture saves
new facts at compaction and session end, and an MCP server exposes search and edit tools.

Despite the name, Neo4j is now only the place a machine's existing memory moves from,
once. The plugin, its MCP server (`neo4j-memory`) and its folder (`~/.claude-neo4j`) keep
their names so permission rules, tool references and config paths keep working.

## Requirements

Node 22.13 or later in 22.x, 23.4 or later in 23.x, or any 24+, somewhere on the
machine. It need not be the default `node`: every memory process starts through
`bin/memory-node`, which uses the first suitable Node it finds, in this order:

1. `CLAUDE_NEO4J_NODE`, if set.
2. `node` on `PATH`.
3. The newest under nvm, fnm and volta.
4. Homebrew (`$HOMEBREW_PREFIX`, else `/opt/homebrew` and `/usr/local`).

If none qualifies, session start shows one line naming the versions it found, and the
memory server fails visibly instead of hanging.

## Install

```bash
claude plugin marketplace add troglodyte/claude-neo4j-mem
claude plugin install neo4j-memory@claude-neo4j-local --scope user
```

If the install path (`installPath` in `~/.claude/plugins/installed_plugins.json`) has
no `node_modules`, run this in it. All three dependencies are public packages, so it
works whatever registry `~/.npmrc` names:

```bash
npm install --omit=dev --registry=https://registry.npmjs.org/
```

## First start

Session start decides what to do from the store file, the Neo4j settings and the last
move's record:

- **A store exists**: memory works as usual.
- **No store and no Neo4j settings** (a new user): an empty store is created.
- **No store, and Neo4j settings** (a password in `~/.claude-neo4j/config.json`, or
  `NEO4J_PASSWORD`): session start moves the graph across in the background, which takes
  about a minute. Meanwhile the memory tools answer "memory is moving to SQLite", and
  captures wait for a later session start. Each move builds its own
  `memory.sqlite.migrating-<run>`, checks every row against Neo4j, and puts it in place
  only if the check passes, never over an existing store. If Neo4j could not be read, the
  next session start tries again.
- **Neo4j settings, but Neo4j is down**: memory stays off. Start it once
  (`scripts/setup-local.sh`) so the move can run, or run `npm run memory -- start-fresh`
  to begin with an empty store and leave Neo4j untouched.
- **The last move failed**: memory stays off, and session start names the reason and the
  log, `~/.claude-neo4j/state/migrate.log`. The staged file and its report are kept.
  Fix the cause, then run `npm run migrate-to-sqlite`, which moves the graph the same
  careful way.

Sessions that were already open keep writing to Neo4j until they end. For 7 days after
the move, each session start copies those new rows across in the background. It only
ever inserts, so nothing deleted in SQLite comes back.

## Moving a machine off Neo4j

1. Leave Neo4j running and install the plugin (above). If an older version is already
   installed, update it instead: run
   `claude plugin marketplace update claude-neo4j-local`, then
   `claude plugin update neo4j-memory@claude-neo4j-local`. Without the first, the update
   does not see the new version. Check the new install path for `node_modules` as above.
2. Start one Claude Code session. Wait until `~/.claude-neo4j/state/migrate.log` says
   `memory moved`. To move it now instead, run `npm run migrate-to-sqlite` in the
   install path; it ends with `PASS` and `memory moved`.
3. In the install path, run `npm run health`. Every check should PASS, and `migration`
   should read `last passed`.
4. Run `npm run backup`.
5. Optionally remove the rows a test run wrote into the graph on 2026-10-09:
   `bash bin/memory-node scripts/remove-test-rows.mjs` lists them, and the same command
   with `--apply` deletes them from SQLite. Neo4j is never touched.
6. Once the sessions that were open have ended, or the 7 days are up, stop the
   container. Run `podman stop claude-neo4j-memory`, or `docker stop claude-neo4j-memory`;
   `podman update --restart=no claude-neo4j-memory` keeps it from coming back with the
   Podman machine. Its volume is untouched.

## How it works

- **`SessionStart` hook** injects a compact, fixed-cost snapshot of the current
  project's memory: the standing facts that always apply (preferences and constraints,
  quoted verbatim, with near-identical repeats collapsed) followed by a
  one-line-per-subsystem index of everything else, so Claude knows what exists and can
  `memory_search` into it rather than being handed a recency dump. It also prints a
  short banner (`🧠 Memory: 223 observation(s) across 6 subsystem(s) for <project>.`).
- **MCP server** (`neo4j-memory`) exposes eleven tools Claude can call mid-session:
  `memory_search`, `memory_get_entity`, `memory_recent`, `memory_timeline`,
  `memory_status`, `memory_list_projects`, `memory_add_observations`,
  `memory_create_relation`, `memory_delete_observations`, `memory_delete_entity`,
  `memory_prune`.
  - Observations carry a **`subsystem` tag** (e.g. `capture`, `search`, `backup`)
    inferred at write time. Cross-cutting facts carry none, because they reach Claude
    through the standing-facts block. `memory_search`, `memory_recent` and
    `memory_timeline` take an optional `subsystem`; `memory_add_observations` takes a
    call-level `subsystem` to tag a batch.
  - Search results list each relation with its `direction`: `out` when the result is the
    relation's start, `in` when it is the end, `self` when it is both.
  - The five write tools return a `confirmation` string Claude relays as a short line
    (`🧠 remembered 2 observation(s) on ...`). Mute with `npm run memory -- mute`
    (persistent) or `CLAUDE_NEO4J_QUIET=1` (session-only); `unmute` reverses it.
- **`PreCompact`/`SessionEnd` hooks** read the new part of the transcript since the last
  capture and shell out to a locked-down, one-shot headless `claude -p` call (Haiku, no
  tools, no MCP servers, no settings or CLAUDE.md inheritance, structured output via
  `--json-schema`) to extract durable facts, then write them into the store. It rides
  your logged-in session, so no `ANTHROPIC_API_KEY` is needed. The prompt is seeded with
  the project's known entity names and subsystem tags, and a lexical-similarity check
  (`src/lib/dedup.js`) catches names that still drift.
- **Nothing is silent.** `SessionEnd` capture runs detached, so the next `SessionStart`
  banner reports what background capture saved, and says when it is retrying one that
  failed.
- **Recall uses SQLite full-text search** (FTS5, bm25, Unicode word segmentation that
  keeps `a:b`, `a.b` and `a_b` whole) blended with recency, `1 / (1 + days / 30)`. A
  multi-word query whose best result holds only one of its words is marked weak.
- **`memory_prune`** / `npm run memory -- prune` deletes observations past a given age
  (default 180 days), always keeping the most recent few per entity. Dry run by default.
  Nothing prunes automatically.

All hook scripts fail open: if the store cannot be opened they say why and exit 0
without blocking your session.

### Storage

Tables `entities`, `observations`, `relations`, `sessions` and `migrations`, plus two
FTS5 tables, in `src/lib/sqliteDb.js`. Entity identity is `(name, project)`, so unrelated
repos using the same entity name don't collide. `project` comes from
`git remote get-url origin` (falling back to the cwd basename); an entity with project
`''` is global and shows up everywhere.

## Automatic capture

On by default. It uses the `claude` CLI already on your PATH and Claude Haiku.

| variable | effect |
| --- | --- |
| `CLAUDE_NEO4J_DISABLE_CAPTURE=1` | turn capture off entirely |
| `CLAUDE_NEO4J_CAPTURE_MODEL` | override the extraction model |
| `CLAUDE_NEO4J_CAPTURE_CLI` | override the CLI it shells out to |
| `CLAUDE_NEO4J_CAPTURE_WINDOW` | characters of new transcript per window (default 50,000) |
| `CLAUDE_NEO4J_CAPTURE_MAX_CHUNKS` | windows per capture (default 3) |

Windows are taken from the end, so a session past the ceiling loses its oldest content
rather than its most recent, and `~/.claude-neo4j/capture.log` records how much was
dropped.

A capture that fails (memory moving to SQLite, a timed-out extraction) keeps its input
and retries at the next session start, up to 3 attempts.

## Usage

- "What do you remember about X": the `memory-search` skill / `memory_search`.
- "Is memory working?": `memory-status` / `memory_status`.
- "Give me a timeline report": the `timeline-report` skill / `memory_timeline`.
- Tell Claude to forget something: `memory_delete_entity` / `memory_delete_observations`.

### Outside a Claude session

- `npm run memory -- status` (or `search`, `recent`, `get`, `add`, `relate`, `timeline`,
  `forget-obs`, `forget`, `prune`, `projects`, `dupes`, `start-fresh`, `mute`, `unmute`):
  query and edit the store from a terminal. Run with no arguments for usage.
  `dupes [--min 0.3]` lists likely repeated standing facts, most similar first.
- `npm run health`: the launcher's Node, the store file, its schema and integrity, its
  contents and the last migration, PASS/FAIL per check.
- `npm run stats [-- --project ID | --all]`: one project's memory over time: weekly
  growth, observations per session, observation length, subsystem spread and relations.
  Defaults to the repo you run it from, so `npm --prefix <plugin dir> run stats` works
  from any checkout.
- `npm run token-cost [-- --all]`: see [Token cost](#token-cost).
- `npm run telemetry [-- --days N]`: how memory is used: reads and writes per project,
  characters served, misses, and the searches that found nothing. Reads
  `~/.claude-neo4j/telemetry.jsonl`; opt out with `CLAUDE_NEO4J_DISABLE_TELEMETRY=1`.
- `npm run search-parity`: replays logged searches through Neo4j and through a fresh
  copy in SQLite, and reports how often they agree. Needs Neo4j running.
- `scripts/statusline.mjs`: a statusline showing `<model> · 🧠 <entities>e/<observations>o`.

### Token cost

Reads are bounded by a character budget, not just a row count (`src/lib/budget.js`).
Trimmed content is marked in-band (`…[+N chars]`), and `memory_timeline` returns
`{events, total, returned, truncated}` so a partial history is never mistaken for a
complete one. `npm run token-cost [-- --all]` measures every read path and exits non-zero
if one exceeds its per-call ceiling.

## Backup, restore, health

```bash
npm run backup                         # online copy to ~/.claude-neo4j/backups/memory-<UTC stamp>.sqlite
npm run backup -- --keep 7             # then keep only the 7 newest memory-*.sqlite backups
npm run restore -- --latest            # put the newest backup back (or: npm run restore -- <file>)
npm run health                         # PASS/FAIL per check
```

A backup is an online `VACUUM INTO`, safe while sessions write, readable only by you
(mode 0600). Restore checks the backup's integrity first, refuses while any process has
the store open (close your Claude Code sessions, or pass `--force`), and moves the
current store aside to `memory.sqlite.pre-restore-<stamp>` rather than deleting it.

## Legacy: Neo4j

These reach the old Neo4j graph and stay until it is retired: `scripts/setup-local.sh`
and `npm run configure` (start and configure the container), `scripts/backup.sh`,
`scripts/restore.sh` and `scripts/check-health.sh` (Neo4j dumps and checks),
`npm run migrate-to-podman`, `scripts/cypher.sh`, `scripts/fingerprint.sh`,
`npm run migrate-claude-mem`, and
`docker/`. The container is `claude-neo4j-memory`, under Podman or Docker. Its
credentials live in `docker/.env` and the Neo4j fields of `~/.claude-neo4j/config.json`.
The full Neo4j setup guide is in this README as of 0.6.0, in git history.

## Development

`scripts/claude-with-memory.sh` starts Claude Code with the plugin loaded from this
checkout (`claude --plugin-dir`); run `/reload-plugins` after changing plugin code.

```bash
env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" npm test
```

The temporary `HOME` keeps tests away from your real store and settings, and the `env -u`
matters if capture is switched off in your settings, which would fail the capture tests.
On macOS, `engine-resolve.test.sh`'s pty case fails because it needs util-linux
`script -qec`.

## Project layout

```text
.claude-plugin/          plugin and marketplace manifests
bin/memory-node          launcher: finds a Node with node:sqlite for every memory process
hooks/hooks.json         SessionStart / PreCompact / SessionEnd wiring
.claude-plugin/plugin.json  also registers the MCP server (no root .mcp.json; see CLAUDE.md)
skills/                  memory-search, memory-status, timeline-report
src/mcp/server.js        MCP tools
src/hooks/               session-start.js, capture.js
src/lib/                 config, memoryStore (+ firstStart), sqliteDb (schema), graph, search,
                         segment, budgets, injection, subsystem tags, dedup, extraction,
                         catchUp, backup, health, migrate/ (Neo4j to SQLite)
scripts/                 memory CLI, migrate-to-sqlite, first-start-migrate, catch-up,
                         backup / restore / check-health (.mjs), statusline, token-cost,
                         telemetry, search-parity, remove-test-rows, legacy Neo4j scripts
docker/                  legacy: local Neo4j credentials
tests/                   node --test suites and bash suites
docs/                    design specs and plans
```

## Notes

- `~/.claude-neo4j/config.json` and `docker/.env` can hold the Neo4j password; never
  commit either.
- `memory.sqlite` is the only copy of what the plugin has learned since the move; back
  it up.
- Marketplace installs compare the `version` in `.claude-plugin/plugin.json`, so a release
  that doesn't move it never reaches other machines. See `CLAUDE.md`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
