import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentWords, indexText, matchQuery } from "../src/lib/segment.js";

test("inner colons, dots and underscores keep a word whole; hyphens split", () => {
  assert.deepEqual(segmentWords("feature:capture-visibility"), ["feature:capture", "visibility"]);
  assert.deepEqual(segmentWords("tool:cypher.sh"), ["tool:cypher.sh"]);
  assert.deepEqual(segmentWords("snake_case_name"), ["snake_case_name"]);
  assert.deepEqual(segmentWords("AS-64"), ["as", "64"]);
});

test("words are lowercased, and punctuation and emoji are dropped", () => {
  assert.deepEqual(segmentWords("Deploy 🚀 DONE!"), ["deploy", "done"]);
});

test("indexText joins the words with single spaces", () => {
  assert.equal(indexText("  The   capture hook, again "), "the capture hook again");
});

// Lucene counts a repeated query word twice; so does FTS5 when it is ORed twice.
test("matchQuery quotes every word and ORs them, repeats included", () => {
  assert.equal(matchQuery("capture Capture hook"), '"capture" OR "capture" OR "hook"');
  assert.equal(matchQuery("feature:capture-visibility"), '"feature:capture" OR "visibility"');
});

test("a query with no words has no match expression", () => {
  assert.equal(matchQuery("-- ?? !!"), null);
  assert.equal(matchQuery(""), null);
});

test("FTS5 operators in a query become quoted words", () => {
  assert.equal(matchQuery('AND "hi" NEAR'), '"and" OR "hi" OR "near"');
});
