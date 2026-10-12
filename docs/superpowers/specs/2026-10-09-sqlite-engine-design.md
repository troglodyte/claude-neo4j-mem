# Run the memory engine on SQLite instead of Neo4j

**Status**: draft for review, not yet implemented
**Date**: 2026-10-09

Replace Neo4j with SQLite as the memory engine, in one release.
`graph.js` keeps its 16 functions and their signatures but stores and searches with SQLite.
Search fixes relations shown without direction, and session start collapses repeated standing facts.
A launcher finds a Node that has `node:sqlite`.
The first start of the new version moves the machine's Neo4j memories into SQLite by itself.

This builds on `2026-10-09-sqlite-migration-design.md`: its schema, migration and check are the storage and the move.
That spec's evidence for leaving Neo4j (no query uses the graph; 98% search parity; footprint, outages, exposure) is not repeated here.

The work has two parts, specified together and planned separately:

- **Part A, the engine**: SQLite storage, search, and the two fixes. Testable on its own.
- **Part B, the cut-over**: launcher, first-start migration, catch-up, scripts and docs. What makes Part A shippable.

## Decisions

| question | decision |
| --- | --- |
| Neo4j after this | **Dropped as the engine.** No backend switch. Neo4j stays only as the source the first-start migration and catch-up read from, until a later cleanup retires it with `neo4j-driver` and the container scripts. |
| Rollback | **Install the previous plugin version.** Its Neo4j graph is untouched by the move; anything written after the switch exists only in SQLite. |
| Fixes in scope | **Relation direction** in search results, and **repeated standing facts**. Relation-label sprawl and capture over-recording are separate work. |
| Repeated facts | **Collapse at word overlap 0.8 or more, plus a review command.** See "Fix 2". |
| First start | **Migrate automatically** when the machine has a Neo4j config and no SQLite file. Memory is off for that minute. |
| Node | **A launcher finds Node 22.13 or later** (or 23.4+, or 24+) for the hooks and the memory server. |
| Remote (Aura) mode | **Dropped.** A remote config's first start copies the remote graph into the local file, with the migration's existing warning. |
| Names | **Unchanged**: the MCP server stays `neo4j-memory` and the folder `~/.claude-neo4j`. Renaming either breaks permission rules, tool references and config paths; that is cleanup work. |

## Part A: the engine

### Units

| unit | job |
| --- | --- |
| `src/lib/graph.js` | The same 16 exported functions with the same signatures. Logic that never depended on Neo4j stays as it is: budgets, truncation, canonical names, subsystem resolution, relevance, fallback, the relation cap. The 19 Cypher queries become SQL. |
| `src/lib/memoryStore.js` | `getDb()` opens `memory.sqlite` once per process (WAL, busy timeout, foreign keys) and upgrades its schema; `storeStatus()` reports whether memory is ready, migrating or missing; `closeDb()`. Replaces `ensureSchema`, `verifyConnectivity` and `closeDriver` for every caller. |
| `src/lib/segment.js` | `segmentWords(text)`: UAX #29 word segmentation with `Intl.Segmenter`, keeping `a:b`, `a.b` and `a_b` together as Lucene's standard analyzer did. Used for indexing and for queries. |
| `src/lib/search.js` | Builds the FTS5 query from segmented words and ranks entities. `graph.js`'s `searchMemory` calls it. |
| `src/lib/similarity.js` | `wordOverlap(a, b)`: Jaccard over lowercase words of three or more characters. Used by the collapse and by `dupes`. |
| `src/lib/sqliteDb.js` | Gains schema version 2 and the 1→2 upgrade. |

Everything the engine needs from the database goes through `memoryStore.js`; nothing imports `neo4jClient.js` except the migration and catch-up readers.

### Schema version 2

Version 1 is the migration's schema. Version 2 adds two full-text tables:

```sql
CREATE VIRTUAL TABLE entity_name_fts USING fts5(words, tokenize = "unicode61 tokenchars ':._'',·'");
CREATE VIRTUAL TABLE observation_text_fts USING fts5(words, tokenize = "unicode61 tokenchars ':._'',·'");
```

