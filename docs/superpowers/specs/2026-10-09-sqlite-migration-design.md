# Migrate the memory graph from Neo4j to SQLite

**Status**: implemented on `feat/memory-sqlite-migration`; acceptance on the live graph passed (2026-10-09)
**Date**: 2026-10-09

Copy every entity, observation, relation and session from Neo4j into a SQLite file, and prove the copy is complete before anything switches to it.

This is the first of four pieces that move the memory engine off Neo4j:

1. **Schema, migration and verification** (this spec).
2. The engine rewritten on SQLite: `graph.js` and its callers.
3. Search ported to SQLite FTS5: UAX #29 tokenization and recalibrated relevance thresholds.
4. Rollout: the config switch, retiring the container scripts, and moving teammates over.

The schema defined here is the contract piece 2 builds on.

## Why

The engine uses none of Neo4j's graph capabilities.
No query traverses more than one relationship.
`ABOUT` works as a parent key, `PRODUCED` is never read, and `RELATES_TO` is read only as a one-hop neighbour list.
Of the 52 `memory_get_entity` calls in two months of transcripts, 41 targeted an entity already in the preceding search results or one hop from them, one targeted an entity two hops away, and the other ten were not within four hops or no longer exist.

SQLite reproduces the part that matters, search.
Replaying 214 logged `memory_search` queries against an FTS5 copy of the live graph, with documents and queries segmented by UAX #29 the way Lucene's standard analyzer does, gave the same top result on 196 of 200 queries, a mean top-5 overlap of 0.967, and agreement on all 14 empty results.

Neo4j's cost is measurable:

- A ~650 MB JVM inside a Podman VM.
- Community-edition backups that stop the container.
- About 1,700 lines of shell to set up, migrate, back up, restore and health-check it.
- 21 auto-captures that failed on five days because it was unreachable (all later retried successfully).
- A network listener, which on 2026-10-08 was reachable from the LAN.

SQLite runs in-process through `node:sqlite`, which is built into Node.
The parity copy of the whole graph, search indexes included, is 9.5 MB.
Eight processes each writing 200 capture-sized transactions at once produced no errors, and the slowest transaction, including its wait for the write lock, took 364 ms.

## Decisions

| question | decision |
| --- | --- |
| What is migrated | **Everything**: every node, relationship and property. `PRODUCED` is rebuilt from `Observation.sessionId` rather than stored, because the two agree on all 10,224 edges. `Observation.source`, which `migrate-claude-mem` sets on everything it imports, gets its own column although the live graph holds none. An inventory of labels, relationship shapes and property keys stops the run if the graph holds anything else, so a PASS cannot hide a property the copy left behind. |
| Cleanup during migration | **None.** Deduplicating standing facts and normalising relation labels happen later, against SQLite, so verification stays a one-to-one comparison. |
| Mechanism | **Direct copy.** A Node script reads Neo4j through the plugin's own driver connection and writes SQLite with `node:sqlite`. No dump and no container stop, so it works for local and remote sources alike. |
| Writes during the migration | **Supported.** The graph is read twice and the reads must match, otherwise it reads again. Rows are inserted only when missing, so a later run copies writes that landed after an earlier run. Re-running is for catching up **before** the engine switches; see "Re-runs after the switch". |
| Updates and deletes in Neo4j after a copy | **Reported, never applied.** |
| The Neo4j source | **Read-only.** Never modified, never deleted. |
| Plugin config | **Unchanged** by this piece. Switching engines is rollout. |
| Target file | `~/.claude-neo4j/memory.sqlite`, mode `0600`. Renaming the folder is a rollout question. |
| Search index | **Not created here.** FTS5 tables are derived data, built by the engine in piece 3. |
| Timestamps | `INTEGER` milliseconds since the Unix epoch, UTC. |
| Global entities | `project = ''` instead of `NULL`. |
| Runtime | Node with `node:sqlite` (22.5 or later), checked at start. |

## What the live graph holds

Measured on 2026-10-09; the graph grows every day.

