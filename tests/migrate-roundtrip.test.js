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

test("an observation's source survives the copy", () => {
  const db = copied();
  assert.equal(readSqliteGraph(db).observations.find((o) => o.id === "obs-5").source, "claude-mem");
  db.close();
});