- Each row's `rowid` is its entity's `id` or its observation's `rowid`, and `words` is the text segmented by `segmentWords` and joined with spaces.
- The token characters are the in-word punctuation that UAX #29 keeps, as measured in the parity run, so a segmented word reaches the index as one token. `search-parity` is the acceptance if the set needs to change.
- Opening a version-1 file upgrades it in one transaction: create both tables, fill them from `entities` and `observations`, set `user_version = 2`.
- Every write that adds, changes or deletes an entity or observation updates its FTS row in the same transaction. SQL triggers cannot call `Intl.Segmenter`, so `graph.js` does it.

### Search

`searchMemory(query, limit, project, { subsystem })` returns the same envelope as today: `results`, `relevance`, `topScore`, `note`, and `otherProjects` when the fallback finds something.

1. Segment the query; quote each word and join with `OR`. A repeated word stays repeated, so it weighs double as it did in Lucene; dropping repeats cost three top results in the parity replay.
2. Score entity names and observation texts with FTS5 `bm25`, negated so higher is better; take each entity's best score.
3. Keep entities in the project or global (`project = ''`), and observations passing the subsystem filter.
4. Multiply by the recency decay `1 / (1 + daysSinceLatestObservation / 30)`, order, and keep `limit`.
5. For each entity, return its five best-matching observations, topped up with its newest ones, and its relations (see Fix 1).

The relevance cut-offs (`WEAK_SCORE`, `MULTI_WORD_MIN_SCORE`) were tuned to Lucene's scores, and no FTS5 score cut-off reproduces them: on the logged searches, bm25 scores of strong matches start at 3.47 and the one weak match scores 10.84.
So relevance counts words instead. A multi-word query whose best entity holds only one of its words, anywhere in its name or observations, is weak.
The cross-project fallback keeps its word-coverage check and drops its score floors.

`npm run search-parity` measures agreement. It replays the logged searches in `telemetry.jsonl` through the live Neo4j and through a fresh migration of it into a scratch file, so both hold the same data.
That script is the scratch harness from the migration work, made a repo script.

Acceptance against Neo4j on the logged searches:

- Same top result on at least 95%. Measured 196 of 200 with this design's code, replayed on the 2026-10-08 snapshot.
- The same queries return nothing on both.
- The same relevance label (strong, weak or none) on at least 95%. Measured 208 of 214.
  - Five of the six disagreements are Lucene calling a lone-word fragment strong (`JUMP-1463` matching only "jump").
  - The sixth is a Lucene "weak" whose best result held 8 of its 9 words.
  - The gate sits below the measurement because the logged searches keep growing and a disagreement is as likely to be Lucene's error as this rule's. A broken rule shows up as a collapse, not a two-point dip.

### Fix 1: relation direction

Search results list each entity's relations as `{ type, entity }`, matched without direction, so "X supports Y" reads backwards from Y's side.
Each relation becomes `{ type, entity, direction }`, where `direction` is `"out"` when the result entity is the relation's start, `"in"` when it is the end, and `"self"` when it is both.
`memory_get_entity` already separates outgoing and incoming relations and is unchanged.
The `memory_search` tool description states what `direction` means.

### Fix 2: repeated standing facts

Measured on 693 standing facts in 28 project scopes (53,764 pairs), by word overlap:

- 8 pairs score 0.8 or more. All are repeats, such as the same email address recorded twice.
- The next pair down scores 0.73 and is two different tickets (ES-78 and ES-82).
- Reworded repeats score lower than some genuinely different facts. This project's three score 0.65, 0.57 and 0.33, against 0.73 and 0.64 for pairs that differ. Wording alone cannot catch them safely.

So:

- `getPinnedFacts` collapses facts in one scope whose overlap is 0.8 or more, keeping the newest. It returns `collapsed` with the number hidden, and `total` still counts every fact. Nothing is deleted.
- `npm run memory -- dupes [--project P] [--min 0.3]` lists likely repeats in one scope, most similar first, each with entity, observation id, date and text, ready for `memory_delete_observations`. At 0.3 it lists 4 pairs in this project, including all three reworded repeats, and at most 18 in the largest scope.

### Behaviour the rewrite keeps

The existing tests pin most of this; the rest is stated here so the SQL reproduces it.

