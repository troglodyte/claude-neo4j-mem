import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { closeDb } from "../src/lib/memoryStore.js";
import * as graph from "../src/lib/graph.js";

const P = "github.com/acme/app";
// Word overlaps: F2 vs F1 = 8/9 (0.89, a repeat); F3 vs F1 = 7/9 (0.78, kept);
// F3 vs F2 = 7/10 (0.70, kept).
const F1 = "alpha bravo charlie delta echo foxtrot golf hotel";
const F2 = "alpha bravo charlie delta echo foxtrot golf hotel india";
const F3 = "alpha bravo charlie delta echo foxtrot golf kilo";

async function addFact(text, project = P) {
  await graph.addObservations({ entity: "preference:style", entityType: "preference", project, observations: [text] });
}

beforeEach(async () => {
  useTempStore();
  await addFact(F1);
  await addFact(F3);
  await addFact(F2);
  await graph.addObservations({ entity: "decision:noise", entityType: "decision", project: P, observations: ["not a standing fact"] });
});

after(() => {
  closeDb();
});

test("repeats at overlap 0.8 or more collapse to the newest, and are counted", async () => {
  const pinned = await graph.getPinnedFacts({ project: P });
  assert.deepEqual(pinned.facts.map((f) => f.text), [F2, F3]);
  assert.equal(pinned.collapsed, 1);
  assert.equal(pinned.total, 3);
});

test("collapsed repeats are not reported as truncation", async () => {
  const pinned = await graph.getPinnedFacts({ project: P });
  assert.equal(pinned.returned, 2);
  assert.equal(pinned.truncated, false);
});

test("findRepeatedFacts lists likely repeats most similar first, with the ids to delete", async () => {
  const pairs = await graph.findRepeatedFacts({ project: P });
  assert.deepEqual(
    pairs.map((p) => [p.newer.text, p.older.text, Number(p.similarity.toFixed(2))]),
    [
      [F2, F1, 0.89],
      [F3, F1, 0.78],
      [F2, F3, 0.7],
    ]
  );
  assert.match(pairs[0].older.id, /^[0-9a-f-]{36}$/);
  assert.equal(pairs[0].older.entity, "preference:style");
});

test("findRepeatedFacts honours min", async () => {
  assert.equal((await graph.findRepeatedFacts({ project: P, min: 0.75 })).length, 2);
});

test("findRepeatedFacts with no project pairs facts only within one scope", async () => {
  await addFact(F1, "github.com/acme/other");
  const pairs = await graph.findRepeatedFacts({ min: 0.95 });
  assert.equal(pairs.length, 0, "the same text in two projects is not a repeat any session sees");
});
