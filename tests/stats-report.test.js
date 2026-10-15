import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { getDb, closeDb } from "../src/lib/memoryStore.js";
import { buildStatsReport, renderStatsReport } from "../src/lib/statsReport.js";

const DAY = 86_400_000;
// Wednesday; its week starts Monday 2026-10-12.
const NOW = Date.UTC(2026, 9, 14, 12, 0);
let nextObservation = 0;

function addEntity(db, { name, project = "p", type = null, at = NOW }) {
  return Number(
    db.prepare("INSERT INTO entities (name, project, type, created_at) VALUES (?, ?, ?, ?)").run(name, project, type, at)
      .lastInsertRowid,
  );
}

function addObservations(db, entityId, { count = 1, subsystem = null, session = null, text = "a fact", at = NOW }) {
  const insert = db.prepare(
    "INSERT INTO observations (id, entity_id, text, subsystem, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < count; i++) {
    insert.run(`obs-${nextObservation++}`, entityId, text, subsystem, session, at);
  }
}

function relate(db, fromId, toId, type = "uses") {
  db.prepare("INSERT INTO relations (from_id, to_id, type) VALUES (?, ?, ?)").run(fromId, toId, type);
}

function stats(project = "p", options = {}) {
  return buildStatsReport(getDb(), { project, now: NOW, ...options });
}

beforeEach(() => {
  useTempStore();
});

after(() => {
  closeDb();
});

test("the summary counts only the requested project's rows", () => {
  const db = getDb();
  const a = addEntity(db, { name: "a", type: "decision" });
  const b = addEntity(db, { name: "b", type: "decision" });
  addEntity(db, { name: "c" });
  const other = addEntity(db, { name: "x", project: "other", type: "finding" });
  addObservations(db, a, { count: 2, session: "s1", at: NOW - 10 * DAY });
  addObservations(db, b, { count: 1, session: "s2", at: NOW - DAY });
  addObservations(db, other, { count: 5, session: "s9", at: NOW - 40 * DAY });
  relate(db, a, b);
  relate(db, a, other);
  relate(db, other, b, "affects");
  relate(db, other, other);

  const { summary } = stats();

  assert.deepEqual(summary, {
    entities: 3,
    observations: 3,
    relations: 3,
    sessions: 2,
    firstAt: "2026-10-04",
    lastAt: "2026-10-13",
    types: [
      { type: "decision", n: 2 },
      { type: null, n: 1 },
    ],
  });
});

test("a null project covers the whole store, global entities included", () => {
  const db = getDb();
  addObservations(db, addEntity(db, { name: "a" }), { count: 2 });
  addObservations(db, addEntity(db, { name: "x", project: "other" }), { count: 3 });
  addObservations(db, addEntity(db, { name: "user", project: "" }), { count: 1 });

  const { summary } = stats(null);

  assert.equal(summary.entities, 3);
  assert.equal(summary.observations, 6);
});

test("weekly growth buckets by UTC Monday, oldest first, with empty weeks kept", () => {
  const db = getDb();
  const monday = Date.UTC(2026, 9, 12);
  const a = addEntity(db, { name: "a", at: NOW - 9 * DAY });
  const b = addEntity(db, { name: "b" });
  addObservations(db, a, { count: 2, at: NOW - 16 * DAY });
  addObservations(db, a, { at: monday - 1 });
  addObservations(db, b, { at: monday });
  addObservations(db, b, { at: NOW - 2 * DAY });
  addObservations(db, a, { at: NOW - 30 * DAY });
  addObservations(db, addEntity(db, { name: "x", project: "other" }), { at: NOW - 9 * DAY });

  const { weekly } = stats("p", { weeks: 4 });

  assert.deepEqual(weekly, [
    { week: "2026-09-21", observations: 0, entities: 0 },
    { week: "2026-09-28", observations: 2, entities: 0 },
    { week: "2026-10-05", observations: 1, entities: 1 },
    { week: "2026-10-12", observations: 2, entities: 1 },
  ]);
});

