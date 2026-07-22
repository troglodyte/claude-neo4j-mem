import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureSchema } from "../src/lib/schema.js";
import { closeDriver } from "../src/lib/neo4jClient.js";
import * as graph from "../src/lib/graph.js";

const PROJECT = "test:subsystem";

before(async () => {
  await ensureSchema();
  await graph.deleteEntity("test:tagged", PROJECT);
});

after(async () => {
  await graph.deleteEntity("test:tagged", PROJECT);
  await closeDriver();
});

test("addObservations stores a per-observation subsystem", async () => {
  await graph.addObservations({
    entity: "test:tagged",
    entityType: "fact",
    project: PROJECT,
    observations: [
      { text: "capture retries failed inputs up to 3 times", subsystem: "capture" },
      { text: "backup writes a .sha256 sidecar", subsystem: "Backup" },
      "an untagged plain-string observation",
    ],
  });

  const tags = await graph.listSubsystems(PROJECT);
  const bySlug = Object.fromEntries(tags.map((t) => [t.subsystem, t.observations]));
  assert.equal(bySlug.capture, 1);
  assert.equal(bySlug.backup, 1, "'Backup' should normalize to 'backup'");
  assert.equal(tags.length, 2, "the plain string must stay untagged, not become a tag");
});

test("addObservations snaps a near-duplicate tag onto the existing one", async () => {
  await graph.addObservations({
    entity: "test:tagged",
    project: PROJECT,
    observations: [{ text: "a second capture fact", subsystem: "captures" }],
  });

  const tags = await graph.listSubsystems(PROJECT);
  const bySlug = Object.fromEntries(tags.map((t) => [t.subsystem, t.observations]));
  assert.equal(bySlug.capture, 2, "'captures' should have merged into 'capture'");
  assert.equal(bySlug.captures, undefined);
});