| element | count | properties (present on) |
| --- | --- | --- |
| `Entity` | 3,768 | `name`, `project`, `createdAt` (all); `type` (3,654); `updatedAt` (2,921) |
| `Observation` | 11,861 | `id`, `text`, `createdAt` (all); `sessionId` (10,651); `subsystem` (8,061) |
| `Session` | 1,585 | `id`, `cwd`, `project`, `startedAt` (all) |
| `ABOUT` | 11,861 | none; exactly one per observation |
| `RELATES_TO` | 3,732 | `type` (all); `createdAt` (3,727) |
| `PRODUCED` | 10,224 | none; always matches `Observation.sessionId` |

Cases the migration must carry and the tests must cover:

- 29 `RELATES_TO` edges whose two ends are the same entity.
- 107 entities with no observations, created by `createRelation`.
- 114 entities without a `type`, and 5 relations without a `createdAt`.
- 427 observations whose `sessionId` has no `Session` node, so `session_id` cannot be a foreign key.
- 16 observations with characters outside the Basic Multilingual Plane.
- All 23,862 temporal values are zoned datetimes in UTC with millisecond precision, so integer milliseconds lose nothing. `toString()` drops trailing zeros on 2,295 of them (`.78Z`), so storing those strings would sort them wrongly.
- 9,882 observations share an exact `createdAt` with another observation of the same entity, because a write batch gets one timestamp. "Newest first" has ties.
- No duplicate `(from, to, type)` relations, no observation without exactly one `ABOUT`, no entity with a null `project`.

## Schema

```sql
PRAGMA user_version = 1;

CREATE TABLE entities (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  project     TEXT    NOT NULL,      -- '' = global
  type        TEXT,
  created_at  INTEGER NOT NULL,      -- epoch ms, UTC
  updated_at  INTEGER,
  UNIQUE (name, project)
);

CREATE TABLE observations (
  id          TEXT    NOT NULL PRIMARY KEY,   -- the existing UUID
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  subsystem   TEXT,
  source      TEXT,                  -- 'claude-mem' on observations that importer created
  session_id  TEXT,                  -- no foreign key: 427 point at missing sessions
  created_at  INTEGER NOT NULL
);
CREATE INDEX observations_by_entity    ON observations(entity_id, created_at);
CREATE INDEX observations_by_time      ON observations(created_at);
CREATE INDEX observations_by_subsystem ON observations(subsystem);

CREATE TABLE relations (
  from_id     INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id       INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,
  created_at  INTEGER,
  PRIMARY KEY (from_id, to_id, type)
) WITHOUT ROWID;
CREATE INDEX relations_by_target ON relations(to_id);

CREATE TABLE sessions (
  id          TEXT    NOT NULL PRIMARY KEY,
  cwd         TEXT,
  project     TEXT,
  started_at  INTEGER NOT NULL
);

CREATE TABLE migrations (
  id          INTEGER PRIMARY KEY,
  source      TEXT    NOT NULL,      -- connection URI without credentials
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  counts      TEXT,                  -- JSON: source/inserted/missing/changed/extra per table
  result      TEXT                   -- 'passed' or 'failed'
);
```

How the graph maps onto it:

- `ABOUT` becomes `observations.entity_id`.
- `PRODUCED` is derived: `observations JOIN sessions ON sessions.id = observations.session_id`.
- Neo4j's composite uniqueness constraint on `(name, project)` becomes `UNIQUE (name, project)`. Storing global entities as `''` removes the null special-casing that every project-scoped query in `graph.js` spells out.
- `DETACH DELETE` becomes `ON DELETE CASCADE`. Every connection sets `PRAGMA foreign_keys = ON`, `journal_mode = WAL` and a `busy_timeout`.
- Observations are inserted in `createdAt` order, then Neo4j's internal node id, which is the numeric suffix of `elementId`. From then on `rowid` breaks ties in "newest first" deterministically.
- `observations` keeps its implicit `rowid` (it is not `WITHOUT ROWID`) because the FTS5 index in piece 3 keys on it.
- The two `TEXT` primary keys are `NOT NULL` explicitly: SQLite, unlike other databases, otherwise accepts any number of NULL keys in them.

## Components

Each unit has one job.
Only the reader touches Neo4j, so everything else is testable without it.