- **Project scope**: a read with a project sees that project's entities plus global ones (`''`); a read with no project sees everything. Entities are identified by `(name, project)`.
- **Writes**: names and subsystems resolve to existing ones as today. Text is truncated on the way in. One `addObservations` call gives its whole batch one `created_at`. An existing entity's `type` is kept unless a new one is given, and `updated_at` is bumped.
- **Order**: newest first everywhere it is today, with `rowid` breaking ties in `created_at`, so ties are deterministic for the first time.
- **Pinned facts**: entity types starting `user`, `preference`, `constraint` or `convention`, or the entity named `user`, as today.
- **Prune**: among observations older than the cutoff, keep each entity's newest `keepPerEntity` of those old ones; `dryRun` returns the count and a 20-row sample.
- **Delete**: deleting an entity deletes its observations and relations.
- **Timestamps** returned to callers are ISO strings from `new Date(ms).toISOString()`, always with three fractional digits. Neo4j dropped trailing zeros; callers parse or display these, so the format change is safe.

## Part B: the cut-over

### Launcher

`memory/bin/memory-node` (bash) starts every memory process: the MCP server and both hooks.
`.mcp.json` and `hooks/hooks.json` call it instead of `node`.

It uses the first Node that has `node:sqlite` unflagged (22.13+ in 22.x, 23.4+ in 23.x, any 24+), trying in order:

1. `CLAUDE_NEO4J_NODE`, if set.
2. `node` on `PATH`.
3. The newest suitable version under nvm, fnm, volta or Homebrew.

If none qualifies:

- **Hooks** exit 0, and session start shows one line naming the Node versions it found.
- **The memory server** exits non-zero with the same line, so Claude Code reports it as failed rather than hanging.

On this machine, two work repos pin Node 20.19.0 and 22.12. Both get nvm's 22.23.1.

### First start

Session start decides from `memory.sqlite`, `config.json` and the last migration's record. A machine "has a Neo4j config" when `config.json` holds a password or `NEO4J_PASSWORD` is set.

| state | what happens |
| --- | --- |
| `memory.sqlite` exists | Normal. |
| No file, no Neo4j config (a new user) | Create an empty store; normal. |
| No file, Neo4j configured and reachable, no migration running | Start the migration in a detached worker, then show: memory is moving to SQLite, off for about a minute. |
| A migration is running (lock held) | Same message; memory stays off. |
| No file, Neo4j configured but unreachable | Memory off. The message says to start Neo4j once (`scripts/setup-local.sh`) so memory can move, or run `npm run memory -- start-fresh` to begin empty with Neo4j left untouched. |
| The last migration failed | Memory off. The message gives the reason and the log path, and says to retry with `npm run migrate-to-sqlite`. |

The worker runs the existing migration into `memory.sqlite.migrating` and renames it to `memory.sqlite` only on exit 0.
A failed check therefore never becomes the live store; the staged file and its report stay for inspection.
The worker records its outcome (exit code, reason, report and log paths) in `state/migrate.json`, which is how session start knows the last migration failed.
The lock is `state/migrate.lock`, holding a pid and start time. It counts as stale when the pid is gone or it is more than 30 minutes old. The catch-up takes the same lock, so the two never run at once.

While memory is off, the memory tools return "memory is moving to SQLite; try again in a minute" or the failure reason.
Captures fail the same way, which parks them for the existing session-start retry sweep, so they land once the store exists.

### Catch-up after the switch

Sessions already open when the plugin updates keep running the old version and keep writing to Neo4j, through both the memory server and their capture hooks, until they end.

