import { test } from "node:test";
import assert from "node:assert/strict";
import { parityReport, passesGates } from "../src/lib/searchParity.js";

const pair = (query, before, after, beforeLabel = "strong", afterLabel = "strong") => ({
  query,
  project: "p",
  before: { names: before, relevance: before.length ? beforeLabel : "none" },
  after: { names: after, relevance: after.length ? afterLabel : "none" },
});

test("measures top-1 and top-5 agreement over queries either engine answered", () => {
  const report = parityReport([
    pair("a", ["x", "y", "z"], ["x", "z", "q"]),
    pair("b", ["m"], ["n"]),
    pair("c", [], []),
  ]);
  assert.equal(report.queries, 3);
  assert.equal(report.answered, 2);
  assert.equal(report.top1, 0.5);
  // a: 2 of 3 shared; b: 0 of 1. Mean 0.333.
  assert.equal(Number(report.overlapAt5.toFixed(3)), 0.333);
});

test("names every query only one engine found nothing for", () => {
  const report = parityReport([pair("only-before", ["x"], []), pair("both", ["x"], ["x"])]);
  assert.deepEqual(report.emptyMismatches, ["only-before"]);
});

test("measures and lists relevance-label disagreements", () => {
  const report = parityReport([pair("a", ["x"], ["x"], "strong", "weak"), pair("b", ["x"], ["x"])]);
  assert.equal(report.relevance, 0.5);
  assert.deepEqual(report.relevanceDisagreements, [{ query: "a", before: "strong", after: "weak" }]);
});

test("the gates need 95% top-1, 95% labels, and the same empty queries", () => {
  const ok = { top1: 0.95, relevance: 0.95, emptyMismatches: [] };
  assert.equal(passesGates(ok), true);
  assert.equal(passesGates({ ...ok, top1: 0.94 }), false);
  assert.equal(passesGates({ ...ok, relevance: 0.94 }), false);
  assert.equal(passesGates({ ...ok, emptyMismatches: ["q"] }), false);
});