| unit | job | depends on |
| --- | --- | --- |
| `src/lib/sqliteDb.js` | The DDL above, `openMemoryDb(path, { readOnly })` with the pragmas, schema creation when the file is new, and `integrityReport(db)` (integrity check, foreign-key check, `user_version`). Shared with piece 2. | `node:sqlite` |
| `src/lib/migrate/readNeo4j.js` | `readGraph(session)` returns plain records `{ entities, observations, relations, sessions, sessionLinks }`, with timestamps as epoch ms and global projects as `''`, plus `unmapped`: whatever an inventory of labels, relationship shapes and property keys finds outside `MAPPED`. | `neo4jClient.js` |
| `src/lib/migrate/readSqlite.js` | `readSqliteGraph(db)` returns the same record shape from a SQLite file, deriving `sessionLinks` from the join. | `sqliteDb.js` |
| `src/lib/migrate/fingerprint.js` | `fingerprint(records)` returns per-type counts plus a SHA-256 over sorted canonical rows. `readConsistentGraph(readOnce)` uses it to confirm two Neo4j reads match. | `node:crypto` |
| `src/lib/migrate/writeSqlite.js` | `validateRecords(records)` lists anything SQLite cannot represent. `writeGraph(db, records)` inserts missing rows in one transaction and returns inserted and skipped counts per type. Observations and relations resolve their entity ids through the entity's natural key. | `sqliteDb.js` |
| `src/lib/migrate/compareGraph.js` | `compareGraph(source, target)` takes two record sets and returns missing, changed and extra rows per type, the session-link comparison, per-project counts, and `ok`. Pure: no database handle. | none |
| `src/lib/migrate/runMigration.js` | `runMigration({ readOnce, out, checkOnly, reportPath, sourceLabel })`: read retries, validation, the temp-file rename or top-up, the check, the run log, the report, the summary, and the exit code. Testable with a fake `readOnce`. | all of the above |
| `src/lib/migrate/cli.js` | `parseArgs(argv, { cwd, defaultOut })` and `withoutCredentials(uri)`. | `node:path` |
| `scripts/migrate-to-sqlite.mjs` | Thin wiring: flags, the `node:sqlite` check, the Neo4j connection, then `runMigration`. Run as `npm run migrate-to-sqlite`. | `cli.js`, `runMigration.js`, `readNeo4j.js` |

Records are keyed by natural keys, never by Neo4j or SQLite ids:

| record | key |
| --- | --- |
| entity | `(name, project)` |
| observation | `id` |
| relation | `(from name, from project, type, to name, to project)` |
| session | `id` |
| session link | `(session id, observation id)` |

A canonical row is the record's fields in a fixed order, serialised with `JSON.stringify`.
That keeps `null` distinct from `''` and escapes tabs, newlines and control characters without a custom scheme.
`fingerprint.sh` stays as it is for the Podman tooling.
The new fingerprint is a superset of it: it adds timestamps, `updatedAt`, `sessionId` and session fields.

## Data flow

```text
migrate-to-sqlite [--out PATH] [--check-only] [--report PATH]
```

1. Check that `node:sqlite` loads, connect with the plugin's config, and refuse to continue if Neo4j is unreachable or the login fails. Warn when the config's `mode` is `remote`, because a SQLite file serves one machine. Relative `--out` and `--report` paths resolve against the directory the command was typed in (`INIT_CWD` under `npm run`), not npm's package root, which is a git working tree. The connection URI is printed and logged without any `user:password@` part.
2. Read the whole graph twice, back to back, in read-only sessions, each with an inventory of labels, relationship shapes and property keys. If the two fingerprints match, the second read is the snapshot. If they differ, a write landed in between; read again, up to five attempts in total, then stop and say the graph would not hold still. Then validate the snapshot: anything the inventory finds outside the mapping, duplicate natural keys, an observation without exactly one entity, a relation end that is not an entity, or a missing required field stop the run before anything is written.
3. Without `--check-only`, write:
   - **No file at `--out`**: refuse if `memory.sqlite-wal` or `-shm` is still there without its database, because SQLite would replay that WAL into the new file. Otherwise create `memory.sqlite.tmp` beside it, apply the schema, insert everything, close it, then rename it into place.
   - **File exists**: open it and, in one `BEGIN IMMEDIATE` transaction, insert only rows whose natural key is missing. Existing rows are never updated. A file at schema version 0 that already holds tables is someone else's database and is refused untouched. Opening for writing resets the mode to `0600`.
