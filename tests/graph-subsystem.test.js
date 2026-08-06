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

test("getSubsystemMap aggregates counts and buckets untagged observations", async () => {
  const map = await graph.getSubsystemMap(PROJECT);
  const byName = Object.fromEntries(map.map((row) => [row.subsystem, row]));

  assert.equal(byName.capture.observations, 2);
  assert.equal(byName.capture.entities, 1);
  assert.match(byName.capture.lastSeen, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(byName.backup.observations, 1);
  assert.equal(byName["(untagged)"].observations, 1, "untagged facts get their own row, not hidden");

  const sizes = map.map((row) => row.observations);
  assert.ok(sizes.length <= 4, "the map is bounded by tag cardinality, not by observation count");
});

const textsOf = (rows) => rows.flatMap((r) => r.observations).map((o) => o.text);

test("searchMemory can be narrowed to one subsystem", async () => {
  const all = await graph.searchMemory("fact", 10, PROJECT);
  assert.ok(all.results.length >= 1, "sanity: the unfiltered search finds the test entity");

  const captureOnly = await graph.searchMemory("fact", 10, PROJECT, { subsystem: "capture" });
  const texts = textsOf(captureOnly.results);
  assert.ok(texts.length > 0, "filtered search still returns the matching observations");
  assert.ok(!texts.some((t) => t.includes("sha256")), "a backup observation must not leak through");
});

test("getRecentContext can be narrowed to one subsystem", async () => {
  const rows = await graph.getRecentContext({ project: PROJECT, subsystem: "backup" });
  const texts = textsOf(rows);
  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes("sha256"));
});

// Tagging used to be write-only from a reader's perspective: the only way to
// learn an observation's subsystem was to filter once per candidate tag and
// diff the result sets.
test("every read path returns each observation's subsystem", async () => {
  const entity = await graph.getEntity("test:tagged", PROJECT);
  const byText = Object.fromEntries(entity.observations.map((o) => [o.text, o.subsystem]));
  assert.equal(byText["backup writes a .sha256 sidecar"], "backup");
  assert.equal(byText["an untagged plain-string observation"], null, "untagged reads as null, not absent");

  const found = await graph.searchMemory("sha256", 10, PROJECT);
  const searched = found.results.flatMap((r) => r.observations).find((o) => o.text.includes("sha256"));
  assert.equal(searched.subsystem, "backup");

  const recent = await graph.getRecentContext({ project: PROJECT, subsystem: "backup" });
  assert.equal(recent.flatMap((r) => r.observations)[0].subsystem, "backup");
});

// The map is built by one code path and consumed by another, and nothing used
// to assert they agreed on a vocabulary: `(untagged)` was rendered beside real
// tags with "pass this back to read it", and passing it back matched nothing.
test("every tag the subsystem map advertises is queryable", async () => {
  const map = await graph.getSubsystemMap(PROJECT);
  assert.ok(map.length >= 3, "sanity: the map has tagged and untagged rows to round-trip");

  // Checked against the two read paths whose result depends only on the filter.
  // searchMemory is covered separately below: its result also depends on whether
  // the *query* matches, so a miss there wouldn't isolate the round-trip.
  for (const row of map) {
    const timeline = await graph.getTimeline({ project: PROJECT, subsystem: row.subsystem });
    const recent = await graph.getRecentContext({ project: PROJECT, subsystem: row.subsystem });
    assert.ok(timeline.total > 0, `timeline(subsystem: "${row.subsystem}") must not be empty`);
    assert.ok(recent.length > 0, `recent(subsystem: "${row.subsystem}") must not be empty`);
  }
});

test("searchMemory accepts the map's untagged label too", async () => {
  const found = await graph.searchMemory("untagged", 10, PROJECT, { subsystem: "(untagged)" });
  const texts = found.results.flatMap((r) => r.observations).map((o) => o.text);
  assert.ok(texts.some((t) => t.includes("untagged plain-string")));
  assert.ok(!texts.some((t) => t.includes("sha256")), "a tagged observation must not leak through");
});

test("the untagged bucket is enumerable, and only it comes back", async () => {
  const rows = await graph.getRecentContext({ project: PROJECT, subsystem: "(untagged)" });
  const observations = rows.flatMap((r) => r.observations);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].subsystem, null);
  assert.ok(observations[0].text.includes("untagged plain-string"));
});

// A catch-all resolves to null on write, so on read it means the same bucket -
// otherwise "general" would be a tag you can be told about but never select.
test("a filter tag is normalized the way a written tag is", async () => {
  const cased = await graph.getRecentContext({ project: PROJECT, subsystem: "Backup" });
  assert.equal(textsOf(cased).length, 1, "'Backup' must select the stored 'backup'");

  const junk = await graph.getRecentContext({ project: PROJECT, subsystem: "general" });
  assert.equal(textsOf(junk)[0], "an untagged plain-string observation");
});
