import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { closeDb, getDb } from "../src/lib/memoryStore.js";
import * as graph from "../src/lib/graph.js";

const P = "github.com/acme/app";
const DAY = 86_400_000;
const setTimeOf = (text, ms) => getDb().prepare("UPDATE observations SET created_at = ? WHERE text = ?").run(ms, text);
const names = (found) => found.results.map((r) => r.name);

beforeEach(() => {
  useTempStore();
});

after(() => {
  closeDb();
});

test("an entity matched only by its name is returned with its observations", async () => {
  await graph.addObservations({ entity: "decision:zzqx-storage-layout", project: P, observations: ["volumes are chosen by engine"] });
  const found = await graph.searchMemory("decision:zzqx-storage-layout", 10, P);
  assert.deepEqual(names(found), ["decision:zzqx-storage-layout"]);
  assert.equal(found.results[0].observations[0].text, "volumes are chosen by engine");
  assert.equal(found.relevance, "strong");
});

test("result rows keep the engine's original shape", async () => {
  await graph.addObservations({ entity: "decision:shape", project: P, observations: ["shape probe"] });
  const found = await graph.searchMemory("shape probe", 10, P);
  assert.deepEqual(Object.keys(found.results[0]).sort(), ["name", "observations", "relationCount", "relations", "score", "type"]);
});

test("best-matching observations come first, topped up with the newest, five at most", async () => {
  await graph.addObservations({
    entity: "decision:mixed",
    project: P,
    observations: ["zebrafinch one", "plain two", "plain three", "zebrafinch four", "plain five", "plain six", "plain seven"],
  });
  const [result] = (await graph.searchMemory("zebrafinch", 10, P)).results;
  assert.equal(result.observations.length, 5);
  assert.ok(result.observations.slice(0, 2).every((o) => o.text.startsWith("zebrafinch")));
  assert.deepEqual(result.observations.slice(2).map((o) => o.text), ["plain seven", "plain six", "plain five"]);
});

test("a project search sees its own and global entities but not other projects'", async () => {
  await graph.addObservations({ entity: "decision:here", project: P, observations: ["quokka here"] });
  await graph.addObservations({ entity: "user", project: null, observations: ["quokka global"] });
  await graph.addObservations({ entity: "decision:there", project: "github.com/acme/other", observations: ["quokka there"] });
  assert.deepEqual(names(await graph.searchMemory("quokka", 10, P)).sort(), ["decision:here", "user"]);
});

test("an old match decays below an equally good fresh one", async () => {
  await graph.addObservations({ entity: "decision:old", project: P, observations: ["wombat note"] });
  await graph.addObservations({ entity: "decision:new", project: P, observations: ["wombat memo"] });
  setTimeOf("wombat note", Date.now() - 300 * DAY);
  assert.deepEqual(names(await graph.searchMemory("wombat", 10, P)), ["decision:new", "decision:old"]);
});

test("relations in a result say which way they point", async () => {
  await graph.createRelation({ from: "decision:alpha", to: "decision:bravo", type: "uses", project: P });
  await graph.createRelation({ from: "decision:charlie", to: "decision:alpha", type: "blocks", project: P });
  await graph.createRelation({ from: "decision:alpha", to: "decision:alpha", type: "see-also", project: P });
  const found = await graph.searchMemory("decision:alpha", 10, P);
  const alpha = found.results.find((r) => r.name === "decision:alpha");
  assert.deepEqual(alpha.relations, [
    { type: "blocks", entity: "decision:charlie", direction: "in" },
    { type: "see-also", entity: "decision:alpha", direction: "self" },
    { type: "uses", entity: "decision:bravo", direction: "out" },
  ]);
});

test("a multi-word query whose best result holds one of its words is weak, with a note", async () => {
  await graph.addObservations({ entity: "decision:hook", project: P, observations: ["the capture hook runs at session end"] });
  const found = await graph.searchMemory("zzz-nonexistent-capture-qqq", 10, P);
  assert.equal(found.relevance, "weak");
  assert.match(found.note, /only one of your query's words/);
});

test("a subsystem filter narrows the matched observations", async () => {
  await graph.addObservations({
    entity: "fact:tagged",
    project: P,
    observations: [
      { text: "lemur capture fact", subsystem: "capture" },
      { text: "lemur backup fact", subsystem: "backup" },
    ],
  });
  const found = await graph.searchMemory("lemur", 10, P, { subsystem: "capture" });
  assert.deepEqual(found.results[0].observations.map((o) => o.text), ["lemur capture fact"]);
});

test("FTS5 syntax in a query is searched as plain words", async () => {
  await graph.addObservations({ entity: "decision:near", project: P, observations: ["near the value"] });
  const found = await graph.searchMemory('AND OR NOT NEAR "x" name:value* (a)', 10, P);
  assert.ok(Array.isArray(found.results));
});

test("a query with no words finds nothing and says so", async () => {
  await graph.addObservations({ entity: "decision:any", project: P, observations: ["anything"] });
  const found = await graph.searchMemory("-- !!", 10, P);
  assert.deepEqual(found.results, []);
  assert.equal(found.relevance, "none");
});

test("a miss here surfaces another project's covering match, labelled", async () => {
  await graph.addObservations({
    entity: "decision:elsewhere",
    project: "github.com/acme/other",
    observations: ["the quuxplorf handshake needs a zebrafinch retry", "second", "third"],
  });
  const found = await graph.searchMemory("quuxplorf zebrafinch", 10, P);
  assert.equal(found.results.length, 0);
  assert.equal(found.otherProjects.results[0].project, "github.com/acme/other");
  assert.equal(found.otherProjects.results[0].observations.length, 2);
});

// Full-text rows are keyed by the observations table's implicit rowid. SQLite
// keeps an indexed table's rowids through VACUUM (checked on 3.51); this pins
// that, because the day it stops, search returns the wrong observations.
test("search still finds the right observations after VACUUM", async () => {
  const [gone] = await graph.addObservations({ entity: "decision:vacuum", project: P, observations: ["first doomed note"] });
  await graph.addObservations({ entity: "decision:vacuum", project: P, observations: ["second ocelot note", "third plain note"] });
  await graph.deleteObservations("decision:vacuum", [gone], P);
  getDb().exec("VACUUM");
  const [result] = (await graph.searchMemory("ocelot", 10, P)).results;
  assert.equal(result.observations[0].text, "second ocelot note");
});