4. Read the file back with `readSqliteGraph` and compare it against the snapshot (see Verification). Print the summary and write the full report, by default to `migration-report-<UTC timestamp>.json` beside the database. Append a row to `migrations`, except under `--check-only`, which writes nothing to the database (the report is still written).

Runs are idempotent.
A second run against an unchanged graph inserts nothing and passes.
`BEGIN IMMEDIATE` with the busy timeout makes a run wait its turn behind any other writer.

### Re-runs after the switch

Re-running is safe only while nothing but this migration writes the SQLite file.
Once the engine runs on SQLite, every top-up compares SQLite against the whole Neo4j snapshot, and that misbehaves in two ways:

- A row the new engine deleted (`memory_delete_entity`, `memory_delete_observations`, `memory_prune`) is missing from SQLite, so a top-up re-inserts it from Neo4j and passes.
- An entity the new engine touched has a newer `updatedAt`, so it reports as changed and every later run exits `1`, burying real failures.

Catching up after the switch therefore belongs to piece 4. That means either copying only Neo4j rows created after the cut-over (`migrations.started_at`), or refusing top-ups once the engine has switched.

## Verification

The check answers one question: does every row in Neo4j exist in SQLite with identical fields?

| rows | compared on |
| --- | --- |
| entities | `name`, `project`, `type`, `created_at`, `updated_at` |
| observations | `id`, owning entity key, `text` (exact string equality; see below), `subsystem`, `session_id`, `created_at` |
| relations | both end keys, `type`, `created_at` |
| sessions | `id`, `cwd`, `project`, `started_at` |
| session links | the set of `(session id, observation id)` pairs from `PRODUCED` against the SQLite join |

Each key lands in one of three outcomes:

- **Missing**: present in Neo4j, absent from SQLite. Fails the check.
- **Changed**: present in both, with any field different. Fails the check.
- **Extra**: present only in SQLite. Reported, but does not fail the check, because after rollout these are new writes or Neo4j-side deletes.

One text exception is unavoidable.
`truncateText` cuts strings by UTF-16 code unit, so an emoji at the cut leaves an unpaired surrogate, and UTF-8 cannot store one.
The writer stores such text with U+FFFD in its place, the check compares both sides in that well-formed form, and the summary counts how many texts were affected.
None exist in the live graph today.

The SQLite file must also pass `PRAGMA integrity_check`, return no rows from `PRAGMA foreign_key_check`, and report `user_version = 1`.
The report lists entity and observation counts per project on both sides.

The summary looks like this:

```text
Neo4j   bolt://localhost:7687 (local)          2 reads, consistent
SQLite  ~/.claude-neo4j/memory.sqlite          new file

                source  inserted  missing  changed  extra
entities         3,768     3,768        0        0      0
observations    11,861    11,861        0        0      0
relations        3,732     3,732        0        0      0
sessions         1,585     1,585        0        0      0
session links   10,224         -        0        -      0

integrity ok   foreign keys ok   per-project counts match (31 projects)
PASS   report: ~/.claude-neo4j/migration-report-2026-10-09T150412Z.json
```

On failure, up to 20 examples of each kind are printed with their keys.
The full diff goes to the report file, mode `0600` like the database, since it quotes observation text.

Exit codes:

| code | meaning |
| --- | --- |
| `0` | Nothing missing or changed. |
| `1` | The check found missing or changed rows. The file is kept for inspection. |
| `2` | The migration could not run: connection, login, Node version, file access, a source graph that fails validation, or no consistent read after five attempts. Nothing was written, or the temp file was removed. |

## Failure handling