For 7 days after the switch (the first passed run's `finished_at` in `migrations`), each session start runs a catch-up in the background:

- It copies Neo4j rows created after the switch: observations, sessions, relations, and any entities they need.
- It is insert-only. Updates and deletions in Neo4j are ignored, and nothing created before the switch is touched, so a row the new engine deleted cannot come back. That is the hazard the migration spec's "Re-runs after the switch" describes.
- An unreachable Neo4j skips it quietly. Each run logs what it copied.

The reader gains a `since` option for this; the writer and check are reused, with the check limited to the copied rows.

### Config and lifecycle

- `config.json` gains `sqlitePath`, defaulting to `~/.claude-neo4j/memory.sqlite`; `CLAUDE_NEO4J_SQLITE` overrides it.
- The Neo4j fields stay, for the migration and catch-up.
- `isConfigured()` no longer requires a password: a store can always be created.
- `package.json` `engines` rises to `>=22.13` for development and CI. The launcher covers users' sessions.

### Scripts

| script | after this |
| --- | --- |
| `memory-cli.mjs`, `statusline.mjs`, `token-cost.mjs` | Unchanged apart from lifecycle calls; they use `graph.js`. `memory-cli` gains `dupes` and `start-fresh`. |
| `backfill-subsystems.mjs`, `migrate-from-claude-mem.mjs`, `memory-usage.sh`, `telemetry-report.mjs` | Ported from Cypher to SQLite. |
| `backup.sh`, `restore.sh`, `check-health.sh` | Rewritten for SQLite. Backup is an online `VACUUM INTO` to `backups/memory-<UTC stamp>.sqlite`, mode `0600`. Restore checks integrity and refuses while memory processes run. The health check covers file, schema version, integrity and the launcher's Node. |
| `setup-local.sh`, `configure.mjs`, `lib-engine.sh`, `lib-backup.sh`, `migrate-to-podman.sh`, `fingerprint.sh`, `cypher.sh`, `docker/` | Legacy: kept as the way to start and reach Neo4j until it is retired, and labelled so in their headers and the README. |
| `migrate-to-sqlite.mjs` | Kept; the first-start worker runs it. |

### Docs

The README describes the SQLite engine, the launcher, first start, backup and restore, and `dupes`. Neo4j is described as legacy.
The CHANGELOG gets an entry, and the memory engine's `CLAUDE.md` is updated where it describes Neo4j behaviour.

## Failure handling

| failure | behaviour |
| --- | --- |
| No suitable Node | Hooks exit 0 with a one-line message; the memory server fails visibly with the same line. |
| `memory.sqlite` unreadable, wrong schema version, or failing integrity | Memory off, with the reason at session start. Nothing is deleted or recreated automatically. |
| Migration running | Tools and captures report "moving to SQLite"; captures are retried by the existing sweep. |
| Migration failed | Memory off; the reason, log path and retry command are shown. The staged file and report are kept. |
| Neo4j unreachable on first start | Memory off; the message names both ways forward. |
| Neo4j unreachable during catch-up | The catch-up is skipped quietly and retried at the next session start inside the 7 days. |
| Database busy | WAL plus a 5 s busy timeout. Measured: 8 processes doing 200 capture-sized writes each at once had no errors. |
| Several processes open a new store at once | One creates the schema and the rest reuse it. Switching a new file to WAL takes a lock that ignores the busy timeout, so the open retries it for up to 5 s. |

## Testing

All tests use temporary SQLite files; no test touches the live store or Neo4j, except `search-parity` and the gated migration rehearsal.

**Part A**:

- The four `graph-*.test.js` files run against a temporary store, so they no longer write test rows into the live graph.
- Search: ranking and the five matched observations with top-up; project and subsystem filters; recency decay; the cross-project fallback; Lucene-sensitive names such as `feature:capture-visibility` found by name.
- Fix 1: `"out"`, `"in"` and `"self"` in search results.
- Fix 2: 0.8 collapses and keeps the newest; the 0.73 ticket pair does not collapse; `total` and `collapsed` are right; `dupes` lists pairs at or above `--min`, most similar first.
- Upgrade: a version-1 file opens as version 2 with both full-text tables filled.
- Every other function: scope, ties, prune, timeline counts, deletes cascading, and budgets.

**Part B**:

- The launcher (bash tests with fake `node` binaries): `PATH` qualifies; `PATH` too old and nvm has one; nothing qualifies; the override.
- First start: each row of the state table, with the migration worker stubbed. A failed check never becomes `memory.sqlite`. A stale lock is reclaimed.
- Catch-up: rows created after the switch are copied; rows deleted in SQLite stay deleted; Neo4j-side updates are ignored; nothing runs after 7 days.
- Ported scripts: each against a fixture store.

**Acceptance on this machine**:

1. Install the new version, start a session, and watch the first-start migration move the live graph and pass its check.
2. Run `npm run search-parity` and meet the search acceptance above.
3. Confirm session start shows collapsed standing facts and `dupes` lists this project's three reworded repeats.

**CI**: the tests need Node 22.13 or later. The PR pipeline's first run shows whether the `cicd:default-22` image qualifies; if it does not, its Node is upgraded before merge.

## Out of scope

- Relation-label sprawl and capture over-recording.
- Retiring Neo4j: removing `neo4j-driver`, `neo4jClient.js`, `schema.js` and the legacy scripts, once teammates have switched.
- Renaming the MCP server or `~/.claude-neo4j`.
- Shared or remote memory. If someone needs it, Postgres is the candidate, as the comparison found.
- Moving SQLite writes back into Neo4j.
