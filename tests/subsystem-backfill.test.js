import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { getDb, closeDb } from "../src/lib/memoryStore.js";
import { pendingEntities, writeTags } from "../src/lib/subsystemBackfill.js";

let nextObservation = 0;

function addEntity(db, { name, project, type = null }) {
  return Number(
    db.prepare("INSERT INTO entities (name, project, type, created_at) VALUES (?, ?, ?, 0)").run(name, project, type)
      .lastInsertRowid,
  );
}

function addObservation(db, entityId, { subsystem = null, text = "a fact" } = {}) {
  const id = `obs-${nextObservation++}`;
  db.prepare("INSERT INTO observations (id, entity_id, text, subsystem, created_at) VALUES (?, ?, ?, ?, 0)").run(
    id,
    entityId,
    text,
    subsystem,
  );
  return id;
}

function subsystemOf(id) {
  return getDb().prepare("SELECT subsystem FROM observations WHERE id = ?").get(id).subsystem;
}

beforeEach(() => {
  useTempStore();
});

after(() => {
  closeDb();
});

test("selects untagged observations, grouped by entity, largest entity first", () => {
  const db = getDb();
  const small = addEntity(db, { name: "small", project: "p", type: "decision" });
  const big = addEntity(db, { name: "big", project: "p" });
  const a = addObservation(db, small, { text: "alpha" });
  addObservation(db, small, { subsystem: "search" });
  const b = addObservation(db, big);
  const c = addObservation(db, big);

  assert.deepEqual(pendingEntities(db, {}), [
    {
      name: "big",
      type: null,
      project: "p",
      pending: 2,
      observations: [
        { id: b, text: "a fact" },
        { id: c, text: "a fact" },
      ],
    },
    { name: "small", type: "decision", project: "p", pending: 1, observations: [{ id: a, text: "alpha" }] },
  ]);
});

test("--project scopes the selection to one project", () => {
  const db = getDb();
  addObservation(db, addEntity(db, { name: "a", project: "p" }));
  addObservation(db, addEntity(db, { name: "a", project: "q" }));

  assert.deepEqual(
    pendingEntities(db, { project: "q" }).map((e) => e.project),
    ["q"],
  );
});

test("--retag selects observations carrying that tag instead of untagged ones", () => {
  const db = getDb();
  const e = addEntity(db, { name: "a", project: "p" });
  addObservation(db, e);
  const tagged = addObservation(db, e, { subsystem: "general" });

  assert.deepEqual(
    pendingEntities(db, { retag: "general" }).flatMap((x) => x.observations.map((o) => o.id)),
    [tagged],
  );
});

test("writes tags, clears a tag written as null, and counts distinct observations", () => {
  const db = getDb();
  const e = addEntity(db, { name: "a", project: "p" });
  const first = addObservation(db, e);
  const second = addObservation(db, e, { subsystem: "general" });

  const updated = writeTags(db, [
    { id: first, subsystem: "wrong" },
    { id: first, subsystem: "search" },
    { id: second, subsystem: null },
    { id: "no-such-observation", subsystem: "x" },
  ]);

  assert.equal(updated, 2);
  assert.equal(subsystemOf(first), "search");
  assert.equal(subsystemOf(second), null);
});
