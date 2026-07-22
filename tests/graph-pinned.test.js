import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureSchema } from "../src/lib/schema.js";
import { closeDriver } from "../src/lib/neo4jClient.js";
import { BUDGETS } from "../src/lib/budget.js";
import * as graph from "../src/lib/graph.js";

const PROJECT = "test:pinned";
const ENTITIES = ["preference:test-style", "decision:test-noise", "user", "Constraint Amendment holder"];

async function clean() {
  for (const name of ENTITIES) await graph.deleteEntity(name, PROJECT);
}

before(async () => {
  await ensureSchema();
  await clean();
  await graph.addObservations({
    entity: "preference:test-style",
    entityType: "preference",
    project: PROJECT,
    observations: ["prefers tests that assert on behaviour, not on call counts"],
  });
  await graph.addObservations({
    entity: "decision:test-noise",
    entityType: "decision",
    project: PROJECT,
    observations: ["chose vitest over jest for this one repo"],
  });
  await graph.addObservations({
    entity: "user",
    entityType: "user",
    project: PROJECT,
    observations: ["works in Europe/London"],
  });
  await graph.addObservations({
    entity: "Constraint Amendment holder",
    entityType: "Constraint Amendment",
    project: PROJECT,
    observations: ["build artifacts must stay out of git"],
  });
});

after(async () => {
  await clean();
  await closeDriver();
});

test("getPinnedFacts selects standing facts and excludes one-off decisions", async () => {
  const pinned = await graph.getPinnedFacts({ project: PROJECT });
  const texts = pinned.map((p) => p.text);

  assert.ok(texts.some((t) => t.includes("assert on behaviour")), "preference: must pin");
  assert.ok(texts.some((t) => t.includes("Europe/London")), "user must pin");
  assert.ok(texts.some((t) => t.includes("out of git")), "'Constraint Amendment' must pin by prefix");
  assert.ok(!texts.some((t) => t.includes("vitest")), "a decision: is not a standing fact");
});

test("getPinnedFacts enforces its character budget", async () => {
  const pinned = await graph.getPinnedFacts({ project: PROJECT });
  const total = JSON.stringify(pinned).length;
  assert.ok(total <= BUDGETS.pinnedTotalChars, `pinned payload was ${total} chars`);
  for (const fact of pinned) {
    assert.ok(fact.text.length <= BUDGETS.pinnedTextChars + 24, "long text must be truncated in-band");
  }
});
