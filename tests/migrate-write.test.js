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

test("graph content the migration does not carry is rejected before anything is written", () => {
  const db = freshDb();
  const records = fixtureRecords();
  records.unmapped = ["Observation.mood on 2 node(s) is not migrated"];
  assert.throws(
    () => writeGraph(db, records),
    (error) => error instanceof InvalidRecordsError && error.message.includes("Observation.mood on 2 node(s) is not migrated")
  );
  assert.equal(count(db, "entities"), 0);
  db.close();
});

test("a written graph is searchable by word", () => {
  const db = freshDb();
  writeGraph(db, fixtureRecords());
  const hits = db
    .prepare("SELECT o.id FROM observation_text_fts JOIN observations o ON o.rowid = observation_text_fts.rowid WHERE observation_text_fts MATCH ?")
    .all('"pnpm"')
    .map((row) => row.id);
  assert.deepEqual(hits, ["obs-5"]);
  db.close();
});