| failure | behaviour |
| --- | --- |
| Neo4j unreachable or login fails | Exit `2` before writing anything. |
| Graph changes on every read | Exit `2` after five attempts, suggesting a quieter moment. |
| `node:sqlite` unavailable | Exit `2`, naming the Node version found and the one needed. |
| Source graph fails validation | Exit `2` before writing, listing up to 20 problems. A teammate's graph can hold shapes this one does not, such as two global entities with one name, which Neo4j's constraint ignores. |
| A timestamp that is not a zoned datetime | Exit `2`, naming the element. Nothing is guessed. |
| A label, relationship shape or property outside the mapping | Exit `2` before writing, naming it with its count, e.g. `Observation.mood on 2 node(s) is not migrated`. |
| `memory.sqlite-wal` or `-shm` left without its database | Exit `2` before writing; the file is kept, since it may hold unsaved writes. |
| `--out` names an existing database that is not a memory store | Exit `2`; that database is not modified, not even its journal mode. |
| Error while building a new file | Delete `memory.sqlite.tmp`. The target path is never left half-written. |
| Error while topping up an existing file | The transaction rolls back and the file is unchanged. |
| Check fails | Exit `1`. Keep the file and the report. Change nothing else. |
| Interrupted mid-run | First run: only the temp file can exist, and the next run replaces it. Later runs: the open transaction never commits. |

Neo4j, its container, its backups and the plugin config are never touched.

## Testing

Tests are written first and run under `node --test`, like the existing `tests/*.test.js`.

**Unit tests** need no Neo4j.
They use fixture records that include every case listed under "What the live graph holds".

- A timestamp Neo4j prints as `.78Z` round-trips as 780 ms.
- An entity with no observations, a self-referencing relation, a relation without `createdAt` and an observation pointing at a missing session all survive a copy and pass the check.
- Text containing tabs, newlines and astral-plane characters compares equal after a round trip.
- Same-millisecond observations are inserted in Neo4j creation order, so `rowid` order matches it.
- A second `writeGraph` with the same records inserts nothing.
- A record whose entity `type` changed is reported as changed, and the stored value is not overwritten.
- A row deleted from the records after a copy is reported as extra and does not fail the check.
- `PRODUCED` pairs are rebuilt exactly, including when the session is missing.

**Checker sabotage tests** copy a fixture, corrupt one field in the copy, and assert that the check fails and names that row.
There is one test per compared field: entity type and timestamps, observation text, owning entity, subsystem, session id and timestamp, relation type and endpoints, session fields, and a dropped session link.
These prove the checker cannot pass vacuously.

**CLI tests** cover exit codes `0`, `1` and `2`, no `.tmp` file surviving a failed first run, and mode `0600` on the database and the report.

**Rehearsal** runs against a disposable Neo4j on port 7688, the pattern `migrate-to-podman.sh` used.
The test seeds the fixture graph through Cypher.
It is skipped unless `CLAUDE_NEO4J_REHEARSAL_URI` is set, so neither `npm test` nor `test:ci` runs it by accident, and it refuses port 7687, where the real graph listens.
It covers four scenarios:

- A full copy that passes.
- A writer looping during the read, which forces the retry path.
- Observations added after a copy, which a second run inserts.
- An entity updated and an observation deleted after a copy, which are reported as changed and extra.

**Acceptance** runs on the real graph, read-only, writing to a scratch `--out` path.
It must report nothing missing or changed, per-project counts must match, and a second run must insert nothing.

## Out of scope

- The engine on SQLite, the read-path equivalence tests against Neo4j, and the tie-breaking that read paths rely on: piece 2.
- FTS5 tables, UAX #29 segmentation, and recalibrating `WEAK_SCORE` and `MULTI_WORD_MIN_SCORE`: piece 3.
- Config `mode`, renaming `~/.claude-neo4j`, retiring the container scripts, whether the engine migrates automatically or refuses to start until migrated, catching up on Neo4j writes after the switch (see "Re-runs after the switch"), and instructions for teammates: piece 4.
- Data cleanup, such as duplicate standing facts, the 886 free-text relation labels, and edge direction in search output: separate changes against SQLite.
- A Postgres target. That is revisited only if someone needs memory shared across machines.
- Migrating back from SQLite to Neo4j. Neo4j stays untouched as the rollback until rollout retires it.
