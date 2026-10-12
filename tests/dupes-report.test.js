import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDupes } from "../src/lib/dupesReport.js";

const fact = (id, text, createdAt) => ({ entity: "preference:style", project: "p", id, createdAt, text });

test("each pair shows its similarity, both facts, and the id to delete", () => {
  const out = formatDupes([
    { similarity: 0.65, newer: fact("n1", "In troglodyte/skills, branch-protection blocks the push", "2026-10-07T10:00:00.000Z"), older: fact("o1", "branch-protection.sh blocks the release commit", "2026-09-01T10:00:00.000Z") },
  ]);
  assert.match(out, /0\.65/);
  assert.match(out, /newer n1 \(2026-10-07\)/);
  assert.match(out, /older o1 \(2026-09-01\)/);
  assert.match(out, /forget-obs/);
});

test("no pairs says so", () => {
  assert.equal(formatDupes([]), "No likely repeats among this project's standing facts.");
});
