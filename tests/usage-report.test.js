import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { getDb, closeDb } from "../src/lib/memoryStore.js";
import { buildUsageReport, renderUsageReport } from "../src/lib/usageReport.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 12, 0);
let nextObservation = 0;

function addEntity(db, { name, project, type = null }) {
  return Number(
    db.prepare("INSERT INTO entities (name, project, type, created_at) VALUES (?, ?, ?, ?)").run(name, project, type, NOW)
      .lastInsertRowid,
  );
}

function addObservations(db, entityId, { count = 1, subsystem = null, at = NOW }) {
  const insert = db.prepare(
    "INSERT INTO observations (id, entity_id, text, subsystem, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < count; i++) {
    insert.run(`obs-${nextObservation++}`, entityId, "a fact", subsystem, at);
  }
}

function report() {
  return buildUsageReport(getDb(), { now: NOW });
}

function warning(heading) {
  return report().warnings.find((w) => w.heading.startsWith(heading));
}

beforeEach(() => {
  useTempStore();
});

after(() => {
  closeDb();
});

test("an empty store reports no projects", () => {
  assert.deepEqual(report().projects, []);
  assert.match(renderUsageReport(report()), /No projects tracked/);
});

test("projects carry counts and activity window, most recent first", () => {
  const db = getDb();
  const old = addEntity(db, { name: "a", project: "github.com/acme/old" });
  addObservations(db, old, { count: 2, at: NOW - 30 * DAY });
  const fresh = addEntity(db, { name: "b", project: "github.com/acme/fresh" });
  addObservations(db, fresh, { count: 1, at: NOW - 10 * DAY });
  addObservations(db, fresh, { count: 3, at: NOW - DAY });
  addEntity(db, { name: "stub", project: "github.com/acme/fresh" });

  const { projects } = report();

  assert.deepEqual(
    projects.map((p) => [p.project, p.entities, p.observations, p.last7d]),
    [
      ["github.com/acme/fresh", 2, 4, 3],
      ["github.com/acme/old", 1, 2, 0],
    ],
  );
  assert.equal(projects[0].firstAt, "2026-10-03");
  assert.equal(projects[0].lastAt, "2026-10-12 12:00");
});

test("totals count global entities as unscoped, not as a project", () => {
  const db = getDb();
  const scoped = addEntity(db, { name: "a", project: "p" });
  const global = addEntity(db, { name: "user", project: "" });
  addObservations(db, scoped, { count: 2 });
  addObservations(db, global, { count: 1 });
  db.prepare("INSERT INTO relations (from_id, to_id, type) VALUES (?, ?, 'uses')").run(scoped, global);

  assert.deepEqual(report().totals, { projects: 1, entities: 2, observations: 3, relations: 1, unscoped: 1 });
  assert.deepEqual(report().projects.map((p) => p.project), ["p"]);
});

test("the same repo under two names is flagged as split", () => {
  const db = getDb();
  addObservations(db, addEntity(db, { name: "a", project: "foo" }), {});
  addObservations(db, addEntity(db, { name: "a", project: "github.com/acme/foo" }), {});

  assert.deepEqual(warning("Projects recorded under more than one name").lines, ["foo: foo, github.com/acme/foo"]);
});

test("entities with 100+ observations and empty stubs are flagged", () => {
  const db = getDb();
  addObservations(db, addEntity(db, { name: "fat", project: "p" }), { count: 100 });
  addObservations(db, addEntity(db, { name: "thin", project: "p" }), { count: 99 });
  addEntity(db, { name: "stub", project: "p" });

  assert.deepEqual(warning("Entities with 100+").lines, ["fat (p): 100 observations"]);
  assert.deepEqual(warning("Entities with zero").lines, ["stub (p)"]);
});

test("a subsystem map over 800 rendered chars is flagged with its smallest tags", () => {
  const db = getDb();
  const e = addEntity(db, { name: "a", project: "p" });
  // Each tag is 30 chars, so a cell is 30 + 1 digit + 10 = 41, plus 3 per gap.
  for (let i = 0; i < 20; i++) {
    addObservations(db, e, { subsystem: `tag-${String(i).padStart(2, "0")}-${"x".repeat(23)}`, count: i < 3 ? 1 : 2 });
  }

  const [line] = warning("Projects whose subsystem map is costly").lines;
  assert.match(line, /^p: 877 chars across 20 subsystems; smallest are tag-00-x+ \(1\), tag-01-x+ \(1\), tag-02-x+ \(1\)$/);
});

test("catch-all tags are flagged", () => {
  const db = getDb();
  addObservations(db, addEntity(db, { name: "a", project: "p" }), { subsystem: "general", count: 2 });

  assert.deepEqual(warning("Catch-all subsystem tags").lines, ["p: general holds 2 observation(s)"]);
});

test("one tag holding over 40% of 40+ tagged observations is flagged", () => {
  const db = getDb();
  const e = addEntity(db, { name: "a", project: "p" });
  addObservations(db, e, { subsystem: "infra", count: 17 });
  addObservations(db, e, { subsystem: "oauth", count: 23 });

  assert.deepEqual(warning("Subsystem maps that have collapsed").lines, [
    "p: oauth holds 23 of 40 tagged observation(s) (57%)",
  ]);
});

test("a small project does not trip the concentration check", () => {
  const db = getDb();
  addObservations(db, addEntity(db, { name: "a", project: "p" }), { subsystem: "oauth", count: 39 });

  assert.equal(warning("Subsystem maps that have collapsed"), undefined);
});

test("unclassified history excludes pinned facts, where null is correct", () => {
  const db = getDb();
  addObservations(db, addEntity(db, { name: "a", project: "p" }), { subsystem: "x", count: 20 });
  addObservations(db, addEntity(db, { name: "b", project: "p" }), { count: 13 });
  addObservations(db, addEntity(db, { name: "style", project: "p", type: "preference" }), { count: 10 });
  addObservations(db, addEntity(db, { name: "user", project: "p" }), { count: 2 });

  // 13 of 45 is 28%: under the line only because the 12 pinned ones are excluded.
  assert.equal(warning("Projects with a large unclassified history"), undefined);

  addObservations(db, addEntity(db, { name: "c", project: "p" }), { count: 2 });
  assert.deepEqual(warning("Projects with a large unclassified history").lines, [
    "p: 15 of 47 observation(s) carry no subsystem (31%), excluding cross-cutting facts where null is correct",
  ]);
});

test("a tag made only of the project name's own words is flagged", () => {
  const db = getDb();
  const e = addEntity(db, { name: "a", project: "github.com/acme/context_watch-plugin" });
  addObservations(db, e, { subsystem: "context-watch", count: 3 });
  addObservations(db, e, { subsystem: "context-menu", count: 1 });

  assert.deepEqual(warning("Subsystem tags named after their own project").lines, [
    "github.com/acme/context_watch-plugin: context-watch (3 observation(s)) repeats the project name",
  ]);
});

test("quiet rendering prints the table and totals but no warnings", () => {
  const db = getDb();
  addEntity(db, { name: "stub", project: "p" });

  const quiet = renderUsageReport(report(), { quiet: true });
  assert.match(quiet, /^PROJECT\s+ENTITIES/m);
  assert.match(quiet, /Totals: 1 project\(s\), 1 entities, 0 observations, 0 relations/);
  assert.doesNotMatch(quiet, /zero observations/);
  assert.match(renderUsageReport(report()), /Entities with zero observations[^\n]*\n  stub \(p\)/);
});
