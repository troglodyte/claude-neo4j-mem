import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb, integrityReport, syncFullText, SCHEMA_VERSION } from "../src/lib/sqliteDb.js";

// A path inside a directory that does not exist yet, as on a fresh machine.
function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-db-"));
  return path.join(dir, "nested", "memory.sqlite");
}

const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test("a new file gets the schema, the current version and mode 0600", () => {
  const file = tempFile();
  const db = openMemoryDb(file);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["entities", "migrations", "observations", "relations", "sessions"]);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  db.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test("a new file has full-text tables for entity names and observation text", () => {
  const db = openMemoryDb(tempFile());
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE name IN ('entity_name_fts', 'observation_text_fts') ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(names, ["entity_name_fts", "observation_text_fts"]);
  db.close();
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

test("observations and sessions refuse a NULL id", () => {
  const db = openMemoryDb(tempFile());
  db.exec("INSERT INTO entities (id, name, project, created_at) VALUES (1, 'a', 'p', 1)");
  assert.throws(
    () => db.exec("INSERT INTO observations (id, entity_id, text, created_at) VALUES (NULL, 1, 'x', 1)"),
    /NOT NULL constraint failed: observations\.id/
  );
  assert.throws(() => db.exec("INSERT INTO sessions (id, started_at) VALUES (NULL, 1)"), /NOT NULL constraint failed: sessions\.id/);
  db.close();
});

test("an existing database that is not a memory store is refused and left untouched", () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const other = new DatabaseSync(file);
  other.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep me');");
  other.close();
  assert.throws(() => openMemoryDb(file), /not a memory database/);
  const check = new DatabaseSync(file, { readOnly: true });
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.deepEqual(tables, ["notes"]);
  assert.equal(check.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  check.close();
});

test("opening a memory store for writing resets its mode to 0600", () => {
  const file = tempFile();
  openMemoryDb(file).close();
  fs.chmodSync(file, 0o644);
  openMemoryDb(file).close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// What the migration's version-1 file looks like: base tables, no full-text tables.
function versionOneFile() {
  const file = tempFile();
  const db = openMemoryDb(file);
  db.exec(`
    INSERT INTO entities (id, name, project, created_at) VALUES (1, 'feature:capture-visibility', 'p', 1);
    INSERT INTO observations (id, entity_id, text, created_at) VALUES ('o1', 1, 'the capture hook runs at session end', 1);
    DROP TABLE entity_name_fts;
    DROP TABLE observation_text_fts;
    PRAGMA user_version = 1;
  `);
  db.close();
  return file;
}

const matches = (db, table, word) =>
  db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(`"${word}"`).length;

test("a version-1 file is upgraded to version 2 with its full-text rows filled", () => {
  const db = openMemoryDb(versionOneFile());
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(matches(db, "entity_name_fts", "feature:capture"), 1);
  assert.equal(matches(db, "observation_text_fts", "hook"), 1);
  db.close();
});

test("a read-only open accepts a version-1 file and leaves it alone", () => {
  const file = versionOneFile();
  const db = openMemoryDb(file, { readOnly: true });
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(integrityReport(db).ok, true);
  db.close();
});

test("syncFullText indexes rows written without it and forgets deleted ones", () => {
  const db = openMemoryDb(tempFile());
  db.exec(`
    INSERT INTO entities (id, name, project, created_at) VALUES (1, 'decision:pnpm', 'p', 1);
    INSERT INTO observations (id, entity_id, text, created_at) VALUES ('o1', 1, 'prefers pnpm', 1);
  `);
  assert.deepEqual(syncFullText(db), { entities: 1, observations: 1 });
  assert.equal(matches(db, "observation_text_fts", "pnpm"), 1);
  db.exec("DELETE FROM observations WHERE id = 'o1'");
  syncFullText(db);
  assert.equal(matches(db, "observation_text_fts", "pnpm"), 0);
  db.close();
});