test("rows dated after the current week are left out of weekly growth", () => {
  const db = getDb();
  addObservations(db, addEntity(db, { name: "a", at: NOW + 8 * DAY }), { at: NOW + 8 * DAY });

  const { weekly } = stats("p", { weeks: 1 });

  assert.deepEqual(weekly, [{ week: "2026-10-12", observations: 0, entities: 0 }]);
});

test("session yield gives nearest-rank median, p90 and max observations per session", () => {
  const db = getDb();
  const a = addEntity(db, { name: "a" });
  addObservations(db, a, { count: 1, session: "s1" });
  addObservations(db, a, { count: 2, session: "s2" });
  addObservations(db, a, { count: 3, session: "s3" });
  addObservations(db, a, { count: 10, session: "s4" });
  addObservations(db, a, { count: 2 });
  addObservations(db, addEntity(db, { name: "x", project: "other" }), { count: 50, session: "s5" });

  // Sorted yields are [1, 2, 3, 10]: rank ceil(0.5 * 4) = 2 is 2, rank ceil(0.9 * 4) = 4 is 10.
  assert.deepEqual(stats().sessionYield, { median: 2, p90: 10, max: 10, unsessioned: 2 });
});

test("observation length gives the spread in characters and counts those over 1000", () => {
  const db = getDb();
  const a = addEntity(db, { name: "a" });
  for (const length of [1001, 10, 2500, 30, 1000, 20]) {
    addObservations(db, a, { text: "x".repeat(length) });
  }
  addObservations(db, addEntity(db, { name: "x", project: "other" }), { text: "x".repeat(9000) });

  // Sorted [10, 20, 30, 1000, 1001, 2500]: rank 3 is 30, rank ceil(5.4) = 6 is 2500.
  assert.deepEqual(stats().lengths, { median: 30, p90: 2500, max: 2500, over1000: 2 });
});

test("subsystems count every tag, largest first with ties alphabetical, plus tagged and untagged totals", () => {
  const db = getDb();
  const a = addEntity(db, { name: "a" });
  addObservations(db, a, { subsystem: "b", count: 3 });
  addObservations(db, a, { subsystem: "a", count: 3 });
  for (const tag of ["h", "g", "f", "e", "d", "c"]) {
    addObservations(db, a, { subsystem: tag, count: 2 });
  }
  addObservations(db, a, { subsystem: "i", count: 1 });
  addObservations(db, a, { count: 4 });
  addObservations(db, addEntity(db, { name: "x", project: "other" }), { subsystem: "z", count: 9 });

  assert.deepEqual(stats().subsystems, {
    tagged: 19,
    untagged: 4,
    tags: [
      { tag: "a", n: 3 },
      { tag: "b", n: 3 },
      { tag: "c", n: 2 },
      { tag: "d", n: 2 },
      { tag: "e", n: 2 },
      { tag: "f", n: 2 },
      { tag: "g", n: 2 },
      { tag: "h", n: 2 },
      { tag: "i", n: 1 },
    ],
  });
});

test("relations give types, the most-connected in-scope entities, and the unrelated count", () => {
  const db = getDb();
  const [a, b, c] = ["a", "b", "c"].map((name) => addEntity(db, { name }));
  addEntity(db, { name: "d" });
  const x = addEntity(db, { name: "x", project: "other" });
  relate(db, a, b);
  relate(db, a, c);
  relate(db, b, c, "implements");
  relate(db, a, x, "see-also");
  relate(db, x, x);

  assert.deepEqual(stats().relations, {
    types: [
      { type: "uses", n: 2 },
      { type: "implements", n: 1 },
      { type: "see-also", n: 1 },
    ],
    connected: [
      { name: "a", project: "p", degree: 3 },
      { name: "b", project: "p", degree: 2 },
      { name: "c", project: "p", degree: 2 },
    ],
    unrelated: 1,
  });
});

