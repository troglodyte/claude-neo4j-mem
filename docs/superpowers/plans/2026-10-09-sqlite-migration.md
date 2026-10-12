# Neo4j to SQLite Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `npm run migrate-to-sqlite` command that copies every entity, observation, relation and session from the Neo4j memory graph into `~/.claude-neo4j/memory.sqlite` and proves, row by row, that nothing was lost.

**Architecture:** Plain records keyed by natural keys sit between the two databases. Only `readNeo4j.js` touches Neo4j. The writer, the SQLite reader, the comparator and the run orchestrator all take records, so every behaviour except the Cypher itself is tested without Neo4j. A thin CLI wires the Neo4j reader into `runMigration`.

**Tech Stack:** Node ESM, `node:sqlite` (`DatabaseSync`, Node 22.5+), `neo4j-driver` (already a dependency), `node:test` with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-09-sqlite-migration-design.md`

## Global Constraints

- Node with `node:sqlite` (22.5 or later), checked at CLI start. Exit `2` names the Node version found. The plugin's `engines` floor (`>=18.17`) is not changed, so only the migration's modules import `node:sqlite`.
- No new npm dependencies. ESM only. Builtins use the `node:` prefix.
- Source files in `src/lib/` are camelCase (`sqliteDb.js`). Tests are kebab-case `tests/*.test.js` and run with `node --test`.
- Neo4j is read-only. Read only inside `session.executeRead`, never stop or modify the container, and never change `~/.claude-neo4j/config.json`.
- Default target `~/.claude-neo4j/memory.sqlite` (`CONFIG_DIR` from `src/lib/config.js`). The database and the report are mode `0600`. Directories the migration creates are `0700`.
- Timestamps are `INTEGER` epoch milliseconds, UTC. A global entity's project is `''`.
- The schema is exactly the spec's DDL, with `PRAGMA user_version = 1`. Every connection sets `foreign_keys = ON` and `busy_timeout = 5000`, and writable connections set `journal_mode = WAL`.
- No FTS5 tables (piece 3).
- At most five fingerprint comparisons (six reads) for a consistent read.
- Exit codes: `0` nothing missing or changed; `1` the check found missing or changed rows; `2` the migration could not run.
- Tests that need Neo4j are gated by `CLAUDE_NEO4J_REHEARSAL_URI` and refuse port 7687.
- Commits follow the commit convention: `type(scope): Capitalised subject`, plus a `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.

## Review Focus

1. **An observation text with an unpaired UTF-16 surrogate.** `truncateText` slices by code unit, so an emoji at the cut leaves half a pair. The migration should pass, store U+FFFD in its place, and report how many texts were affected. Tests: Task 3 ("text with an unpaired surrogate is stored in its well-formed form") and Task 5 ("an unpaired surrogate is counted and not reported as a change").
2. **A stale `memory.sqlite.tmp` left by a killed run.** The next run should replace it and succeed. Test: Task 8 ("a temp file left by an interrupted run is replaced").
3. **`--out` pointing into a directory that doesn't exist yet**, such as a fresh machine with no `~/.claude-neo4j`, or a scratch path. The directory should be created `0700` and the run should succeed. Tests: Task 1 ("a new file gets the schema, version 1 and mode 0600", which uses a nested path) and Task 8 ("a target directory that does not exist yet is created").
4. **The target file is busy** because another process holds the write lock, for example the new engine or a `sqlite3` shell. A top-up should wait (busy timeout) instead of failing. Test: Task 8 ("a top-up waits for another process's write instead of failing").
5. **A teammate's graph has shapes this one lacks**, such as:
   - two global entities with one name (Neo4j's constraint ignores a null project)
   - an observation with zero or two `ABOUT` edges
   - a local-datetime or string timestamp
   - sub-millisecond precision

   It should exit `2` before writing, naming each offending element, rather than crash on a raw SQLite or type error. Tests: Task 3 (validation), Task 7 (`toEpochMs` refusals) and Task 8 ("a source graph SQLite cannot represent exits 2 before writing").

---

## File Structure

| file | responsibility |
| --- | --- |
| `src/lib/sqliteDb.js` | The schema, `openMemoryDb`, `integrityReport`. Shared with the future SQLite engine. |
| `src/lib/migrate/fingerprint.js` | Record shapes, field and key lists, canonical rows, `fingerprint`, `readConsistentGraph`. |
| `src/lib/migrate/writeSqlite.js` | `validateRecords`, `writeGraph` (insert-if-missing in one transaction). |
| `src/lib/migrate/readSqlite.js` | `readSqliteGraph`: a SQLite file back as records. |
| `src/lib/migrate/compareGraph.js` | `compareGraph`: missing, changed and extra rows per type, plus per-project counts. |
| `src/lib/migrate/readNeo4j.js` | `readGraph(session)`, `toRecords`, `toEpochMs`. The only Neo4j-aware unit. |
| `src/lib/migrate/runMigration.js` | `runMigration`, `formatSummary`, `EXIT`: one run, end to end. |
| `scripts/migrate-to-sqlite.mjs` | The CLI: flags, the `node:sqlite` check, the Neo4j connection, then `runMigration`. |
| `tests/helpers/graphFixture.js` | One fixture graph holding every shape found in the live graph. |
| `tests/sqlite-db.test.js` and `tests/migrate-*.test.js` | One test file per unit, plus `migrate-sabotage`, `migrate-cli` and the gated `migrate-rehearsal`. |

All paths in this plan were relative to the plugin folder of the repo it was first written in; here they are relative to the repo root.

## Before you start

- [ ] **Rename the branch and check the baseline**

```bash
cd <worktree>
git branch -m docs/memory-sqlite-migration-spec feat/memory-sqlite-migration
cd <plugin folder>
node --version
ls node_modules/neo4j-driver/package.json
node --test tests/*.test.js
```

Expected: Node `v22.5.0` or later, `neo4j-driver` present, and `# pass 114` / `# fail 0`.
The `graph-*.test.js` files need the local Neo4j running.
`bash tests/engine-resolve.test.sh` already fails one check on unchanged `main` ("setup-local.sh did not invoke sudo apt-get after an interactive (pty) accept"). That check is out of scope; confirm it is still the only failure at the end.

---

### Task 1: SQLite schema module

**Files:**
- Create: `src/lib/sqliteDb.js`
- Test: `tests/sqlite-db.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SCHEMA_VERSION: 1`
  - `openMemoryDb(file: string, { readOnly?: boolean } = {}): DatabaseSync`
  - `integrityReport(db: DatabaseSync): { integrity: string[], foreignKeyViolations: number, userVersion: number, ok: boolean }`

- [ ] **Step 1: Write the failing tests**

`tests/sqlite-db.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryDb, integrityReport, SCHEMA_VERSION } from "../src/lib/sqliteDb.js";

// A path inside a directory that does not exist yet, as on a fresh machine.
function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-db-"));
  return path.join(dir, "nested", "memory.sqlite");
}

const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test("a new file gets the schema, version 1 and mode 0600", () => {
  const file = tempFile();
  const db = openMemoryDb(file);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["entities", "migrations", "observations", "relations", "sessions"]);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  db.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test("reopening an existing file keeps its data", () => {
  const file = tempFile();
  const db = openMemoryDb(file);
  db.prepare("INSERT INTO entities (name, project, created_at) VALUES ('a', '', 1)").run();
  db.close();
  const again = openMemoryDb(file);
  assert.equal(count(again, "entities"), 1);
  again.close();
});

test("deleting an entity removes its observations and relations", () => {
  const db = openMemoryDb(tempFile());
  db.exec(`
    INSERT INTO entities (id, name, project, created_at) VALUES (1, 'a', 'p', 1), (2, 'b', 'p', 1);
    INSERT INTO observations (id, entity_id, text, created_at) VALUES ('o1', 1, 'x', 1);
    INSERT INTO relations (from_id, to_id, type) VALUES (1, 2, 'uses'), (2, 1, 'used-by');
  `);
  db.prepare("DELETE FROM entities WHERE id = 1").run();
  assert.equal(count(db, "observations"), 0);
  assert.equal(count(db, "relations"), 0);
  db.close();
});

test("an entity name is unique within a project, including the global one", () => {
  const db = openMemoryDb(tempFile());
  db.exec("INSERT INTO entities (name, project, created_at) VALUES ('user', 'p1', 1), ('user', 'p2', 1), ('user', '', 1)");
  assert.throws(
    () => db.exec("INSERT INTO entities (name, project, created_at) VALUES ('user', '', 2)"),
    /UNIQUE constraint failed/
  );
  db.close();
});

test("a read-only handle refuses writes", () => {
  const file = tempFile();
  openMemoryDb(file).close();
  const db = openMemoryDb(file, { readOnly: true });
  assert.throws(() => db.exec("INSERT INTO entities (name, project, created_at) VALUES ('a', '', 1)"), /readonly/);
  db.close();
});

test("a file with an unknown schema version is refused", () => {
  const file = tempFile();
  const db = openMemoryDb(file);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => openMemoryDb(file), /schema version 99/);
});

test("integrityReport passes a fresh file and counts foreign-key violations", () => {
  const db = openMemoryDb(tempFile());
  assert.equal(integrityReport(db).ok, true);
  db.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO observations (id, entity_id, text, created_at) VALUES ('orphan', 42, 'x', 1);
    PRAGMA foreign_keys = ON;
  `);
  const report = integrityReport(db);
  assert.equal(report.foreignKeyViolations, 1);
  assert.equal(report.ok, false);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/sqlite-db.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/sqliteDb.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/sqliteDb.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// The SQLite memory store's schema: the contract the SQLite engine builds on.
// See docs/superpowers/specs/2026-10-09-sqlite-migration-design.md ("Schema").
export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE entities (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  project     TEXT    NOT NULL,
  type        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER,
  UNIQUE (name, project)
);
CREATE TABLE observations (
  id          TEXT    PRIMARY KEY,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  subsystem   TEXT,
  session_id  TEXT,
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
  id          TEXT    PRIMARY KEY,
  cwd         TEXT,
  project     TEXT,
  started_at  INTEGER NOT NULL
);
CREATE TABLE migrations (
  id          INTEGER PRIMARY KEY,
  source      TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  counts      TEXT,
  result      TEXT
);
`;

/**
 * Opens the memory database, creating it and its schema on first open. A new
 * file is created 0600 before SQLite touches it, inside a 0700 directory if one
 * has to be made, so memory text is never readable by other users, not even
 * briefly.
 */
