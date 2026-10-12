import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexText } from "./segment.js";

// The SQLite memory store's schema. Version 1 is the migration's
// (2026-10-09-sqlite-migration-design.md); version 2 adds the full-text tables
// (2026-10-09-sqlite-engine-design.md). Writable opens upgrade 1 to 2;
// read-only opens accept either.
export const SCHEMA_VERSION = 2;
const READABLE_VERSIONS = [1, 2];
const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;

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
  id          TEXT    NOT NULL PRIMARY KEY,
  entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  subsystem   TEXT,
  source      TEXT,
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
  id          TEXT    NOT NULL PRIMARY KEY,
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

// Rows hold the text pre-segmented by segment.js and joined with spaces; the
// token characters are the in-word punctuation UAX #29 keeps, so each segmented
// word reaches the index as exactly one token.
const FULL_TEXT_SQL = `
CREATE VIRTUAL TABLE entity_name_fts USING fts5(words, tokenize = "unicode61 tokenchars ':._'',·'");
CREATE VIRTUAL TABLE observation_text_fts USING fts5(words, tokenize = "unicode61 tokenchars ':._'',·'");
`;

/**
 * Opens the memory database, creating it and its schema on first open. A new
 * file is created 0600 before SQLite touches it, inside a 0700 directory if one
 * has to be made, and a writable open resets the mode to 0600, so memory text
 * is never readable by other users, not even briefly.
 *
 * A file at schema version 0 is initialised only if it is empty: a mistyped
 * path must not turn someone else's database into this one, or switch its
 * journal mode.
 */
export function openMemoryDb(file, { readOnly = false } = {}) {
  if (!readOnly && !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      fs.closeSync(fs.openSync(file, "wx", 0o600));
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    const version = userVersion(db);
    if (version === 0) {
      // Tables but no version is someone else's database. Read the version again
      // before deciding: a store another process finished creating after the
      // first read has its version by now.
      if (readOnly || (!isEmpty(db) && userVersion(db) === 0)) {
        throw new Error(`${file} is not a memory database; refusing to use it`);
      }
      useWal(db);
      createSchema(db);
    } else if (!READABLE_VERSIONS.includes(version)) {
      throw new Error(`${file} has schema version ${version}; this code expects ${SCHEMA_VERSION}`);
    } else if (!readOnly) {
      useWal(db);
      if (version < SCHEMA_VERSION) {
        upgradeSchema(db);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
  if (!readOnly) {
    fs.chmodSync(file, 0o600);
  }
  return db;
}

// BEGIN IMMEDIATE takes the write lock before the version is read again, so
// two processes opening the same new file cannot both create the schema.
function createSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (userVersion(db) === 0) {
      db.exec(`${SCHEMA_SQL} ${FULL_TEXT_SQL} PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Version 1 (what the migration wrote) to 2: add the full-text tables and fill them.
function upgradeSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (userVersion(db) === 1) {
      db.exec(FULL_TEXT_SQL);
      syncFullText(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Makes the full-text rows match the base tables: indexes entities and
 * observations that have no full-text row, and drops full-text rows whose base
 * row is gone. The engine maintains them per write; this covers bulk writers
 * (the migration) and the version upgrade. Call inside a transaction.
 */
export function syncFullText(db) {
  const entities = db.prepare("SELECT id, name FROM entities WHERE id NOT IN (SELECT rowid FROM entity_name_fts)").all();
  const addEntity = db.prepare("INSERT INTO entity_name_fts (rowid, words) VALUES (?, ?)");
  for (const row of entities) {
    addEntity.run(row.id, indexText(row.name));
  }
  const observations = db
    .prepare("SELECT rowid AS rid, text FROM observations WHERE rowid NOT IN (SELECT rowid FROM observation_text_fts)")
    .all();
  const addObservation = db.prepare("INSERT INTO observation_text_fts (rowid, words) VALUES (?, ?)");
  for (const row of observations) {
    addObservation.run(row.rid, indexText(row.text));
  }
  db.exec("DELETE FROM entity_name_fts WHERE rowid NOT IN (SELECT id FROM entities)");
  db.exec("DELETE FROM observation_text_fts WHERE rowid NOT IN (SELECT rowid FROM observations)");
  return { entities: entities.length, observations: observations.length };
}

// Switching to WAL takes an exclusive lock without waiting on busy_timeout, so
// two processes opening a brand-new store at once (the session-start hook and
// the memory server, on a first session) collide here. Retry for as long as
// the busy timeout would have waited.
function useWal(db) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; ; waited += 20) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (error) {
      if ((error.errcode & 0xff) !== SQLITE_BUSY || waited >= BUSY_TIMEOUT_MS) {
        throw error;
      }
      Atomics.wait(pause, 0, 0, 20);
    }
  }
}

function userVersion(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

function isEmpty(db) {
  return db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n === 0;
}

/** SQLite's own consistency checks, summarised: what the migration's verdict requires besides the row check. */
export function integrityReport(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  const { user_version: userVersion } = db.prepare("PRAGMA user_version").get();
  const ok =
    integrity.length === 1 && integrity[0] === "ok" && foreignKeyViolations === 0 && READABLE_VERSIONS.includes(userVersion);
  return { integrity, foreignKeyViolations, userVersion, ok };
}
