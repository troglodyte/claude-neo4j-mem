import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { fallbackEnabled, shouldFallBack, otherProjectResults, coversQuery, MAX_OTHER_PROJECT_RESULTS } from "../src/lib/fallback.js";

// Every row mentions "handshake retry window", so a query using those words covers it.
const row = (project, name, score, extra = {}) => ({
  project,
  name,
  type: "decision",
  score,
  observations: [
    { text: `${name} handshake retry window`, subsystem: null },
    { text: `${name} second`, subsystem: "x" },
    { text: `${name} third`, subsystem: null },
  ],
  relations: [{ type: "uses", entity: "a" }, { type: "uses", entity: "b" }],
  ...extra,
});

describe("fallbackEnabled", () => {
  test("on by default, off with CLAUDE_NEO4J_SEARCH_FALLBACK=off", () => {
    assert.equal(fallbackEnabled({}), true);
    assert.equal(fallbackEnabled({ CLAUDE_NEO4J_SEARCH_FALLBACK: "off" }), false);
    assert.equal(fallbackEnabled({ CLAUDE_NEO4J_SEARCH_FALLBACK: "0" }), false);
    assert.equal(fallbackEnabled({ CLAUDE_NEO4J_SEARCH_FALLBACK: "on" }), true);
  });
});

describe("shouldFallBack", () => {
  test("only when a project-scoped search came back none or weak", () => {
    assert.equal(shouldFallBack({ project: "p", relevance: "none", env: {} }), true);
    assert.equal(shouldFallBack({ project: "p", relevance: "weak", env: {} }), true);
    assert.equal(shouldFallBack({ project: "p", relevance: "strong", env: {} }), false);
    assert.equal(shouldFallBack({ project: "p", relevance: "unscored", env: {} }), false);
  });

  test("never for an unscoped search, which already saw every project", () => {
    assert.equal(shouldFallBack({ project: null, relevance: "none", env: {} }), false);
  });

  test("never when switched off", () => {
    assert.equal(shouldFallBack({ project: "p", relevance: "none", env: { CLAUDE_NEO4J_SEARCH_FALLBACK: "off" } }), false);
  });
});

const Q = "handshake retry window";

describe("coversQuery", () => {
  const r = { name: "x", observations: [{ text: "alpha beta gamma" }] };
  test("a single-word query needs that word", () => {
    assert.equal(coversQuery("alpha", r), true);
    assert.equal(coversQuery("delta", r), false);
  });
  test("a two-word query needs both words", () => {
    assert.equal(coversQuery("alpha beta", r), true);
    assert.equal(coversQuery("alpha delta", r), false);
  });
  test("a longer query needs at least half its words, and never fewer than two", () => {
    assert.equal(coversQuery("alpha beta delta", r), true, "2 of 3");
    assert.equal(coversQuery("alpha delta epsilon", r), false, "1 of 3");
    assert.equal(coversQuery("alpha beta delta epsilon", r), true, "2 of 4");
    assert.equal(coversQuery("alpha delta epsilon zeta", r), false, "1 of 4");
  });
  test("only the observations a reader would see count, so a hub entity cannot cover a query by accident", () => {
    const hub = { name: "hub", observations: [{ text: "one" }, { text: "two" }, { text: "alpha beta" }] };
    assert.equal(coversQuery("alpha beta", hub), false, "words in the 3rd observation are never shown");
  });
  test("matches the entity name as well as observation text, ignoring short words", () => {
    assert.equal(coversQuery("x alpha is", { name: "alpha", observations: [] }), true);
  });
});

describe("otherProjectResults", () => {
  test("keeps other projects' strong matches, labelled, compact, with a note", () => {
    const out = otherProjectResults([row("other", "e1", 5)], "mine", Q);
    assert.equal(out.results.length, 1);
    assert.deepEqual(Object.keys(out.results[0]).sort(), ["name", "observations", "project", "relationCount", "score", "type"]);
    assert.equal(out.results[0].project, "other");
    assert.equal(out.results[0].observations.length, 2, "two observations is enough to recognise a hit");
    assert.equal(out.results[0].relationCount, 2);
    assert.match(out.note, /other project/i);
    assert.match(out.note, /not facts about this repo|not this project/i);
  });

  test("excludes the current project and global (project-less) entities, which the scoped search already saw", () => {
    const out = otherProjectResults([row("mine", "a", 9), row(null, "b", 9), row("other", "c", 5)], "mine", Q);
    assert.deepEqual(out.results.map((r) => r.name), ["c"]);
  });

  test("returns null when nothing from another project is a strong match", () => {
    assert.equal(otherProjectResults([row("other", "weak", 1.2, { observations: [{ text: "an unrelated note", subsystem: null }] })], "mine", Q), null);
    assert.equal(otherProjectResults([row("mine", "own", 9)], "mine", Q), null);
    assert.equal(otherProjectResults([], "mine", Q), null);
  });

  test("caps the number of results", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row("other", `e${i}`, 9 - i * 0.1));
    assert.equal(otherProjectResults(rows, "mine", Q).results.length, MAX_OTHER_PROJECT_RESULTS);
  });

  test("drops a high-scoring match that does not actually contain the query's words", () => {
    const stray = row("other", "stray", 6, { observations: [{ text: "mentions retry only", subsystem: null }] });
    assert.equal(otherProjectResults([stray], "mine", Q), null, "1 of 3 words is a fragment match, not an answer");
  });

  test("a match that holds enough of the query's words is kept whatever its score", () => {
    assert.equal(otherProjectResults([row("other", "e", 0.5)], "mine", Q).results.length, 1);
  });

  test("a single-word query needs only that word", () => {
    const one = row("other", "e", 0.5, { observations: [{ text: "a rustacean note", subsystem: null }, { text: "rust here", subsystem: null }] });
    assert.equal(otherProjectResults([one], "mine", "rust").results.length, 1);
  });

  test("every covering match is kept, in rank order, up to the cap", () => {
    const out = otherProjectResults([row("other", "good", 6), row("other", "lower", 1.1)], "mine", Q);
    assert.deepEqual(out.results.map((r) => r.name), ["good", "lower"]);
  });
});