test("a project with no memory renders a pointer to the whole-store views", () => {
  addEntity(getDb(), { name: "a", project: "other" });

  const text = renderStatsReport(stats("github.com/acme/nothing"));

  assert.match(text, /No memory recorded for github\.com\/acme\/nothing/);
  assert.match(text, /--all/);
  assert.doesNotMatch(text, /Weekly growth/);
});

test("entity types beyond the 8 largest are summarised as a count", () => {
  const db = getDb();
  for (const [i, type] of ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"].entries()) {
    addEntity(db, { name: `e${i}`, type });
  }
  addEntity(db, { name: "extra", type: "t1" });

  const line = renderStatsReport(stats()).match(/^ {2}types: (.*)$/m)[1];

  assert.equal(line, "t1 2, t10 1, t2 1, t3 1, t4 1, t5 1, t6 1, t7 1, +2 more");
});

test("tag and relation-type lists say how many they leave out", () => {
  const db = getDb();
  const [a, b] = ["a", "b"].map((name) => addEntity(db, { name }));
  for (const tag of ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]) {
    addObservations(db, a, { subsystem: tag });
  }
  for (const type of ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]) {
    relate(db, a, b, type);
  }

  const text = renderStatsReport(stats());

  assert.match(text, /^ {2}t8\s+1\s+\d+%\n {2}\+1 more$/m);
  assert.match(text, /^ {2}types: r1 1, r2 1, r3 1, r4 1, r5 1, \+2 more$/m);
});

test("an empty store viewed whole does not suggest --all", () => {
  const text = renderStatsReport(stats(null));

  assert.match(text, /No memory recorded/);
  assert.doesNotMatch(text, /--all/);
});

test("weekly columns stay aligned when a week passes 10,000 observations", () => {
  const db = getDb();
  db.exec("BEGIN");
  const a = addEntity(db, { name: "a" });
  addObservations(db, a, { count: 12_345 });
  addObservations(db, a, { count: 3, at: NOW - 7 * DAY });
  for (let i = 0; i < 1_234; i++) {
    addEntity(db, { name: `e${i}` });
  }
  db.exec("COMMIT");

  const rows = renderStatsReport(stats("p", { weeks: 2 }))
    .split("\n")
    .filter((line) => /^\s+\d{4}-\d{2}-\d{2}/.test(line));
  const columnEnds = rows.map((row) => {
    const [, obs, ent] = row.match(/^(\s+\S+\s+[\d,]+)(\s+[\d,]+)/);
    return [obs.length, obs.length + ent.length];
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(columnEnds[0], columnEnds[1]);
});

test("weekly bars scale to the busiest week and empty weeks get none", () => {
  const db = getDb();
  const a = addEntity(db, { name: "a", at: NOW - 30 * DAY });
  addObservations(db, a, { count: 4, at: NOW });
  addObservations(db, a, { count: 2, at: NOW - 7 * DAY });
  const q = addEntity(db, { name: "q", project: "q", at: NOW - 30 * DAY });
  addObservations(db, q, { count: 40, at: NOW });

  const bars = (project) => {
    const text = renderStatsReport(stats(project, { weeks: 3 }));
    return (week) => text.match(new RegExp(`^\\s*${week}\\s+[\\d,]+\\s+\\d+\\s*(█*)$`, "m"))[1].length;
  };
  const p = bars("p");

  assert.ok(p("2026-10-12") > 0);
  assert.equal(p("2026-10-05") * 2, p("2026-10-12"));
  assert.equal(p("2026-09-28"), 0);
  assert.equal(bars("q")("2026-10-12"), p("2026-10-12"));
});

test("the whole-store view labels connected entities with their project", () => {
  const db = getDb();
  const a = addEntity(db, { name: "a", project: "github.com/acme/one" });
  relate(db, a, addEntity(db, { name: "b", project: "github.com/acme/two" }));

  const text = renderStatsReport(stats(null));

  assert.match(text, /all projects/);
  assert.match(text, /a \(github\.com\/acme\/one\)/);
});
