import { test } from "node:test";
import assert from "node:assert/strict";
import { wordOverlap, wordSet } from "../src/lib/similarity.js";

test("identical texts overlap completely", () => {
  assert.equal(wordOverlap("Email: someone@example.com", "Email: someone@example.com"), 1);
});

test("texts with no shared words do not overlap", () => {
  assert.equal(wordOverlap("prefers pnpm", "deploys on fridays"), 0);
});

test("overlap is shared words over all distinct words", () => {
  // {prefers, pnpm, over, npm} and {prefers, pnpm, over, yarn}: 3 shared of 5.
  assert.equal(wordOverlap("prefers pnpm over npm", "prefers pnpm over yarn"), 0.6);
});

test("case and punctuation are ignored, and words under three characters do not count", () => {
  assert.deepEqual([...wordSet("Use `pnpm`, NOT npm -- ok?")], ["use", "pnpm", "not", "npm"]);
  assert.equal(wordOverlap("a b c", "a b c"), 0, "no countable words means no overlap");
});
