import { test } from "node:test";
import assert from "node:assert/strict";
import { compareGraph } from "../src/lib/migrate/compareGraph.js";
import { fixtureRecords, FIXTURE_PROJECT } from "./helpers/graphFixture.js";

test("identical graphs pass with nothing missing, changed or extra", () => {
  const report = compareGraph(fixtureRecords(), fixtureRecords());
  assert.equal(report.ok, true);
  for (const [type, t] of Object.entries(report.types)) {
    assert.deepEqual([t.missing.length, t.changed.length, t.extra.length], [0, 0, 0], type);
  }
});

test("a row absent from the target fails and is named", () => {
  const target = fixtureRecords();
  target.observations = target.observations.filter((o) => o.id !== "obs-3");
  const report = compareGraph(fixtureRecords(), target);
  assert.equal(report.ok, false);
  assert.deepEqual(report.types.observations.missing, ['["obs-3"]']);
});

test("a row only in the target is listed but passes", () => {
  const target = fixtureRecords();
  target.entities.push({ name: "decision:new", project: FIXTURE_PROJECT, type: "decision", createdAt: 1, updatedAt: null });
  const report = compareGraph(fixtureRecords(), target);
  assert.equal(report.ok, true);
  assert.deepEqual(report.types.entities.extra, [JSON.stringify(["decision:new", FIXTURE_PROJECT])]);
});

test("a changed field fails and names the field", () => {
  const target = fixtureRecords();
  target.observations.find((o) => o.id === "obs-1").subsystem = "elsewhere";
  const report = compareGraph(fixtureRecords(), target);
  assert.equal(report.ok, false);
  assert.deepEqual(report.types.observations.changed, [{ key: '["obs-1"]', fields: ["subsystem"] }]);
});

test("counts are reported per project on both sides", () => {
  const report = compareGraph(fixtureRecords(), fixtureRecords());
  assert.deepEqual(
    report.projects.map((p) => [p.project, p.sourceEntities, p.targetEntities, p.sourceObservations, p.targetObservations]),
    [
      ["", 1, 1, 1, 1],
      ["github.com/acme/app", 3, 3, 4, 4],
      ["github.com/acme/other", 1, 1, 1, 1],
    ]
  );
});

test("an unpaired surrogate is counted and not reported as a change", () => {
  const source = fixtureRecords();
  source.observations[0].text = "cut through an emoji \uD83D";
  const target = fixtureRecords();
  target.observations[0].text = "cut through an emoji \uFFFD";
  const report = compareGraph(source, target);
  assert.equal(report.ok, true);
  assert.equal(report.notWellFormedText, 1);
});
