import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureSchema } from "../src/lib/schema.js";
import { closeDriver } from "../src/lib/neo4jClient.js";
import * as graph from "../src/lib/graph.js";

const PROJECT = "test:search";
const ENTITY = "decision:zzqx-storage-layout";

before(async () => {
  await ensureSchema();
  await graph.deleteEntity(ENTITY, PROJECT);
  await graph.addObservations({
    entity: ENTITY,
    entityType: "decision",
    project: PROJECT,
    // Deliberately shares no word with the entity name: the only way this
    // entity can be found by its own name is through the name index.
    observations: ["volumes are selected by engine rather than one hardcoded pair"],
  });
  // The fulltext indexes are updated asynchronously on commit.
  await new Promise((resolve) => setTimeout(resolve, 1200));
});

after(async () => {
  await graph.deleteEntity(ENTITY, PROJECT);
  await closeDriver();
});

// Searching an entity by its own name is what escapeLuceneQuery exists to make
// possible, and it stayed broken after that fix for a second reason: the
// subquery that pulls query-matching observations is a correlated CALL, so an
// entity matched only by name - zero matching observations - was joined against
// an empty result and dropped. The name index scored it and nothing returned it.
test("an entity matched only by its name is returned", async () => {
  const found = await graph.searchMemory(ENTITY, 10, PROJECT);
  assert.equal(found.results.length, 1, "the name index match must survive to the result");
  assert.equal(found.results[0].name, ENTITY);
});

test("a name-only match still carries the entity's observations for context", async () => {
  const found = await graph.searchMemory(ENTITY, 10, PROJECT);
  const observations = found.results[0].observations;
  assert.equal(observations.length, 1, "the recency top-up supplies context the query did not match");
  assert.match(observations[0].text, /hardcoded pair/);
  assert.equal(observations[0].subsystem, null);
});

test("a query matching observation text still works", async () => {
  const found = await graph.searchMemory("hardcoded", 10, PROJECT);
  assert.equal(found.results.length, 1, "sanity: the observation index path is unaffected");
});

test("a query matching nothing still returns nothing", async () => {
  const found = await graph.searchMemory("wholly unrelated aardvark", 10, PROJECT);
  assert.equal(found.results.length, 0, "the fix must not turn every search into a match");
});
