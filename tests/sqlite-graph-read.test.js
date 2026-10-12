import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { closeDb, getDb } from "../src/lib/memoryStore.js";
import * as graph from "../src/lib/graph.js";

const P = "github.com/acme/app";
const DAY = 86_400_000;
const rows = (sql, ...params) => getDb().prepare(sql).all(...params);
const setTime = (text, ms) => getDb().prepare("UPDATE observations SET created_at = ? WHERE text = ?").run(ms, text);

beforeEach(() => {
  useTempStore();
});

after(() => {
  closeDb();
});

test("getEntity lists newest first, breaking same-millisecond ties by insertion", async () => {
  await graph.addObservations({ entity: "decision:x", project: P, observations: ["first", "second", "third"] });
  const entity = await graph.getEntity("decision:x", P);
  assert.deepEqual(entity.observations.map((o) => o.text), ["third", "second", "first"]);
  assert.equal(entity.observationCount, 3);
  assert.match(entity.observations[0].createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("getEntity windows by limit but reports the true count", async () => {
  await graph.addObservations({ entity: "decision:x", project: P, observations: ["a", "b", "c"] });
  const windowed = await graph.getEntity("decision:x", P, { limit: 2 });
  assert.equal(windowed.observations.length, 2);
  assert.equal(windowed.observationCount, 3);
  assert.equal((await graph.getEntity("decision:x", P, { limit: null })).observations.length, 3);
});

test("getEntity separates outgoing from incoming relations", async () => {
  await graph.createRelation({ from: "alpha", to: "bravo", type: "uses", project: P });
  await graph.createRelation({ from: "charlie", to: "alpha", type: "blocks", project: P });
  const alpha = await graph.getEntity("alpha", P);
  assert.deepEqual(alpha.outgoing, [{ type: "uses", entity: "bravo" }]);
  assert.deepEqual(alpha.incoming, [{ type: "blocks", entity: "charlie" }]);
});

test("getEntity prefers this project's entity over a global one, and returns null for an unknown name", async () => {
  await graph.addObservations({ entity: "user", project: null, observations: ["global"] });
  await graph.addObservations({ entity: "user", project: P, observations: ["local"] });
  assert.equal((await graph.getEntity("user", P)).observations[0].text, "local");
  assert.equal((await graph.getEntity("user", "github.com/acme/other")).project, null);
  assert.equal(await graph.getEntity("nobody", P), null);
});

test("getRecentContext orders entities by their newest observation and keeps three each", async () => {
  await graph.addObservations({ entity: "decision:old", project: P, observations: ["o1", "o2", "o3", "o4"] });
  await graph.addObservations({ entity: "decision:new", project: P, observations: ["n1"] });
  setTime("n1", Date.now() + 1000);
  const recent = await graph.getRecentContext({ project: P });
  assert.deepEqual(recent.map((r) => r.name), ["decision:new", "decision:old"]);
  assert.deepEqual(recent[1].observations.map((o) => o.text), ["o4", "o3", "o2"]);
});

test("getTimeline runs oldest first, honours since, and reports truncation", async () => {
  await graph.addObservations({ entity: "decision:t", project: P, observations: ["early", "middle", "late"] });
  const now = Date.now();
  setTime("early", now - 3 * DAY);
  setTime("middle", now - 2 * DAY);
  setTime("late", now - DAY);
  const all = await graph.getTimeline({ project: P });
  assert.deepEqual(all.events.map((e) => e.text), ["early", "middle", "late"]);
  const since = await graph.getTimeline({ project: P, since: new Date(now - 2 * DAY - 1000).toISOString() });
  assert.deepEqual(since.events.map((e) => e.text), ["middle", "late"]);
  const clipped = await graph.getTimeline({ project: P, limit: 1 });
  assert.deepEqual([clipped.total, clipped.returned, clipped.truncated], [3, 1, true]);
});

test("getTimeline rejects a since that is not a date", async () => {
  await assert.rejects(() => graph.getTimeline({ project: P, since: "around lunchtime" }), /not a date/);
});

test("deleteObservations removes only the named entity's observations, and their search rows", async () => {
  const [keep, drop] = await graph.addObservations({ entity: "decision:d", project: P, observations: ["keep pnpm", "drop yarn"] });
  const [foreign] = await graph.addObservations({ entity: "decision:other", project: P, observations: ["other yarn"] });
  assert.equal(await graph.deleteObservations("decision:d", [drop, foreign], P), 1);
  assert.deepEqual(rows("SELECT id FROM observations ORDER BY rowid").map((r) => r.id), [keep, foreign]);
  assert.equal(rows("SELECT rowid FROM observation_text_fts WHERE observation_text_fts MATCH ?", '"yarn"').length, 1);
});

test("deleteEntity removes its observations, relations and search rows", async () => {
  await graph.addObservations({ entity: "decision:gone", project: P, observations: ["vanishing pnpm"] });
  await graph.createRelation({ from: "decision:gone", to: "decision:stays", type: "uses", project: P });
  await graph.deleteEntity("decision:gone", P);
  assert.deepEqual(rows("SELECT name FROM entities").map((r) => r.name), ["decision:stays"]);
  assert.equal(rows("SELECT count(*) AS n FROM observations")[0].n, 0);
  assert.equal(rows("SELECT count(*) AS n FROM relations")[0].n, 0);
  assert.equal(rows("SELECT rowid FROM entity_name_fts WHERE entity_name_fts MATCH ?", '"decision:gone"').length, 0);
  assert.equal(rows("SELECT rowid FROM observation_text_fts WHERE observation_text_fts MATCH ?", '"vanishing"').length, 0);
});

test("pruneObservations keeps each entity's newest old observations, and a dry run deletes nothing", async () => {
  await graph.addObservations({ entity: "decision:p", project: P, observations: ["p1", "p2", "p3", "p4", "p5", "fresh"] });
  const old = Date.now() - 200 * DAY;
  ["p1", "p2", "p3", "p4", "p5"].forEach((text, i) => setTime(text, old + i));
  const dry = await graph.pruneObservations({ project: P, dryRun: true });
  assert.equal(dry.pruned, 2);
  assert.deepEqual(dry.sample.map((s) => s.text).sort(), ["p1", "p2"]);
  assert.equal(rows("SELECT count(*) AS n FROM observations")[0].n, 6);
  const real = await graph.pruneObservations({ project: P });
  assert.equal(real.pruned, 2);
  assert.deepEqual(rows("SELECT text FROM observations ORDER BY text").map((r) => r.text), ["fresh", "p3", "p4", "p5"]);
});
