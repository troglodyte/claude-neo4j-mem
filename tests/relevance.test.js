import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { topScore, classifyRelevance, describeRelevance, queryWords } from "../src/lib/relevance.js";

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

describe("queryWords", () => {
  test("lowercase words longer than two characters", () => {
    assert.deepEqual([...queryWords("Fix the ABC-1463 bug, ok?")], ["fix", "the", "abc", "1463", "bug"]);
  });
});

describe("classifyRelevance", () => {
  test("no rows is a miss, not a weak match", () => {
    assert.equal(classifyRelevance([], "anything at all"), "none");
  });

  test("a multi-word query whose best result holds only one of its words is weak", () => {
    assert.equal(classifyRelevance([{ matchedQueryWords: 1 }], "zzz-nonexistent-term-qqq"), "weak");
  });

  test("two matched words make a multi-word result strong, however long the query", () => {
    assert.equal(classifyRelevance([{ matchedQueryWords: 2 }], "rust crate tests passing modules runner"), "strong");
  });

  test("a single-word query is strong as soon as it matched", () => {
    assert.equal(classifyRelevance([{ matchedQueryWords: 1 }], "podman"), "strong");
  });

  test("only the best result decides", () => {
    assert.equal(classifyRelevance([{ matchedQueryWords: 1 }, { matchedQueryWords: 3 }], "alpha bravo charlie"), "weak");
  });

  test("rows that carry no match count are reported as unscored rather than guessed at", () => {
    assert.equal(classifyRelevance([{ name: "a" }], "alpha bravo"), "unscored");
  });

  test("reads through a results envelope", () => {
    assert.equal(classifyRelevance({ results: [{ matchedQueryWords: 2 }] }, "alpha bravo"), "strong");
  });
});

describe("describeRelevance", () => {
  test("explains a weak result in-band so a caller cannot mistake it for an answer", () => {
    const note = describeRelevance("weak");
    assert.match(note, /weak/i);
    assert.match(note, /only one of your query's words/);
    assert.match(note, /may not|might not|likely/i);
  });

  test("says nothing when the result stands on its own", () => {
    assert.equal(describeRelevance("strong"), null);
    assert.equal(describeRelevance("unscored"), null);
  });

  test("explains an empty result too", () => {
    assert.match(describeRelevance("none"), /no match/i);
  });
});