export function openMemoryDb(file, { readOnly = false } = {}) {
  if (!readOnly && !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(file, "wx", 0o600));
  }
  const db = new DatabaseSync(file, { readOnly });
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (!readOnly) db.exec("PRAGMA journal_mode = WAL;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  if (version === 0 && !readOnly) {
    db.exec(`BEGIN; ${SCHEMA_SQL} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  } else if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`${file} has schema version ${version}; this code expects ${SCHEMA_VERSION}`);
  }
  return db;
}

/** SQLite's own consistency checks, summarised: what the migration's verdict requires besides the row check. */
export function integrityReport(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  const { user_version: userVersion } = db.prepare("PRAGMA user_version").get();
  const ok =
    integrity.length === 1 && integrity[0] === "ok" && foreignKeyViolations === 0 && userVersion === SCHEMA_VERSION;
  return { integrity, foreignKeyViolations, userVersion, ok };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/sqlite-db.test.js`
Expected: PASS, 7 tests. An `ExperimentalWarning` about SQLite on stderr is expected on Node 22.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sqliteDb.js tests/sqlite-db.test.js
git commit -m "feat(memory): Add the SQLite memory schema" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Records, fingerprints and the consistent read

**Files:**
- Create: `src/lib/migrate/fingerprint.js`
- Create: `tests/helpers/graphFixture.js`
- Test: `tests/migrate-fingerprint.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `RECORD_TYPES: ["entities", "observations", "relations", "sessions", "sessionLinks"]`
  - `FIELDS`, `KEY_FIELDS`: per-type field lists
  - `keyOf(type, record): string`
  - `normaliseField(field, value): unknown`
  - `canonicalRow(type, record): string`
  - `fingerprint(records): { counts: Record<type, number>, hashes: Record<type, string> }`
  - `readConsistentGraph(readOnce: () => Promise<GraphRecords>, { maxAttempts = 5 } = {}): Promise<{ consistent: boolean, records: GraphRecords | null, reads: number }>`
  - Test helper: `fixtureRecords(): GraphRecords` (a fresh copy on every call), `FIXTURE_PROJECT`, `FIXTURE_TIME`

- [ ] **Step 1: Write the fixture**

`tests/helpers/graphFixture.js`:

```js
// One graph holding every shape the live graph was found to contain (spec:
// "What the live graph holds"), as plain migration records. A fresh copy on
// every call, so a test may mutate what it gets.
export const FIXTURE_PROJECT = "github.com/acme/app";
const OTHER = "github.com/acme/other";

// Neo4j prints this instant as 2026-07-22T13:32:22.78Z: a dropped trailing zero.
export const FIXTURE_TIME = Date.UTC(2026, 6, 22, 13, 32, 22, 780);
const T = FIXTURE_TIME;
const P = FIXTURE_PROJECT;

export function fixtureRecords() {
  return {
    entities: [
      { name: "decision:storage-layout", project: P, type: "decision", createdAt: T, updatedAt: T + 86_400_000 },
      { name: "ticket:APP-1", project: P, type: null, createdAt: T + 1, updatedAt: null },
      // No observations: created by a relation alone.
      { name: "service:billing", project: P, type: "service", createdAt: T + 2, updatedAt: null },
      // Global entity.
      { name: "user", project: "", type: "person", createdAt: T + 3, updatedAt: null },
      // Same name, different project.
      { name: "decision:storage-layout", project: OTHER, type: "decision", createdAt: T + 4, updatedAt: null },
    ],
    sessions: [
      { id: "sess-1", cwd: "/repo", project: P, startedAt: T - 60_000 },
      { id: "sess-2", cwd: null, project: null, startedAt: T - 30_000 },
    ],
    observations: [
      // obs-1..3 share one timestamp, as a write batch does.
      { id: "obs-1", entityName: "decision:storage-layout", entityProject: P, text: "line one\tcol\nline two", subsystem: "storage", sessionId: "sess-1", createdAt: T, seq: 101 },
      { id: "obs-2", entityName: "decision:storage-layout", entityProject: P, text: "second in the batch", subsystem: null, sessionId: "sess-1", createdAt: T, seq: 102 },
      { id: "obs-3", entityName: "decision:storage-layout", entityProject: P, text: "third in the batch", subsystem: "storage", sessionId: "sess-1", createdAt: T, seq: 103 },
      // A session id with no Session node; an astral-plane character.
      { id: "obs-4", entityName: "ticket:APP-1", entityProject: P, text: "deploy 🚀 done", subsystem: "deploy", sessionId: "sess-missing", createdAt: T + 10, seq: 104 },
      { id: "obs-5", entityName: "user", entityProject: "", text: "prefers pnpm", subsystem: null, sessionId: null, createdAt: T + 20, seq: 105 },
      { id: "obs-6", entityName: "decision:storage-layout", entityProject: OTHER, text: 'path C:\\temp and "quotes"', subsystem: null, sessionId: "sess-2", createdAt: T + 30, seq: 106 },
    ],
    relations: [
      { fromName: "decision:storage-layout", fromProject: P, type: "implements", toName: "ticket:APP-1", toProject: P, createdAt: T + 5 },
      // No createdAt.
      { fromName: "ticket:APP-1", fromProject: P, type: "depends-on", toName: "service:billing", toProject: P, createdAt: null },
      // Self-reference.
      { fromName: "decision:storage-layout", fromProject: P, type: "see-also", toName: "decision:storage-layout", toProject: P, createdAt: T + 6 },
    ],
    sessionLinks: [
      { sessionId: "sess-1", observationId: "obs-1" },
      { sessionId: "sess-1", observationId: "obs-2" },
      { sessionId: "sess-1", observationId: "obs-3" },
      { sessionId: "sess-2", observationId: "obs-6" },
    ],
  };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/migrate-fingerprint.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, canonicalRow, keyOf, readConsistentGraph } from "../src/lib/migrate/fingerprint.js";
import { fixtureRecords } from "./helpers/graphFixture.js";

test("the same records in another order have the same fingerprint", () => {
  const reversed = fixtureRecords();
  for (const rows of Object.values(reversed)) rows.reverse();
  assert.deepEqual(fingerprint(reversed), fingerprint(fixtureRecords()));
});

test("one changed character in one observation changes the fingerprint", () => {
  const changed = fixtureRecords();
  changed.observations[0].text = changed.observations[0].text.replace("two", "twO");
  assert.notEqual(fingerprint(changed).hashes.observations, fingerprint(fixtureRecords()).hashes.observations);
});

test("seq orders rows but is not compared", () => {
  const reordered = fixtureRecords();
  reordered.observations[0].seq = 999;
  assert.deepEqual(fingerprint(reordered), fingerprint(fixtureRecords()));
});

test("null and the empty string are different values", () => {
  const entity = fixtureRecords().entities[1];
  assert.notEqual(canonicalRow("entities", entity), canonicalRow("entities", { ...entity, type: "" }));
});

test("text with an unpaired surrogate compares as its well-formed form", () => {
  const observation = { ...fixtureRecords().observations[0], text: "cut through an emoji \uD83D" };
  assert.equal(
    canonicalRow("observations", observation),
    canonicalRow("observations", { ...observation, text: "cut through an emoji \uFFFD" })
  );
});

test("keys ignore fields that are not part of the key", () => {
  const entity = fixtureRecords().entities[0];
  assert.equal(keyOf("entities", entity), keyOf("entities", { ...entity, type: "changed" }));
});

test("two matching reads return the second one", async () => {
  let reads = 0;
  const result = await readConsistentGraph(async () => {
    reads++;
    return fixtureRecords();
  });
  assert.equal(result.consistent, true);
  assert.equal(result.reads, 2);
  assert.equal(reads, 2);
});

test("a graph that changes between reads is read again until it holds still", async () => {
  let reads = 0;
  const result = await readConsistentGraph(async () => {
    reads++;
    const records = fixtureRecords();
    // The first two reads each see a different extra observation; then the graph is still.
    if (reads <= 2) records.observations.push({ ...records.observations[0], id: `late-${reads}` });
    return records;
  });
  assert.equal(result.consistent, true);
  assert.equal(result.reads, 4);
});

test("a graph that never holds still gives up after five comparisons", async () => {
  let reads = 0;
  const result = await readConsistentGraph(async () => {
    reads++;
    const records = fixtureRecords();
    records.observations.push({ ...records.observations[0], id: `late-${reads}` });
    return records;
  });
  assert.equal(result.consistent, false);
  assert.equal(result.records, null);
  assert.equal(reads, 6);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/migrate-fingerprint.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/migrate/fingerprint.js`.

- [ ] **Step 4: Write the implementation**

`src/lib/migrate/fingerprint.js`:

```js
import { createHash } from "node:crypto";

/**
 * The migration's record shapes: plain objects keyed by natural keys, never by
 * Neo4j or SQLite ids. Timestamps are epoch milliseconds (UTC); a global
 * entity's project is "".
 *
 * @typedef {{ name: string, project: string, type: string|null, createdAt: number, updatedAt: number|null }} EntityRecord
 * @typedef {{ id: string, entityName: string, entityProject: string, text: string, subsystem: string|null,
 *             sessionId: string|null, createdAt: number, seq: number }} ObservationRecord
 * @typedef {{ fromName: string, fromProject: string, type: string, toName: string, toProject: string,
 *             createdAt: number|null }} RelationRecord
 * @typedef {{ id: string, cwd: string|null, project: string|null, startedAt: number }} SessionRecord
 * @typedef {{ sessionId: string, observationId: string }} SessionLinkRecord
 * @typedef {{ entities: EntityRecord[], observations: ObservationRecord[], relations: RelationRecord[],
 *             sessions: SessionRecord[], sessionLinks: SessionLinkRecord[] }} GraphRecords
 */

// Every comparison and fingerprint reads fields through these lists, so a field
// cannot be carried on one side and silently skipped by the check. `seq`
// (Neo4j's internal id, SQLite's rowid) orders same-millisecond observations;
// it is metadata, not data, and is deliberately absent.
export const FIELDS = {
  entities: ["name", "project", "type", "createdAt", "updatedAt"],
  observations: ["id", "entityName", "entityProject", "text", "subsystem", "sessionId", "createdAt"],
  relations: ["fromName", "fromProject", "type", "toName", "toProject", "createdAt"],
  sessions: ["id", "cwd", "project", "startedAt"],
  sessionLinks: ["sessionId", "observationId"],
};

export const KEY_FIELDS = {
  entities: ["name", "project"],
  observations: ["id"],
  relations: ["fromName", "fromProject", "type", "toName", "toProject"],
  sessions: ["id"],
  sessionLinks: ["sessionId", "observationId"],
};

export const RECORD_TYPES = Object.keys(FIELDS);

/**
 * The value a field is compared by. UTF-8 cannot hold an unpaired UTF-16
 * surrogate (truncateText can leave one when it cuts through an emoji), so text
 * is compared in its well-formed form: the form the writer stores.
 */
export function normaliseField(field, value) {
  if (value === undefined) return null;
  return field === "text" && typeof value === "string" ? value.toWellFormed() : value;
}

/** A record's natural key, as a string usable in a Map. */
export function keyOf(type, record) {
  return JSON.stringify(KEY_FIELDS[type].map((field) => normaliseField(field, record[field])));
}

/** The record's compared fields in a fixed order; JSON keeps null distinct from "". */
export function canonicalRow(type, record) {
  return JSON.stringify(FIELDS[type].map((field) => normaliseField(field, record[field])));
}

/** Per-type row counts and a SHA-256 over the sorted canonical rows. */
export function fingerprint(records) {
  const result = { counts: {}, hashes: {} };
  for (const type of RECORD_TYPES) {
    const rows = records[type].map((record) => canonicalRow(type, record)).sort();
    result.counts[type] = rows.length;
    result.hashes[type] = createHash("sha256").update(rows.join("\n")).digest("hex");
  }
  return result;
}

function sameFingerprint(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Neo4j reads are read-committed, not a snapshot, so a capture landing mid-read
 * would tear the copy. Two back-to-back reads with identical fingerprints prove
 * nothing changed in between; each mismatch costs one more read.
 */
export async function readConsistentGraph(readOnce, { maxAttempts = 5 } = {}) {
  let previous = await readOnce();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await readOnce();
    if (sameFingerprint(fingerprint(previous), fingerprint(current))) {
      return { consistent: true, records: current, reads: attempt + 1 };
    }
    previous = current;
  }
  return { consistent: false, records: null, reads: maxAttempts + 1 };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/migrate-fingerprint.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/migrate/fingerprint.js tests/helpers/graphFixture.js tests/migrate-fingerprint.test.js
git commit -m "feat(memory): Add migration records and graph fingerprints" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Writing records into SQLite

**Files:**
- Create: `src/lib/migrate/writeSqlite.js`
- Test: `tests/migrate-write.test.js`

**Interfaces:**
- Consumes: `keyOf` (Task 2), `openMemoryDb` (Task 1, tests only).
- Produces:
  - `validateRecords(records: GraphRecords): string[]` (empty means writable)
  - `writeGraph(db: DatabaseSync, records: GraphRecords): { inserted: { entities, sessions, observations, relations }, skipped: { …same keys } }`
  - `class InvalidRecordsError extends Error { problems: string[] }`

- [ ] **Step 1: Write the failing tests**

`tests/migrate-write.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { writeGraph, validateRecords, InvalidRecordsError } from "../src/lib/migrate/writeSqlite.js";
import { fixtureRecords, FIXTURE_PROJECT, FIXTURE_TIME } from "./helpers/graphFixture.js";

function freshDb() {
  return openMemoryDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-write-")), "memory.sqlite"));
}

const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const NONE = { entities: 0, sessions: 0, observations: 0, relations: 0 };

test("a copy inserts every record", () => {
  const db = freshDb();
  const result = writeGraph(db, fixtureRecords());
  assert.deepEqual(result.inserted, { entities: 5, sessions: 2, observations: 6, relations: 3 });
  assert.deepEqual(result.skipped, NONE);
  db.close();
});

test("a second copy of the same records inserts nothing", () => {
  const db = freshDb();
  writeGraph(db, fixtureRecords());
  assert.deepEqual(writeGraph(db, fixtureRecords()).inserted, NONE);
  assert.equal(count(db, "observations"), 6);
  db.close();
});

test("an existing row is never overwritten", () => {
  const db = freshDb();
  writeGraph(db, fixtureRecords());
  const changed = fixtureRecords();
  changed.entities[0].type = "changed-later";
  writeGraph(db, changed);
  const row = db
    .prepare("SELECT type FROM entities WHERE name = ? AND project = ?")
    .get("decision:storage-layout", FIXTURE_PROJECT);
  assert.equal(row.type, "decision");
  db.close();
});

test("an observation pointing at a missing session keeps its session id", () => {
  const db = freshDb();
  writeGraph(db, fixtureRecords());
  assert.equal(db.prepare("SELECT session_id FROM observations WHERE id = 'obs-4'").get().session_id, "sess-missing");
  db.close();
});

test("same-millisecond observations are inserted in Neo4j creation order", () => {
  const db = freshDb();
  const records = fixtureRecords();
  records.observations.reverse();
  writeGraph(db, records);
  const ids = db
    .prepare("SELECT id FROM observations WHERE created_at = ? ORDER BY rowid")
    .all(FIXTURE_TIME)
    .map((row) => row.id);
  assert.deepEqual(ids, ["obs-1", "obs-2", "obs-3"]);
  db.close();
});

test("text with an unpaired surrogate is stored in its well-formed form", () => {
  const db = freshDb();
  const records = fixtureRecords();
  records.observations[0].text = "cut through an emoji \uD83D";
  writeGraph(db, records);
  assert.equal(db.prepare("SELECT text FROM observations WHERE id = 'obs-1'").get().text, "cut through an emoji \uFFFD");
  db.close();
});

test("two global entities with one name are rejected before anything is written", () => {
  const db = freshDb();
  const records = fixtureRecords();
  records.entities.push({ ...records.entities[3] }); // a second "user" with project ""
  assert.throws(
    () => writeGraph(db, records),
    (error) => error instanceof InvalidRecordsError && error.message.includes('duplicate entities ["user",""]')
  );
  assert.equal(count(db, "entities"), 0);
  db.close();
});

test("validation names observations without an entity and timestamps that are not whole milliseconds", () => {
  const records = fixtureRecords();
  records.observations.push({ ...records.observations[0], id: "orphan", entityName: null, entityProject: "" });
  records.sessions[0].startedAt = 1.5;
  const problems = validateRecords(records);
  assert.ok(problems.includes('observations ["orphan"] has no entityName'), problems.join("\n"));
  assert.ok(problems.includes("observation orphan belongs to no entity"), problems.join("\n"));
  assert.ok(problems.includes('sessions ["sess-1"] has a startedAt that is not whole milliseconds'), problems.join("\n"));
});

test("a failure part-way through rolls the whole write back", () => {
  const db = freshDb();
  db.exec(
    "CREATE TEMP TRIGGER fail_relations BEFORE INSERT ON relations BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;"
  );
  assert.throws(() => writeGraph(db, fixtureRecords()), /simulated failure/);
  assert.equal(count(db, "entities"), 0);
  assert.equal(count(db, "observations"), 0);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/migrate-write.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/migrate/writeSqlite.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/migrate/writeSqlite.js`:

```js
import { keyOf } from "./fingerprint.js";

export class InvalidRecordsError extends Error {
  constructor(problems) {
    super(
      `${problems.length} problem(s) in the source graph that SQLite cannot represent:\n  ` +
        problems.slice(0, 20).join("\n  ")
    );
    this.name = "InvalidRecordsError";
    this.problems = problems;
  }
}

const REQUIRED = {
  entities: ["name", "createdAt"],
  observations: ["id", "entityName", "text", "createdAt"],
  relations: ["type"],
  sessions: ["id", "startedAt"],
};

const TIMESTAMPS = {
  entities: ["createdAt", "updatedAt"],
  observations: ["createdAt"],
  relations: ["createdAt"],
  sessions: ["startedAt"],
};

/**
 * Everything the source holds that the schema cannot: duplicate natural keys
 * (Neo4j's uniqueness constraint ignores a null project, so two global entities
 * can share a name; an observation with two ABOUT edges reads as two rows),
 * observations without an entity, relation ends that are not entities, missing
 * required fields, and timestamps that are not whole milliseconds. Empty means
 * writable.
 */
export function validateRecords(records) {
  const problems = [];
  for (const type of Object.keys(REQUIRED)) {
    const seen = new Set();
    for (const record of records[type]) {
      const key = keyOf(type, record);
      if (seen.has(key)) problems.push(`duplicate ${type} ${key}`);
      seen.add(key);
      for (const field of REQUIRED[type]) {
        if (record[field] === null || record[field] === undefined) problems.push(`${type} ${key} has no ${field}`);
      }
      for (const field of TIMESTAMPS[type]) {
        const value = record[field];
        if (value !== null && value !== undefined && !Number.isSafeInteger(value)) {
          problems.push(`${type} ${key} has a ${field} that is not whole milliseconds`);
        }
      }
    }
  }
  const entityKey = (name, project) => keyOf("entities", { name, project });
  const entities = new Set(records.entities.map((entity) => keyOf("entities", entity)));
  for (const observation of records.observations) {
    if (!entities.has(entityKey(observation.entityName, observation.entityProject))) {
      problems.push(`observation ${observation.id} belongs to no entity`);
    }
  }
  for (const relation of records.relations) {
    for (const [name, project] of [
      [relation.fromName, relation.fromProject],
      [relation.toName, relation.toProject],
    ]) {
      if (!entities.has(entityKey(name, project))) {
        problems.push(`relation ${keyOf("relations", relation)} ends at ${entityKey(name, project)}, which is not an entity`);
      }
    }
  }
  return problems;
}

/**
 * Inserts every record whose natural key is not already in the file, in one
 * transaction, and never updates an existing row: a re-run adds only what is
 * missing. Throws InvalidRecordsError before writing anything if validation
 * fails; any SQLite error rolls the whole write back.
 */
export function writeGraph(db, records) {
  const problems = validateRecords(records);
  if (problems.length > 0) throw new InvalidRecordsError(problems);

  const inserted = { entities: 0, sessions: 0, observations: 0, relations: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertEntity = db.prepare(
      `INSERT INTO entities (name, project, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name, project) DO NOTHING`
    );
    for (const e of inCreationOrder(records.entities)) {
      inserted.entities += insertEntity.run(e.name, e.project, e.type ?? null, e.createdAt, e.updatedAt ?? null).changes;
    }

    const entityIds = new Map(
      db.prepare("SELECT id, name, project FROM entities").all().map((row) => [keyOf("entities", row), row.id])
    );
    const entityId = (name, project) => entityIds.get(keyOf("entities", { name, project }));

    const insertSession = db.prepare(
      "INSERT INTO sessions (id, cwd, project, started_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING"
    );
    for (const s of records.sessions) {
      inserted.sessions += insertSession.run(s.id, s.cwd ?? null, s.project ?? null, s.startedAt).changes;
    }

    const insertObservation = db.prepare(
      `INSERT INTO observations (id, entity_id, text, subsystem, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`
    );
    for (const o of inCreationOrder(records.observations)) {
      inserted.observations += insertObservation.run(
        o.id,
        entityId(o.entityName, o.entityProject),
        o.text.toWellFormed(),
        o.subsystem ?? null,
        o.sessionId ?? null,
        o.createdAt
      ).changes;
    }

    const insertRelation = db.prepare(
      `INSERT INTO relations (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (from_id, to_id, type) DO NOTHING`
    );
    for (const r of records.relations) {
      inserted.relations += insertRelation.run(
        entityId(r.fromName, r.fromProject),
        entityId(r.toName, r.toProject),
        r.type,
        r.createdAt ?? null
      ).changes;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const skipped = Object.fromEntries(Object.keys(inserted).map((type) => [type, records[type].length - inserted[type]]));
  return { inserted, skipped };
}

// createdAt, then Neo4j's creation order (seq), then the natural key. Rows from
// one write batch share a timestamp, so rowid then preserves the order Neo4j
// created them in: the tie-breaker "newest first" relies on.
function inCreationOrder(rows) {
  const tieKey = (row) => row.id ?? keyOf("entities", row);
  return [...rows].sort(
    (a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0) || compare(tieKey(a), tieKey(b))
  );
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/migrate-write.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/migrate/writeSqlite.js tests/migrate-write.test.js
git commit -m "feat(memory): Write migration records into SQLite" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reading SQLite back as records

**Files:**
- Create: `src/lib/migrate/readSqlite.js`
- Test: `tests/migrate-roundtrip.test.js`

**Interfaces:**
- Consumes: `openMemoryDb` (Task 1), `writeGraph` (Task 3), `fingerprint` (Task 2), all in tests.
- Produces: `readSqliteGraph(db: DatabaseSync): GraphRecords`. Observations carry `seq` = `rowid`, and `sessionLinks` are derived from the join.

- [ ] **Step 1: Write the failing tests**

`tests/migrate-roundtrip.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { writeGraph } from "../src/lib/migrate/writeSqlite.js";
import { readSqliteGraph } from "../src/lib/migrate/readSqlite.js";
import { fingerprint } from "../src/lib/migrate/fingerprint.js";
import { fixtureRecords, FIXTURE_PROJECT, FIXTURE_TIME } from "./helpers/graphFixture.js";

function copied() {
  const db = openMemoryDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-roundtrip-")), "memory.sqlite"));
  writeGraph(db, fixtureRecords());
  return db;
}

test("a copied graph reads back with an identical fingerprint", () => {
  const db = copied();
  assert.deepEqual(fingerprint(readSqliteGraph(db)), fingerprint(fixtureRecords()));
  db.close();
});

test("session links are rebuilt from session ids, skipping sessions that do not exist", () => {
  const db = copied();
  const links = readSqliteGraph(db)
    .sessionLinks.map((link) => `${link.sessionId}>${link.observationId}`)
    .sort();
  assert.deepEqual(links, ["sess-1>obs-1", "sess-1>obs-2", "sess-1>obs-3", "sess-2>obs-6"]);
  db.close();
});

test("text with tabs, newlines, quotes and astral characters reads back unchanged", () => {
  const db = copied();
  const textById = new Map(readSqliteGraph(db).observations.map((o) => [o.id, o.text]));
  for (const observation of fixtureRecords().observations) {
    assert.equal(textById.get(observation.id), observation.text);
  }
  db.close();
});

test("timestamps read back as the same whole milliseconds", () => {
  const db = copied();
  const entity = readSqliteGraph(db).entities.find(
    (e) => e.name === "decision:storage-layout" && e.project === FIXTURE_PROJECT
  );
  assert.equal(entity.createdAt, FIXTURE_TIME);
  assert.equal(typeof entity.createdAt, "number");
  db.close();
});

test("a global entity reads back with an empty project", () => {
  const db = copied();
  const users = readSqliteGraph(db).entities.filter((e) => e.name === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0].project, "");
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/migrate-roundtrip.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/migrate/readSqlite.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/migrate/readSqlite.js`:

```js
/**
 * A SQLite memory file as migration records: the same shape readNeo4j
 * produces, so the two sides compare field for field. Session links are
 * derived (a session id with no session row has no link), exactly as
 * PRODUCED edges existed only where the Session node did.
 */
export function readSqliteGraph(db) {
  return {
    entities: db
      .prepare("SELECT name, project, type, created_at AS createdAt, updated_at AS updatedAt FROM entities")
      .all(),
    observations: db
      .prepare(
        `SELECT o.id, e.name AS entityName, e.project AS entityProject, o.text, o.subsystem,
                o.session_id AS sessionId, o.created_at AS createdAt, o.rowid AS seq
         FROM observations o JOIN entities e ON e.id = o.entity_id`
      )
      .all(),
    relations: db
      .prepare(
        `SELECT a.name AS fromName, a.project AS fromProject, r.type, b.name AS toName, b.project AS toProject,
                r.created_at AS createdAt
         FROM relations r JOIN entities a ON a.id = r.from_id JOIN entities b ON b.id = r.to_id`
      )
      .all(),
    sessions: db.prepare("SELECT id, cwd, project, started_at AS startedAt FROM sessions").all(),
    sessionLinks: db
      .prepare(
        `SELECT s.id AS sessionId, o.id AS observationId
         FROM observations o JOIN sessions s ON s.id = o.session_id`
      )
      .all(),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/migrate-roundtrip.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/migrate/readSqlite.js tests/migrate-roundtrip.test.js
git commit -m "feat(memory): Read the SQLite memory store back as migration records" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Comparing two record sets

**Files:**
- Create: `src/lib/migrate/compareGraph.js`
- Test: `tests/migrate-compare.test.js`

**Interfaces:**
- Consumes: `FIELDS`, `RECORD_TYPES`, `canonicalRow`, `keyOf`, `normaliseField` (Task 2).
- Produces:
  - `compareGraph(source: GraphRecords, target: GraphRecords): CompareReport`, where:
    - `CompareReport = { ok: boolean, types: Record<type, TypeReport>, projects: ProjectCount[], notWellFormedText: number }`
    - `TypeReport = { source: number, target: number, missing: string[], changed: { key: string, fields: string[] }[], extra: string[] }`
    - `ProjectCount = { project, sourceEntities, targetEntities, sourceObservations, targetObservations }`, sorted by project
  - `ok` is false only when something is missing or changed.

- [ ] **Step 1: Write the failing tests**

`tests/migrate-compare.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareGraph } from "../src/lib/migrate/compareGraph.js";
import { fixtureRecords, FIXTURE_PROJECT } from "./helpers/graphFixture.js";

test("identical graphs pass with nothing missing, changed or extra", () => {
  const report = compareGraph(fixtureRecords(), fixtureRecords());
  assert.equal(report.ok, true);
  for (const [type, t] of Object.entries(report.types)) {
    assert.deepEqual([t.missing.length, t.changed.length, t.extra.length], [0, 0, 0], type);
  }
});

test("a row absent from the target fails and is named", () => {
  const target = fixtureRecords();
  target.observations = target.observations.filter((o) => o.id !== "obs-3");
  const report = compareGraph(fixtureRecords(), target);
  assert.equal(report.ok, false);
  assert.deepEqual(report.types.observations.missing, ['["obs-3"]']);
});

test("a row only in the target is listed but passes", () => {
  const target = fixtureRecords();
  target.entities.push({ name: "decision:new", project: FIXTURE_PROJECT, type: "decision", createdAt: 1, updatedAt: null });
  const report = compareGraph(fixtureRecords(), target);
  assert.equal(report.ok, true);
  assert.deepEqual(report.types.entities.extra, [JSON.stringify(["decision:new", FIXTURE_PROJECT])]);
});

test("a changed field fails and names the field", () => {
  const target = fixtureRecords();
  target.observations.find((o) => o.id === "obs-1").subsystem = "elsewhere";
  const report = compareGraph(fixtureRecords(), target);
  assert.equal(report.ok, false);
  assert.deepEqual(report.types.observations.changed, [{ key: '["obs-1"]', fields: ["subsystem"] }]);
});

test("counts are reported per project on both sides", () => {
  const report = compareGraph(fixtureRecords(), fixtureRecords());
  assert.deepEqual(
    report.projects.map((p) => [p.project, p.sourceEntities, p.targetEntities, p.sourceObservations, p.targetObservations]),
    [
      ["", 1, 1, 1, 1],
      ["github.com/acme/app", 3, 3, 4, 4],
      ["github.com/acme/other", 1, 1, 1, 1],
    ]
  );
});

test("an unpaired surrogate is counted and not reported as a change", () => {
  const source = fixtureRecords();
  source.observations[0].text = "cut through an emoji \uD83D";
  const target = fixtureRecords();
  target.observations[0].text = "cut through an emoji \uFFFD";
  const report = compareGraph(source, target);
  assert.equal(report.ok, true);
  assert.equal(report.notWellFormedText, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/migrate-compare.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/migrate/compareGraph.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/migrate/compareGraph.js`:

```js
import { FIELDS, RECORD_TYPES, canonicalRow, keyOf, normaliseField } from "./fingerprint.js";

/**
 * The source graph (Neo4j's snapshot) against the target (SQLite read back),
 * row by row on natural keys. Missing and changed rows fail the check; extra
 * rows, in SQLite only, are listed but pass, because after rollout they are new
 * writes or Neo4j-side deletes.
 */
export function compareGraph(source, target) {
  const types = Object.fromEntries(RECORD_TYPES.map((type) => [type, compareRows(type, source[type], target[type])]));
  return {
    ok: RECORD_TYPES.every((type) => types[type].missing.length === 0 && types[type].changed.length === 0),
    types,
    projects: projectCounts(source, target),
    notWellFormedText: source.observations.filter((o) => typeof o.text === "string" && !o.text.isWellFormed()).length,
  };
}

function compareRows(type, sourceRows, targetRows) {
  const targetByKey = new Map(targetRows.map((row) => [keyOf(type, row), row]));
  const sourceKeys = new Set();
  const missing = [];
  const changed = [];
  for (const row of sourceRows) {
    const key = keyOf(type, row);
    sourceKeys.add(key);
    const other = targetByKey.get(key);
    if (!other) missing.push(key);
    else if (canonicalRow(type, row) !== canonicalRow(type, other)) {
      changed.push({ key, fields: differingFields(type, row, other) });
    }
  }
  const extra = [...targetByKey.keys()].filter((key) => !sourceKeys.has(key));
  return { source: sourceRows.length, target: targetRows.length, missing, changed, extra };
}

function differingFields(type, a, b) {
  const value = (row, field) => JSON.stringify(normaliseField(field, row[field]));
  return FIELDS[type].filter((field) => value(a, field) !== value(b, field));
}

function projectCounts(source, target) {
  const projects = new Map();
  const bump = (project, field) => {
    const row = projects.get(project) ?? {
      project,
      sourceEntities: 0,
      targetEntities: 0,
      sourceObservations: 0,
      targetObservations: 0,
    };
    row[field] += 1;
    projects.set(project, row);
  };
  for (const e of source.entities) bump(e.project, "sourceEntities");
  for (const e of target.entities) bump(e.project, "targetEntities");
  for (const o of source.observations) bump(o.entityProject, "sourceObservations");
  for (const o of target.observations) bump(o.entityProject, "targetObservations");
  return [...projects.values()].sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/migrate-compare.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/migrate/compareGraph.js tests/migrate-compare.test.js
git commit -m "feat(memory): Compare migration records row by row" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sabotage tests for the check

**Files:**
- Test: `tests/migrate-sabotage.test.js`

**Interfaces:**
- Consumes: `openMemoryDb` (Task 1), `writeGraph` (Task 3), `readSqliteGraph` (Task 4), `compareGraph` (Task 5).
- Produces: nothing. These tests prove the check cannot pass vacuously.

- [ ] **Step 1: Write the tests**

`tests/migrate-sabotage.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { writeGraph } from "../src/lib/migrate/writeSqlite.js";
import { readSqliteGraph } from "../src/lib/migrate/readSqlite.js";
import { compareGraph } from "../src/lib/migrate/compareGraph.js";
import { fixtureRecords, FIXTURE_PROJECT as P } from "./helpers/graphFixture.js";

// Each case damages one stored field the way a buggy writer or a damaged file
// could, then names the row the check must report: as changed (with that
// field) or, when the damage alters the row's key, as missing.
const CASES = [
  { name: "entity type", sql: "UPDATE entities SET type = 'changed' WHERE name = 'decision:storage-layout' AND project = ?", params: [P], type: "entities", key: ["decision:storage-layout", P], changed: "type" },
  { name: "entity createdAt", sql: "UPDATE entities SET created_at = created_at + 1 WHERE name = 'ticket:APP-1'", type: "entities", key: ["ticket:APP-1", P], changed: "createdAt" },
  { name: "entity updatedAt", sql: "UPDATE entities SET updated_at = NULL WHERE name = 'decision:storage-layout' AND project = ?", params: [P], type: "entities", key: ["decision:storage-layout", P], changed: "updatedAt" },
  { name: "observation text", sql: "UPDATE observations SET text = replace(text, 'two', 'twO') WHERE id = 'obs-1'", type: "observations", key: ["obs-1"], changed: "text" },
  { name: "observation owner", sql: "UPDATE observations SET entity_id = (SELECT id FROM entities WHERE name = 'service:billing') WHERE id = 'obs-4'", type: "observations", key: ["obs-4"], changed: "entityName" },
  { name: "observation subsystem", sql: "UPDATE observations SET subsystem = NULL WHERE id = 'obs-1'", type: "observations", key: ["obs-1"], changed: "subsystem" },
  { name: "observation session id", sql: "UPDATE observations SET session_id = 'sess-2' WHERE id = 'obs-5'", type: "observations", key: ["obs-5"], changed: "sessionId" },
  { name: "observation createdAt", sql: "UPDATE observations SET created_at = created_at - 1 WHERE id = 'obs-2'", type: "observations", key: ["obs-2"], changed: "createdAt" },
  { name: "relation createdAt", sql: "UPDATE relations SET created_at = 1 WHERE type = 'depends-on'", type: "relations", key: ["ticket:APP-1", P, "depends-on", "service:billing", P], changed: "createdAt" },
  { name: "relation type", sql: "UPDATE relations SET type = 'replaces' WHERE type = 'implements'", type: "relations", key: ["decision:storage-layout", P, "implements", "ticket:APP-1", P], missing: true },
  { name: "relation endpoint", sql: "UPDATE relations SET to_id = (SELECT id FROM entities WHERE name = 'user') WHERE type = 'depends-on'", type: "relations", key: ["ticket:APP-1", P, "depends-on", "service:billing", P], missing: true },
  { name: "session cwd", sql: "UPDATE sessions SET cwd = '/elsewhere' WHERE id = 'sess-1'", type: "sessions", key: ["sess-1"], changed: "cwd" },
  { name: "session project", sql: "UPDATE sessions SET project = 'other' WHERE id = 'sess-2'", type: "sessions", key: ["sess-2"], changed: "project" },
  { name: "session startedAt", sql: "UPDATE sessions SET started_at = started_at + 1 WHERE id = 'sess-2'", type: "sessions", key: ["sess-2"], changed: "startedAt" },
  { name: "dropped session link", sql: "UPDATE observations SET session_id = NULL WHERE id = 'obs-6'", type: "sessionLinks", key: ["sess-2", "obs-6"], missing: true },
  { name: "deleted observation", sql: "DELETE FROM observations WHERE id = 'obs-3'", type: "observations", key: ["obs-3"], missing: true },
  { name: "deleted session", sql: "DELETE FROM sessions WHERE id = 'sess-1'", type: "sessions", key: ["sess-1"], missing: true },
];

for (const c of CASES) {
  test(`the check catches a corrupted ${c.name}`, () => {
    const db = openMemoryDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-sabotage-")), "memory.sqlite"));
    writeGraph(db, fixtureRecords());
    db.prepare(c.sql).run(...(c.params ?? []));
    const report = compareGraph(fixtureRecords(), readSqliteGraph(db));
    db.close();
    const key = JSON.stringify(c.key);
    assert.equal(report.ok, false, "the corruption must fail the check");
    if (c.missing) {
      assert.ok(report.types[c.type].missing.includes(key), `${key} must be reported missing`);
    } else {
      assert.deepEqual(report.types[c.type].changed.find((row) => row.key === key)?.fields, [c.changed]);
    }
  });
}
```

- [ ] **Step 2: Run the tests**

Run: `node --test tests/migrate-sabotage.test.js`
Expected: PASS, 17 tests. Tasks 3 to 5 already implement the behaviour; this task proves it.

- [ ] **Step 3: Prove the tests can fail**

Temporarily replace the body of `canonicalRow` in `src/lib/migrate/fingerprint.js` with `return "";` and re-run:

Run: `node --test tests/migrate-sabotage.test.js`
Expected: FAIL in every case that sets `changed:` (12 tests). The 5 `missing:` cases still pass, because they depend on keys, not on row contents.

Restore the file:

```bash
git checkout src/lib/migrate/fingerprint.js
node --test tests/migrate-sabotage.test.js
```

Expected: PASS, 17 tests.

- [ ] **Step 4: Commit**

```bash
git add tests/migrate-sabotage.test.js
git commit -m "test(memory): Prove the migration check catches every corrupted field" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Reading Neo4j as records

**Files:**
- Create: `src/lib/migrate/readNeo4j.js`
- Test: `tests/migrate-read-neo4j.test.js`. Covers the conversions. The Cypher runs in Task 10's rehearsal.

**Interfaces:**
- Consumes: `neo4j-driver` (already a dependency).
- Produces:
  - `readGraph(session: neo4j.Session): Promise<GraphRecords>`. Must be a `READ` session; it reads inside `session.executeRead`.
  - `toRecords(raw): GraphRecords`. Pure.
  - `toEpochMs(value, what: string): number | null`. Throws with `what` in the message for anything other than a zoned datetime at millisecond precision.

- [ ] **Step 1: Write the failing tests**

`tests/migrate-read-neo4j.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import neo4j from "neo4j-driver";
import { toEpochMs, toRecords } from "../src/lib/migrate/readNeo4j.js";

const { DateTime, LocalDateTime } = neo4j.types;
const EXPECTED = Date.UTC(2026, 6, 22, 13, 32, 22, 780);

test("a UTC datetime Neo4j prints as .78Z converts to 780 ms", () => {
  assert.equal(toEpochMs(new DateTime(2026, 7, 22, 13, 32, 22, 780_000_000, 0), "x"), EXPECTED);
});

test("a datetime with an offset converts to the same instant", () => {
  assert.equal(toEpochMs(new DateTime(2026, 7, 22, 15, 32, 22, 780_000_000, 7200), "x"), EXPECTED);
});

test("a missing timestamp stays null", () => {
  assert.equal(toEpochMs(null, "x"), null);
  assert.equal(toEpochMs(undefined, "x"), null);
});

test("sub-millisecond precision is refused, naming the value", () => {
  assert.throws(
    () => toEpochMs(new DateTime(2026, 7, 22, 13, 32, 22, 780_000_001, 0), "observation o1 createdAt"),
    /observation o1 createdAt has sub-millisecond precision/
  );
});

test("a local datetime or a string is refused rather than guessed at", () => {
  assert.throws(
    () => toEpochMs(new LocalDateTime(2026, 7, 22, 13, 32, 22, 0), "entity e createdAt"),
    /entity e createdAt is not a zoned datetime/
  );
  assert.throws(() => toEpochMs("2026-07-22T13:32:22.78Z", "entity e createdAt"), /not a zoned datetime/);
});

test("raw rows become records with global projects as '' and seq as a number", () => {
  const at = new DateTime(2026, 7, 22, 13, 32, 22, 780_000_000, 0);
  const records = toRecords({
    entities: [{ name: "user", project: null, type: null, createdAt: at, updatedAt: null }],
    observations: [
      { id: "o1", entityName: "user", entityProject: null, text: "t", subsystem: null, sessionId: null, createdAt: at, seq: neo4j.int(42) },
    ],
    relations: [{ fromName: "user", fromProject: null, type: "self", toName: "user", toProject: null, createdAt: null }],
    sessions: [{ id: "s1", cwd: null, project: null, startedAt: at }],
    sessionLinks: [{ sessionId: "s1", observationId: "o1" }],
  });
  assert.equal(records.entities[0].project, "");
  assert.equal(records.entities[0].createdAt, EXPECTED);
  assert.equal(records.observations[0].entityProject, "");
  assert.equal(records.observations[0].seq, 42);
  assert.equal(records.relations[0].fromProject, "");
  assert.equal(records.relations[0].createdAt, null);
  assert.equal(records.sessions[0].project, null, "a session's project is not an entity project and stays null");
  assert.deepEqual(records.sessionLinks, [{ sessionId: "s1", observationId: "o1" }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/migrate-read-neo4j.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/migrate/readNeo4j.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/migrate/readNeo4j.js`:

```js
import neo4j from "neo4j-driver";

// One query per element type. `id(o)` is Neo4j's internal creation order, used
// only to keep same-millisecond observations in the order they were written
// (deprecated in Neo4j 5 but still served; elementId's format is not ordered).
const QUERIES = {
  entities: `MATCH (e:Entity)
    RETURN e.name AS name, e.project AS project, e.type AS type, e.createdAt AS createdAt, e.updatedAt AS updatedAt`,
  observations: `MATCH (o:Observation)
    OPTIONAL MATCH (o)-[:ABOUT]->(e:Entity)
    RETURN o.id AS id, e.name AS entityName, e.project AS entityProject, o.text AS text, o.subsystem AS subsystem,
           o.sessionId AS sessionId, o.createdAt AS createdAt, id(o) AS seq`,
  relations: `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
    RETURN a.name AS fromName, a.project AS fromProject, r.type AS type,
           b.name AS toName, b.project AS toProject, r.createdAt AS createdAt`,
  sessions: `MATCH (s:Session)
    RETURN s.id AS id, s.cwd AS cwd, s.project AS project, s.startedAt AS startedAt`,
  sessionLinks: `MATCH (s:Session)-[:PRODUCED]->(o:Observation)
    RETURN s.id AS sessionId, o.id AS observationId`,
};

/**
 * The whole graph as migration records, read in one read transaction. Neo4j
 * refuses any write inside executeRead, so this cannot modify the source.
 */
export async function readGraph(session) {
  const raw = await session.executeRead(async (tx) => {
    const rows = {};
    for (const [type, query] of Object.entries(QUERIES)) {
      rows[type] = (await tx.run(query)).records.map((record) => record.toObject());
    }
    return rows;
  });
  return toRecords(raw);
}

/** Raw Neo4j rows to migration records. No I/O; exported for tests. */
export function toRecords(raw) {
  return {
    entities: raw.entities.map((e) => ({
      name: e.name,
      project: e.project ?? "",
      type: e.type ?? null,
      createdAt: toEpochMs(e.createdAt, `entity ${e.name} createdAt`),
      updatedAt: toEpochMs(e.updatedAt, `entity ${e.name} updatedAt`),
    })),
    observations: raw.observations.map((o) => ({
      id: o.id,
      entityName: o.entityName ?? null,
      entityProject: o.entityProject ?? "",
      text: o.text ?? null,
      subsystem: o.subsystem ?? null,
      sessionId: o.sessionId ?? null,
      createdAt: toEpochMs(o.createdAt, `observation ${o.id} createdAt`),
      seq: neo4j.integer.toNumber(o.seq),
    })),
    relations: raw.relations.map((r) => ({
      fromName: r.fromName,
      fromProject: r.fromProject ?? "",
      type: r.type ?? null,
      toName: r.toName,
      toProject: r.toProject ?? "",
      createdAt: toEpochMs(r.createdAt, `relation ${r.fromName} -${r.type}-> ${r.toName} createdAt`),
    })),
    sessions: raw.sessions.map((s) => ({
      id: s.id,
      cwd: s.cwd ?? null,
      project: s.project ?? null,
      startedAt: toEpochMs(s.startedAt, `session ${s.id} startedAt`),
    })),
    sessionLinks: raw.sessionLinks.map((link) => ({ sessionId: link.sessionId, observationId: link.observationId })),
  };
}

/**
 * A Neo4j zoned datetime to epoch milliseconds. Every temporal value in the
 * live graph is a UTC zoned datetime at millisecond precision, so this is
 * exact; anything else (a local datetime, a string, sub-millisecond
 * precision) throws with `what` in the message rather than being guessed at.
 */
export function toEpochMs(value, what) {
  if (value === null || value === undefined) return null;
  if (!neo4j.isDateTime(value)) throw new Error(`${what} is not a zoned datetime: ${String(value)}`);
  if (neo4j.integer.toNumber(value.nanosecond) % 1_000_000 !== 0) {
    throw new Error(`${what} has sub-millisecond precision: ${value.toString()}`);
  }
  return value.toStandardDate().getTime();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/migrate-read-neo4j.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/migrate/readNeo4j.js tests/migrate-read-neo4j.test.js
git commit -m "feat(memory): Read the Neo4j memory graph as migration records" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: One migration run, end to end

**Files:**
- Create: `src/lib/migrate/runMigration.js`
- Test: `tests/migrate-run.test.js`

**Interfaces:**
- Consumes:
  - `openMemoryDb`, `integrityReport` (Task 1)
  - `fingerprint`, `readConsistentGraph` (Task 2)
  - `validateRecords`, `writeGraph` (Task 3)
  - `readSqliteGraph` (Task 4)
  - `compareGraph` (Task 5)
- Produces:
  - `EXIT = { PASSED: 0, CHECK_FAILED: 1, COULD_NOT_RUN: 2 }`
  - `runMigration({ readOnce, out, checkOnly = false, reportPath, sourceLabel = "unknown source", log = console.log, now = Date.now }): Promise<{ exitCode, report?, reportFile?, problems? }>`
  - `formatSummary(report, reportFile): string`

- [ ] **Step 1: Write the failing tests**

`tests/migrate-run.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { runMigration, formatSummary, EXIT } from "../src/lib/migrate/runMigration.js";
import { fixtureRecords } from "./helpers/graphFixture.js";

function target() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-run-")), "memory.sqlite");
}

const quiet = () => {};
const run = (out, options = {}) =>
  runMigration({ readOnce: async () => fixtureRecords(), out, sourceLabel: "fixture", log: quiet, ...options });
const mode = (file) => fs.statSync(file).mode & 0o777;
const NONE = { entities: 0, sessions: 0, observations: 0, relations: 0 };

test("a first run builds the file, passes, and logs itself", async () => {
  const out = target();
  const { exitCode, report, reportFile } = await run(out);
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(report.newFile, true);
  assert.equal(fs.existsSync(`${out}.tmp`), false);
  assert.equal(mode(out), 0o600);
  assert.equal(mode(reportFile), 0o600);
  const db = new DatabaseSync(out, { readOnly: true });
  assert.deepEqual(
    db.prepare("SELECT result FROM migrations").all().map((row) => row.result),
    ["passed"]
  );
  db.close();
});

test("a second run inserts nothing and still passes", async () => {
  const out = target();
  await run(out);
  const { exitCode, report } = await run(out);
  assert.equal(exitCode, EXIT.PASSED);
  assert.deepEqual(report.write.inserted, NONE);
});

test("rows written to the source after a copy are added by the next run", async () => {
  const out = target();
  await run(out);
  const later = fixtureRecords();
  later.observations.push({ ...later.observations[4], id: "obs-late", seq: 200 });
  const { exitCode, report } = await run(out, { readOnce: async () => later });
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(report.write.inserted.observations, 1);
});

test("a graph that never holds still writes nothing and exits 2", async () => {
  const out = target();
  let reads = 0;
  const { exitCode } = await run(out, {
    readOnce: async () => {
      const records = fixtureRecords();
      records.observations.push({ ...records.observations[0], id: `late-${++reads}` });
      return records;
    },
  });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.equal(fs.existsSync(out), false);
});

test("a source read that throws exits 2 with its message", async () => {
  const lines = [];
  const { exitCode } = await run(target(), {
    readOnce: async () => {
      throw new Error("entity e createdAt is not a zoned datetime: x");
    },
    log: (line) => lines.push(line),
  });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.match(lines.join("\n"), /not a zoned datetime/);
});

test("a source graph SQLite cannot represent exits 2 before writing", async () => {
  const out = target();
  const records = fixtureRecords();
  records.entities.push({ ...records.entities[3] }); // a second global "user"
  const { exitCode, problems } = await run(out, { readOnce: async () => records });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.deepEqual(problems, ['duplicate entities ["user",""]']);
  assert.equal(fs.existsSync(out), false);
});

test("a corrupted file fails the check, exits 1 and is kept", async () => {
  const out = target();
  await run(out);
  const db = new DatabaseSync(out);
  db.exec("UPDATE observations SET text = 'tampered' WHERE id = 'obs-1'");
  db.close();
  const { exitCode, report } = await run(out, { checkOnly: true });
  assert.equal(exitCode, EXIT.CHECK_FAILED);
  assert.deepEqual(report.comparison.types.observations.changed, [{ key: '["obs-1"]', fields: ["text"] }]);
  assert.equal(fs.existsSync(out), true);
});

test("--check-only writes nothing to the database", async () => {
  const out = target();
  await run(out);
  await run(out, { checkOnly: true });
  const db = new DatabaseSync(out, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM migrations").get().n, 1);
  db.close();
});

test("--check-only without a file exits 2", async () => {
  const out = target();
  const { exitCode } = await run(out, { checkOnly: true });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.equal(fs.existsSync(out), false);
});

test("a temp file left by an interrupted run is replaced", async () => {
  const out = target();
  fs.writeFileSync(`${out}.tmp`, "not a database");
  const { exitCode } = await run(out);
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(fs.existsSync(`${out}.tmp`), false);
});

test("a target directory that does not exist yet is created", async () => {
  const out = path.join(path.dirname(target()), "fresh", "machine", "memory.sqlite");
  const { exitCode } = await run(out);
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(mode(path.dirname(out)), 0o700);
});

test(
  "a write that fails leaves no temp file and exits 2",
  { skip: process.getuid?.() === 0 && "root ignores directory permissions" },
  async () => {
    const dir = path.join(path.dirname(target()), "locked");
    fs.mkdirSync(dir, { mode: 0o500 });
    const { exitCode } = await run(path.join(dir, "memory.sqlite"));
    fs.chmodSync(dir, 0o700);
    assert.equal(exitCode, EXIT.COULD_NOT_RUN);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
);

test("a top-up waits for another process's write instead of failing", async () => {
  const out = target();
  await run(out);
  // A second process takes the write lock and holds it for 300 ms: the shape
  // of the new engine writing while a late top-up runs.
  const holder = spawn(process.execPath, [
    "--no-warnings",
    "--input-type=module",
    "-e",
    `import { DatabaseSync } from "node:sqlite";
     const db = new DatabaseSync(${JSON.stringify(out)});
     db.exec("BEGIN IMMEDIATE");
     console.log("locked");
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
     db.exec("COMMIT");
     db.close();`,
  ]);
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const later = fixtureRecords();
  later.observations.push({ ...later.observations[4], id: "obs-while-locked", seq: 300 });
  const { exitCode, report } = await run(out, { readOnce: async () => later });
  await new Promise((resolve) => holder.once("exit", resolve));
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(report.write.inserted.observations, 1);
});

test("the summary shows a row per type and the verdict", async () => {
  const { report, reportFile } = await run(target());
  const summary = formatSummary(report, reportFile);
  assert.match(summary, /^observations\s+6\s+6\s+0\s+0\s+0$/m);
  assert.match(summary, /^session links\s+4\s+-\s+0\s+-\s+0$/m);
  assert.match(summary, /^PASS {3}report: /m);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/migrate-run.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/migrate/runMigration.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/migrate/runMigration.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { openMemoryDb, integrityReport } from "../sqliteDb.js";
import { fingerprint, readConsistentGraph } from "./fingerprint.js";
import { validateRecords, writeGraph } from "./writeSqlite.js";
import { readSqliteGraph } from "./readSqlite.js";
import { compareGraph } from "./compareGraph.js";

export const EXIT = Object.freeze({ PASSED: 0, CHECK_FAILED: 1, COULD_NOT_RUN: 2 });

/**
 * One migration run: a consistent read of the source, validation, the write (a
 * new file built under a temporary name, or a top-up of an existing one), the
 * check, the run log, the report and the summary. `readOnce` returns
 * GraphRecords; the CLI passes a Neo4j reader, tests pass fixtures.
 */
export async function runMigration({
  readOnce,
  out,
  checkOnly = false,
  reportPath,
  sourceLabel = "unknown source",
  log = console.log,
  now = Date.now,
}) {
  const startedAt = now();
  let read;
  try {
    read = await readConsistentGraph(readOnce);
  } catch (error) {
    log(`Reading the source graph failed; nothing was written: ${error.message}`);
    return { exitCode: EXIT.COULD_NOT_RUN };
  }
  if (!read.consistent) {
    log(`The graph changed between every pair of reads (${read.reads} reads); nothing was written. Try again at a quieter moment.`);
    return { exitCode: EXIT.COULD_NOT_RUN };
  }
  const problems = validateRecords(read.records);
  if (problems.length > 0) {
    log(
      `The source graph has ${problems.length} problem(s) SQLite cannot represent; nothing was written:\n  ` +
        problems.slice(0, 20).join("\n  ")
    );
    return { exitCode: EXIT.COULD_NOT_RUN, problems };
  }

  const existed = fs.existsSync(out);
  if (checkOnly && !existed) {
    log(`Nothing to check: ${out} does not exist.`);
    return { exitCode: EXIT.COULD_NOT_RUN };
  }
  let write = null;
  if (!checkOnly) {
    try {
      write = existed ? topUp(out, read.records) : buildNew(out, read.records);
    } catch (error) {
      log(`Writing ${out} failed; nothing was changed: ${error.message}`);
      return { exitCode: EXIT.COULD_NOT_RUN };
    }
  }

  const db = openMemoryDb(out, { readOnly: checkOnly });
  try {
    const comparison = compareGraph(read.records, readSqliteGraph(db));
    const integrity = integrityReport(db);
    const report = {
      source: sourceLabel,
      target: out,
      startedAt,
      finishedAt: now(),
      reads: read.reads,
      newFile: !existed,
      checkOnly,
      write,
      comparison,
      integrity,
      sourceFingerprint: fingerprint(read.records),
      ok: comparison.ok && integrity.ok,
    };
    if (!checkOnly) logRun(db, report);
    const reportFile = reportPath ?? defaultReportPath(out, report.finishedAt);
    writeReport(reportFile, report);
    log(formatSummary(report, reportFile));
    return { exitCode: report.ok ? EXIT.PASSED : EXIT.CHECK_FAILED, report, reportFile };
  } finally {
    db.close();
  }
}

// A first run builds the whole file under a temporary name and renames it into
// place only after every row is written, so the target path never holds a
// half-built database. A temp file left by an interrupted run is replaced.
function buildNew(out, records) {
  const tmp = `${out}.tmp`;
  removeDbFiles(tmp);
  try {
    const db = openMemoryDb(tmp);
    let result;
    try {
      result = writeGraph(db, records);
    } finally {
      db.close();
    }
    // Closing the last connection checkpoints the WAL into the main file; a WAL
    // still on disk would hold rows the rename would leave behind.
    if (fs.existsSync(`${tmp}-wal`)) throw new Error(`${tmp}-wal survived close; refusing to rename`);
    fs.renameSync(tmp, out);
    return result;
  } catch (error) {
    removeDbFiles(tmp);
    throw error;
  }
}

function topUp(out, records) {
  const db = openMemoryDb(out);
  try {
    return writeGraph(db, records);
  } finally {
    db.close();
  }
}

function removeDbFiles(file) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
}

function logRun(db, report) {
  const counts = Object.fromEntries(
    Object.entries(report.comparison.types).map(([type, t]) => [
      type,
      {
        source: t.source,
        inserted: report.write?.inserted[type] ?? null,
        missing: t.missing.length,
        changed: t.changed.length,
        extra: t.extra.length,
      },
    ])
  );
  db.prepare("INSERT INTO migrations (source, started_at, finished_at, counts, result) VALUES (?, ?, ?, ?, ?)").run(
    report.source,
    report.startedAt,
    report.finishedAt,
    JSON.stringify(counts),
    report.ok ? "passed" : "failed"
  );
}

function defaultReportPath(out, finishedAt) {
  const stamp = new Date(finishedAt).toISOString().replace(/:/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.join(path.dirname(out), `migration-report-${stamp}.json`);
}

// The report quotes observation text, so it gets the database's permissions.
function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const LABELS = {
  entities: "entities",
  observations: "observations",
  relations: "relations",
  sessions: "sessions",
  sessionLinks: "session links",
};
const HEADINGS = ["source", "inserted", "missing", "changed", "extra"];

/** The human summary printed at the end of a run. */
export function formatSummary(report, reportFile) {
  const cell = (value) => (value === null || value === undefined ? "-" : value.toLocaleString("en-US")).padStart(10);
  const { comparison, integrity } = report;
  const lines = [
    `Neo4j   ${report.source}   ${report.reads} reads, consistent`,
    `SQLite  ${report.target}   ${report.checkOnly ? "check only" : report.newFile ? "new file" : "existing file"}`,
    "",
    `${"".padEnd(14)}${HEADINGS.map((heading) => heading.padStart(10)).join("")}`,
  ];
  for (const [type, label] of Object.entries(LABELS)) {
    const t = comparison.types[type];
    const inserted = type === "sessionLinks" ? null : (report.write?.inserted[type] ?? null);
    const changed = type === "sessionLinks" ? null : t.changed.length;
    lines.push(`${label.padEnd(14)}${[t.source, inserted, t.missing.length, changed, t.extra.length].map(cell).join("")}`);
  }
  const matching = comparison.projects.filter(
    (p) => p.sourceEntities === p.targetEntities && p.sourceObservations === p.targetObservations
  ).length;
  const foreignKeys = integrity.foreignKeyViolations === 0 ? "ok" : `${integrity.foreignKeyViolations} violation(s)`;
  lines.push(
    "",
    `integrity ${integrity.integrity.join("; ")}   foreign keys ${foreignKeys}   ` +
      `per-project counts match in ${matching} of ${comparison.projects.length} projects`
  );
  if (comparison.notWellFormedText > 0) {
    lines.push(`${comparison.notWellFormedText} observation text(s) held a broken character, stored as U+FFFD`);
  }
  for (const [type, t] of Object.entries(comparison.types)) {
    for (const key of t.missing.slice(0, 20)) lines.push(`  missing  ${LABELS[type]} ${key}`);
    for (const row of t.changed.slice(0, 20)) lines.push(`  changed  ${LABELS[type]} ${row.key}: ${row.fields.join(", ")}`);
  }
  lines.push(`${report.ok ? "PASS" : "FAIL"}   report: ${reportFile}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/migrate-run.test.js`
Expected: PASS, 14 tests (13 when running as root, which skips the permissions test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/migrate/runMigration.js tests/migrate-run.test.js
git commit -m "feat(memory): Run a migration from source records to a checked SQLite file" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The `migrate-to-sqlite` command

**Files:**
- Create: `scripts/migrate-to-sqlite.mjs`
- Modify: `package.json` (scripts, next to `"migrate-to-podman"`)
- Modify: `memory/CHANGELOG.md` (top of `## Unreleased`)
- Test: `tests/migrate-cli.test.js`

**Interfaces:**
- Consumes:
  - `CONFIG_DIR`, `loadConnectionConfig` (`src/lib/config.js`)
  - `getDriver`, `verifyConnectivity`, `closeDriver` (`src/lib/neo4jClient.js`)
  - `readGraph` (Task 7), `runMigration` (Task 8)
- Produces: `npm run migrate-to-sqlite -- [--out PATH] [--check-only] [--report PATH]`, with exit codes `0`, `1` and `2`.

- [ ] **Step 1: Write the failing tests**

`tests/migrate-cli.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/migrate-to-sqlite.mjs", import.meta.url));

// CONFIG_DIR comes from os.homedir(), so an isolated $HOME keeps every run away
// from the developer's real ~/.claude-neo4j. Port 1 refuses connections at once.
function runCli(args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-cli-"));
  const result = spawnSync(process.execPath, ["--no-warnings", SCRIPT, ...args], {
    env: { ...process.env, HOME: home, NEO4J_URI: "bolt://127.0.0.1:1", NEO4J_PASSWORD: "unused", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { ...result, home };
}

test("an unreachable Neo4j exits 2 and writes nothing", () => {
  const { status, stderr, home } = runCli([]);
  assert.equal(status, 2);
  assert.match(stderr, /Cannot reach Neo4j/);
  assert.equal(fs.existsSync(path.join(home, ".claude-neo4j", "memory.sqlite")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude-neo4j", "memory.sqlite.tmp")), false);
});

test("an unknown flag exits 2 with the usage line", () => {
  const { status, stderr } = runCli(["--frobnicate"]);
  assert.equal(status, 2);
  assert.match(stderr, /usage: migrate-to-sqlite/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/migrate-cli.test.js`
Expected: FAIL. The script does not exist, so `status` is `1` (Node's "Cannot find module"), not `2`.

- [ ] **Step 3: Write the command**

`scripts/migrate-to-sqlite.mjs`:

```js
#!/usr/bin/env node
// Copies the Neo4j memory graph into a SQLite file and checks every row.
// Neo4j is only read; the plugin's config is not changed.
//   node scripts/migrate-to-sqlite.mjs [--out PATH] [--check-only] [--report PATH]
// Spec: docs/superpowers/specs/2026-10-09-sqlite-migration-design.md
import path from "node:path";
import { CONFIG_DIR } from "../src/lib/config.js";

const USAGE = "usage: migrate-to-sqlite [--out PATH] [--check-only] [--report PATH]";

function parseArgs(argv) {
  const flags = { out: path.join(CONFIG_DIR, "memory.sqlite"), checkOnly: false, report: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) flags.out = path.resolve(argv[++i]);
    else if (arg === "--report" && argv[i + 1]) flags.report = path.resolve(argv[++i]);
    else if (arg === "--check-only") flags.checkOnly = true;
    else return { error: `Unknown or incomplete argument: ${arg}\n${USAGE}` };
  }
  return { flags };
}

async function main() {
  const { flags, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(error);
    return 2;
  }
  // Checked before anything that imports node:sqlite, so an old Node gets this
  // message instead of a module-resolution crash.
  try {
    await import("node:sqlite");
  } catch {
    console.error(`migrate-to-sqlite needs node:sqlite, in Node 22.5 or later; this is Node ${process.versions.node}.`);
    return 2;
  }
  const { default: neo4j } = await import("neo4j-driver");
  const { loadConnectionConfig } = await import("../src/lib/config.js");
  const { getDriver, verifyConnectivity, closeDriver } = await import("../src/lib/neo4jClient.js");
  const { readGraph } = await import("../src/lib/migrate/readNeo4j.js");
  const { runMigration } = await import("../src/lib/migrate/runMigration.js");

  try {
    let config;
    try {
      config = loadConnectionConfig();
      await verifyConnectivity();
    } catch (connectError) {
      console.error(`Cannot reach Neo4j: ${connectError.message}`);
      return 2;
    }
    if (config.mode === "remote") {
      console.warn(`Warning: the source is a remote graph (${config.uri}); the SQLite file serves this machine only.`);
    }
    const readOnce = async () => {
      const session = getDriver().session({ database: config.database, defaultAccessMode: neo4j.session.READ });
      try {
        return await readGraph(session);
      } finally {
        await session.close();
      }
    };
    const { exitCode } = await runMigration({
      readOnce,
      out: flags.out,
      checkOnly: flags.checkOnly,
      reportPath: flags.report,
      sourceLabel: `${config.uri} (${config.mode})`,
    });
    return exitCode;
  } finally {
    await closeDriver();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
  }
);
```

- [ ] **Step 4: Register the npm script**

In `package.json`, after the line `"migrate-to-podman": "bash scripts/migrate-to-podman.sh",` add:

```json
    "migrate-to-sqlite": "node scripts/migrate-to-sqlite.mjs",
```

- [ ] **Step 5: Add the CHANGELOG entry**

In `memory/CHANGELOG.md`, directly under `## Unreleased` and a blank line, add:

```markdown
- **Added** `npm run migrate-to-sqlite`, which copies the memory graph into
  `~/.claude-neo4j/memory.sqlite` and checks every row against Neo4j: each
  entity, observation, relation and session must exist with identical fields, and
  session links are rebuilt from session ids. Neo4j is only read and the plugin's
  config is unchanged; nothing uses the SQLite file yet. It reads the graph twice
  and copies only once both reads match, so it runs while sessions are open, and
  a re-run adds whatever was written since. Exit codes: 0 nothing missing or
  changed, 1 the check failed, 2 it could not run. `--check-only` checks an
  existing file without writing to it.

```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/migrate-cli.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add scripts/migrate-to-sqlite.mjs package.json memory/CHANGELOG.md tests/migrate-cli.test.js
git commit -m "feat(memory): Add the migrate-to-sqlite command" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Rehearsal against a throwaway Neo4j

**Files:**
- Test: `tests/migrate-rehearsal.test.js`

**Interfaces:**
- Consumes:
  - `readGraph` (Task 7), `runMigration` (Task 8)
  - `openMemoryDb` (Task 1), `readSqliteGraph` (Task 4), `fingerprint` (Task 2)
  - `fixtureRecords` (Task 2)
- Produces: nothing. This is the only test of the Cypher in `readNeo4j.js` and of the CLI's success path.

- [ ] **Step 1: Write the test**

`tests/migrate-rehearsal.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import neo4j from "neo4j-driver";
import { readGraph } from "../src/lib/migrate/readNeo4j.js";
import { runMigration } from "../src/lib/migrate/runMigration.js";
import { readSqliteGraph } from "../src/lib/migrate/readSqlite.js";
import { fingerprint } from "../src/lib/migrate/fingerprint.js";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { fixtureRecords } from "./helpers/graphFixture.js";

const URI = process.env.CLAUDE_NEO4J_REHEARSAL_URI;
const PASSWORD = process.env.CLAUDE_NEO4J_REHEARSAL_PASSWORD;
const SKIP =
  !URI || !PASSWORD
    ? "set CLAUDE_NEO4J_REHEARSAL_URI and CLAUDE_NEO4J_REHEARSAL_PASSWORD to rehearse against a throwaway Neo4j"
    : false;

// Every test wipes the database it points at, so it refuses the real graph's
// port. Bolt's default port is 7687, so an omitted port is refused too.
if (URI) {
  const port = new URL(URI.replace(/^[a-z0-9+.-]+:/i, "http:")).port;
  if (port === "7687" || port === "") {
    throw new Error("CLAUDE_NEO4J_REHEARSAL_URI points at port 7687, the real memory graph; use a throwaway on another port");
  }
}

const SCRIPT = fileURLToPath(new URL("../scripts/migrate-to-sqlite.mjs", import.meta.url));
const driver = SKIP ? null : neo4j.driver(URI, neo4j.auth.basic("neo4j", PASSWORD));
after(async () => {
  await driver?.close();
});

const quiet = () => {};
const out = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-rehearsal-")), "memory.sqlite");
const ms = (value) => (value === null ? null : neo4j.int(value));

async function readOnce() {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    return await readGraph(session);
  } finally {
    await session.close();
  }
}

async function write(query, params = {}) {
  const session = driver.session();
  try {
    await session.run(query, params);
  } finally {
    await session.close();
  }
}

// Builds the fixture as a Neo4j graph: global entities get a null project,
// absent values are left unset, and PRODUCED exists only where the Session does.
async function seed(records) {
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run("MATCH (n) DETACH DELETE n");
      for (const e of records.entities) {
        await tx.run(
          `CREATE (e:Entity {name: $name, createdAt: datetime({epochMillis: $createdAt})})
           SET e.project = CASE $project WHEN '' THEN null ELSE $project END,
               e.type = $type,
               e.updatedAt = CASE WHEN $updatedAt IS NULL THEN null ELSE datetime({epochMillis: $updatedAt}) END`,
          { name: e.name, project: e.project, type: e.type, createdAt: ms(e.createdAt), updatedAt: ms(e.updatedAt) }
        );
      }
      for (const s of records.sessions) {
        await tx.run(
          `CREATE (s:Session {id: $id, startedAt: datetime({epochMillis: $startedAt})})
           SET s.cwd = $cwd, s.project = $project`,
          { id: s.id, cwd: s.cwd, project: s.project, startedAt: ms(s.startedAt) }
        );
      }
      for (const o of [...records.observations].sort((a, b) => a.seq - b.seq)) {
        await tx.run(
          `MATCH (e:Entity {name: $entityName}) WHERE coalesce(e.project, '') = $entityProject
           CREATE (o:Observation {id: $id, text: $text, createdAt: datetime({epochMillis: $createdAt})})-[:ABOUT]->(e)
           SET o.subsystem = $subsystem, o.sessionId = $sessionId
           WITH o
           OPTIONAL MATCH (s:Session {id: $sessionId})
           FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | CREATE (s)-[:PRODUCED]->(o))`,
          {
            id: o.id,
            entityName: o.entityName,
            entityProject: o.entityProject,
            text: o.text,
            subsystem: o.subsystem,
            sessionId: o.sessionId,
            createdAt: ms(o.createdAt),
          }
        );
      }
      for (const r of records.relations) {
        await tx.run(
          `MATCH (a:Entity {name: $fromName}) WHERE coalesce(a.project, '') = $fromProject
           MATCH (b:Entity {name: $toName}) WHERE coalesce(b.project, '') = $toProject
           CREATE (a)-[rel:RELATES_TO {type: $type}]->(b)
           SET rel.createdAt = CASE WHEN $createdAt IS NULL THEN null ELSE datetime({epochMillis: $createdAt}) END`,
          { ...r, createdAt: ms(r.createdAt) }
        );
      }
    });
  } finally {
    await session.close();
  }
}

const addObservation = (id) =>
  write(
    `MATCH (e:Entity {name: 'user'}) WHERE e.project IS NULL
     CREATE (:Observation {id: $id, text: 'written mid-migration', createdAt: datetime({epochMillis: timestamp()})})-[:ABOUT]->(e)`,
    { id }
  );

test("a full copy of the seeded graph passes and matches the fixture exactly", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  const file = out();
  const { exitCode } = await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  assert.equal(exitCode, 0);
  const db = openMemoryDb(file, { readOnly: true });
  assert.deepEqual(fingerprint(readSqliteGraph(db)), fingerprint(fixtureRecords()));
  db.close();
});

test("a write landing between reads forces another read and is included", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  let reads = 0;
  const racingRead = async () => {
    const records = await readOnce();
    if (++reads === 1) await addObservation("obs-raced");
    return records;
  };
  const { exitCode, report } = await runMigration({ readOnce: racingRead, out: out(), sourceLabel: URI, log: quiet });
  assert.equal(exitCode, 0);
  assert.ok(report.reads >= 3, `expected a retry, got ${report.reads} reads`);
  assert.equal(report.comparison.types.observations.source, 7);
});

test("observations written after a copy are added by the next run", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  const file = out();
  await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  await addObservation("obs-after");
  const { exitCode, report } = await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  assert.equal(exitCode, 0);
  assert.equal(report.write.inserted.observations, 1);
});

test("updates and deletes after a copy are reported and not applied", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  const file = out();
  await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  await write("MATCH (e:Entity {name: 'ticket:APP-1'}) SET e.type = 'ticket'");
  await write("MATCH (o:Observation {id: 'obs-3'}) DETACH DELETE o");
  const { exitCode, report } = await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  assert.equal(exitCode, 1);
  assert.deepEqual(report.comparison.types.entities.changed.map((row) => row.fields), [["type"]]);
  assert.deepEqual(report.comparison.types.observations.extra, ['["obs-3"]']);
});

test("the command exits 0 against the rehearsal graph", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  const file = out();
  const result = spawnSync(process.execPath, ["--no-warnings", SCRIPT, "--out", file], {
    env: {
      ...process.env,
      HOME: path.dirname(file),
      NEO4J_URI: URI,
      NEO4J_USERNAME: "neo4j",
      NEO4J_PASSWORD: PASSWORD,
      NEO4J_DATABASE: "neo4j",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS /m);
});
```

- [ ] **Step 2: Confirm the gate keeps it out of normal runs**

Run: `node --test tests/migrate-rehearsal.test.js`
Expected: 5 tests skipped, 0 failed.

- [ ] **Step 3: Start a throwaway Neo4j on localhost:7688**

The image is already on this machine, so nothing is downloaded. `--rm` removes the container when it stops.
The memory caps matter: the Podman VM has 2 GB, and the real memory graph runs in the same VM.

```bash
export CLAUDE_NEO4J_REHEARSAL_PASSWORD="$(openssl rand -hex 16)"
export CLAUDE_NEO4J_REHEARSAL_URI="bolt://localhost:7688"
podman run -d --rm --name neo4j-rehearsal -p 127.0.0.1:7688:7687 -e NEO4J_AUTH="neo4j/$CLAUDE_NEO4J_REHEARSAL_PASSWORD" -e NEO4J_server_memory_heap_max__size=256m -e NEO4J_server_memory_pagecache_size=64m docker.io/library/neo4j:5-community
until podman exec neo4j-rehearsal cypher-shell -u neo4j -p "$CLAUDE_NEO4J_REHEARSAL_PASSWORD" "RETURN 1" >/dev/null 2>&1; do sleep 2; done
```

- [ ] **Step 4: Run the rehearsal**

Run: `node --test tests/migrate-rehearsal.test.js`
Expected: PASS, 5 tests.
If "matches the fixture exactly" fails, the Cypher in `readNeo4j.js` or the `toRecords` mapping disagrees with the fixture. Fix the code, not the fixture.

- [ ] **Step 5: Stop the throwaway Neo4j**

```bash
podman stop neo4j-rehearsal
unset CLAUDE_NEO4J_REHEARSAL_URI CLAUDE_NEO4J_REHEARSAL_PASSWORD
```

- [ ] **Step 6: Commit**

```bash
git add tests/migrate-rehearsal.test.js
git commit -m "test(memory): Rehearse the migration against a throwaway Neo4j" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Full suite and acceptance on the real graph

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-sqlite-migration-design.md` (status line)

**Interfaces:**
- Consumes: everything above. The real graph is only read.
- Produces: the acceptance evidence for the PR description.

- [ ] **Step 1: Run every suite**

```bash
bash tests/launcher-path.test.sh
bash tests/image-name.test.sh
bash tests/boot-persistence.test.sh
bash tests/engine-resolve.test.sh
node --test tests/*.test.js
```

Expected:
- The three bash suites before `engine-resolve` pass.
- `engine-resolve.test.sh` shows only the pre-existing failure from "Before you start".
- `node --test` reports 114 old tests plus the new ones passing, with the 5 rehearsal tests skipped.

`npm test` chains with `&&`, so it stops at `engine-resolve` and never reaches the node tests. That is why the suites run separately here.

- [ ] **Step 2: Migrate the real graph into a scratch file**

Neo4j is only read: every query runs inside `executeRead`, which Neo4j refuses to write in. The default `~/.claude-neo4j/memory.sqlite` is not touched.

```bash
ACCEPT="$(mktemp -d)"
npm run migrate-to-sqlite -- --out "$ACCEPT/memory.sqlite"
echo "first run exit: $?"
npm run migrate-to-sqlite -- --out "$ACCEPT/memory.sqlite"
echo "second run exit: $?"
```

Expected:
- **First run:** exit 0 and `PASS`. Missing and changed are 0 in every row. The source counts are close to the live graph's (about 3,800 entities, 11,900 observations, 3,700 relations, 1,600 sessions and 10,200 session links on 2026-10-09; it grows daily). Integrity is ok and foreign keys are ok.
- **Second run:** exit 0 and `PASS`. Inserted is 0, unless captures landed between the runs, in which case it equals what they added.
- Copy both summaries into the PR description.

- [ ] **Step 3: Remove the scratch copy**

It is a full copy of every project's memory.

```bash
rm -rf "$ACCEPT"
```

- [ ] **Step 4: Record the result in the spec**

In `docs/superpowers/specs/2026-10-09-sqlite-migration-design.md`, replace the status line:

```markdown
**Status**: implemented on `feat/memory-sqlite-migration`; acceptance on the live graph passed (YYYY-MM-DD)
```

Use the date of the acceptance run in place of `YYYY-MM-DD`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-09-sqlite-migration-design.md
git commit -m "docs(memory): Record the SQLite migration acceptance run" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
