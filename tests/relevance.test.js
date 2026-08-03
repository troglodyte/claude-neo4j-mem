import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { topScore, classifyRelevance, describeRelevance, WEAK_SCORE } from "../src/lib/relevance.js";

describe("topScore", () => {
  test("takes the best score present, ignoring unscored rows", () => {
    assert.equal(topScore([{ score: 1.2 }, { score: 4.8 }, { score: 0.3 }]), 4.8);
    assert.equal(topScore([{ score: 2 }, { name: "no score" }]), 2);
  });

  test("returns null when there is nothing to score", () => {
    assert.equal(topScore([]), null);
    assert.equal(topScore([{ name: "a" }]), null, "unscored is not zero-scored");
    assert.equal(topScore(null), null);
    assert.equal(topScore({ results: [] }), null);
  });

  test("reads through a results envelope", () => {
    assert.equal(topScore({ results: [{ score: 3.1 }] }), 3.1);
  });
});

describe("classifyRelevance", () => {
  test("no rows is a miss, not a weak match", () => {
    assert.equal(classifyRelevance([]), "none");
  });

  test("splits weak from strong at the calibrated floor", () => {
    // Measured on this repo: junk fragment match 1.61, real queries 3.35-9.28.
    assert.equal(classifyRelevance([{ score: 1.61 }]), "weak");
    assert.equal(classifyRelevance([{ score: 3.35 }]), "strong");
    assert.equal(classifyRelevance([{ score: 9.28 }]), "strong");
    assert.ok(WEAK_SCORE > 1.61 && WEAK_SCORE < 3.35);
  });

  test("the floor is exclusive, so exactly-at-threshold counts as strong", () => {
    assert.equal(classifyRelevance([{ score: WEAK_SCORE }]), "strong");
  });

  test("rows without scores are reported as unscored rather than guessed at", () => {
    assert.equal(classifyRelevance([{ name: "a" }]), "unscored");
  });
});

describe("describeRelevance", () => {
  test("explains a weak result in-band so a caller cannot mistake it for an answer", () => {
    const note = describeRelevance("weak", 1.61);
    assert.match(note, /weak/i);
    assert.match(note, /1\.6/);
    // The point of the note is to license "I don't have that" as a response.
    assert.match(note, /may not|might not|likely/i);
  });

  test("says nothing when the result stands on its own", () => {
    assert.equal(describeRelevance("strong", 4.8), null);
    assert.equal(describeRelevance("unscored", null), null);
  });

  test("explains an empty result too", () => {
    assert.match(describeRelevance("none", null), /no match/i);
  });
});
