import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { runCatchUp, catchUpDue, CATCH_UP_DAYS } from "../src/lib/catchUp.js";

const DAY = 24 * 60 * 60 * 1000;
const SWITCH = Date.UTC(2026, 9, 12, 12);

// A store that moved to SQLite at SWITCH, holding one entity created before it.
function store({ passed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catch-up-"));
  const dbPath = path.join(dir, "memory.sqlite");
  const db = openMemoryDb(dbPath);
  if (passed) {
    db.prepare("INSERT INTO migrations (source, started_at, finished_at, counts, result) VALUES ('test', ?, ?, '{}', 'passed')").run(SWITCH - 1000, SWITCH);
  }
  db.prepare("INSERT INTO entities (name, project, type, created_at, updated_at) VALUES ('decision:old', 'p', 'decision', ?, NULL)").run(SWITCH - DAY);
  db.close();
  return { dbPath, stateDir: path.join(dir, "state"), log: () => {} };
}

const entity = (name, createdAt, type = "decision") => ({ name, project: "p", type, createdAt, updatedAt: null });
const observation = (id, entityName, createdAt) => ({
  id,
  entityName,
  entityProject: "p",
  text: `fact ${id}`,
  subsystem: null,
  source: null,
  sessionId: null,
  createdAt,
  seq: createdAt,
});
const graph = ({ entities = [entity("decision:old", SWITCH - DAY)], observations = [], relations = [], sessions = [] } = {}) => ({
  entities,
  observations,
  relations,
  sessions,
  sessionLinks: [],
  unmapped: [],
});
const reader = (records) => async () => structuredClone(records);
const ids = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT id FROM observations ORDER BY id").all().map((row) => row.id);
  } finally {
    db.close();
  }
};

test("rows created after the switch are copied, with the new entities they need, and older rows are not", async () => {
  const s = store();
  const records = graph({
    entities: [entity("decision:old", SWITCH - DAY), entity("decision:new", SWITCH + 500)],
    observations: [observation("before", "decision:old", SWITCH - 10), observation("after", "decision:old", SWITCH + 1000), observation("new", "decision:new", SWITCH + 2000)],
  });
  const result = await runCatchUp({ ...s, readOnce: reader(records), now: SWITCH + DAY });
  assert.deepEqual(ids(s.dbPath), ["after", "new"]);
  assert.equal(result.copied.observations, 2);
});

test("a pre-switch entity deleted in SQLite does not come back, and its new rows are dropped", async () => {
  const s = store();
  const db = new DatabaseSync(s.dbPath);
  db.exec("DELETE FROM entities WHERE name = 'decision:old'");
  db.close();
  await runCatchUp({ ...s, readOnce: reader(graph({ observations: [observation("after", "decision:old", SWITCH + 1000)] })), now: SWITCH + DAY });
  const check = new DatabaseSync(s.dbPath, { readOnly: true });
  assert.equal(check.prepare("SELECT count(*) AS n FROM entities WHERE name = 'decision:old'").get().n, 0);
  check.close();
  assert.deepEqual(ids(s.dbPath), []);
});

test("updates made in Neo4j are ignored", async () => {
  const s = store();
  const records = graph({ entities: [entity("decision:old", SWITCH - DAY, "constraint")], observations: [observation("after", "decision:old", SWITCH + 1000)] });
  await runCatchUp({ ...s, readOnce: reader(records), now: SWITCH + DAY });
  const db = new DatabaseSync(s.dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT type FROM entities WHERE name = 'decision:old'").get().type, "decision");
  db.close();
});

test("a copied row deleted in SQLite stays deleted on the next run", async () => {
  const s = store();
  const records = graph({ observations: [observation("after", "decision:old", SWITCH + 1000)] });
  await runCatchUp({ ...s, readOnce: reader(records), now: SWITCH + DAY });
  const db = new DatabaseSync(s.dbPath);
  db.exec("DELETE FROM observations WHERE id = 'after'");
  db.close();
  await runCatchUp({ ...s, readOnce: reader(records), now: SWITCH + 2 * DAY });
  assert.deepEqual(ids(s.dbPath), []);
});

test("nothing runs once the 7 days are over", async () => {
  const s = store();
  const result = await runCatchUp({ ...s, readOnce: reader(graph({ observations: [observation("after", "decision:old", SWITCH + 1000)] })), now: SWITCH + (CATCH_UP_DAYS + 1) * DAY });
  assert.equal(result.skipped, "outside the catch-up window");
  assert.deepEqual(ids(s.dbPath), []);
});

test("a store started fresh never catches up", () => {
  const s = store({ passed: false });
  const db = new DatabaseSync(s.dbPath, { readOnly: true });
  assert.equal(catchUpDue(db, { now: SWITCH + DAY }), false);
  db.close();
});

test("an unreachable Neo4j is skipped quietly", async () => {
  const s = store();
  const readOnce = async () => {
    throw new Error("connection refused");
  };
  assert.equal((await runCatchUp({ ...s, readOnce, now: SWITCH + DAY })).skipped, "neo4j unreachable");
});
