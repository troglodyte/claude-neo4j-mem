import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { closeDb } from "../src/lib/memoryStore.js";
import * as graph from "../src/lib/graph.js";

const HERE = "test:fallback-here";
const THERE = "test:fallback-there";
const ENTITY = "decision:zzqx-fallback-probe";
// Two rare words, so the match is strong rather than a fragment.
const QUERY = "quuxplorf zebrafinch";

before(async () => {
  useTempStore();
  await graph.deleteEntity(ENTITY, THERE);
  await graph.addObservations({
    entity: ENTITY,
    entityType: "decision",
    project: THERE,
    observations: ["the quuxplorf handshake needs a zebrafinch retry window", "second observation", "third observation"],
  });
  // The fulltext indexes are updated asynchronously on commit.
  await new Promise((resolve) => setTimeout(resolve, 1200));
});

after(async () => {
  await graph.deleteEntity(ENTITY, THERE);
  closeDb();
});

test("a miss in this project surfaces a strong match from another, kept apart and labelled", async () => {
  const found = await graph.searchMemory(QUERY, 10, HERE);
  assert.equal(found.results.length, 0, "this project's results are untouched");
  assert.equal(found.relevance, "none");
  assert.equal(found.otherProjects.results.length, 1);
  const [hit] = found.otherProjects.results;
  assert.equal(hit.project, THERE);
  assert.equal(hit.name, ENTITY);
  assert.match(hit.observations[0].text, /quuxplorf/);
  assert.equal(hit.observations.length, 2, "compact: two observations, not all three");
  assert.match(found.otherProjects.note, /OTHER projects/);
});

test("a strong match in this project does not trigger the fallback", async () => {
  const found = await graph.searchMemory(QUERY, 10, THERE);
  assert.equal(found.results.length, 1);
  assert.equal(found.otherProjects, undefined);
});

test("an unscoped search already sees every project, so it adds nothing", async () => {
  const found = await graph.searchMemory(QUERY, 10, null);
  assert.equal(found.results.length, 1);
  assert.equal(found.otherProjects, undefined);
});

test("CLAUDE_NEO4J_SEARCH_FALLBACK=off restores the project-only behaviour", async () => {
  process.env.CLAUDE_NEO4J_SEARCH_FALLBACK = "off";
  try {
    const found = await graph.searchMemory(QUERY, 10, HERE);
    assert.equal(found.otherProjects, undefined);
    assert.equal(found.results.length, 0);
  } finally {
    delete process.env.CLAUDE_NEO4J_SEARCH_FALLBACK;
  }
});

test("a query matching nothing anywhere adds no otherProjects field", async () => {
  const found = await graph.searchMemory("wholly unrelated aardvark", 10, HERE);
  assert.equal(found.otherProjects, undefined);
});

test("results for this project keep their original shape (no project field leaks in)", async () => {
  const found = await graph.searchMemory(QUERY, 10, THERE);
  assert.deepEqual(Object.keys(found.results[0]).sort(), ["name", "observations", "relationCount", "relations", "score", "type"]);
});
