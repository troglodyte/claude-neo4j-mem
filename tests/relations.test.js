import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { capRelations, resolveRelationCap, DEFAULT_RELATION_CAP } from "../src/lib/relations.js";

const rel = (type, entity) => ({ type, entity });
const entity = (name, relations) => ({ name, type: "x", score: 1, observations: [], relations });

describe("resolveRelationCap", () => {
  test("defaults when unset or blank", () => {
    assert.equal(resolveRelationCap({}), DEFAULT_RELATION_CAP);
    assert.equal(resolveRelationCap({ CLAUDE_NEO4J_SEARCH_RELATIONS_CAP: "" }), DEFAULT_RELATION_CAP);
  });

  test("reads a positive integer", () => {
    assert.equal(resolveRelationCap({ CLAUDE_NEO4J_SEARCH_RELATIONS_CAP: "3" }), 3);
  });

  test("0 and off disable capping", () => {
    assert.equal(resolveRelationCap({ CLAUDE_NEO4J_SEARCH_RELATIONS_CAP: "0" }), Infinity);
    assert.equal(resolveRelationCap({ CLAUDE_NEO4J_SEARCH_RELATIONS_CAP: "off" }), Infinity);
  });

  test("garbage falls back to the default rather than disabling the cap", () => {
    assert.equal(resolveRelationCap({ CLAUDE_NEO4J_SEARCH_RELATIONS_CAP: "lots" }), DEFAULT_RELATION_CAP);
    assert.equal(resolveRelationCap({ CLAUDE_NEO4J_SEARCH_RELATIONS_CAP: "-2" }), DEFAULT_RELATION_CAP);
  });
});

describe("capRelations", () => {
  test("adds relationCount and leaves a small relation list untouched", () => {
    const relations = [rel("uses", "a"), rel("uses", "b")];
    const [out] = capRelations([entity("e", relations)], "q", 8);
    assert.deepEqual(out.relations, relations);
    assert.equal(out.relationCount, 2);
  });

  test("caps a long list but reports the true total", () => {
    const relations = Array.from({ length: 20 }, (_, i) => rel("uses", `t${i}`));
    const [out] = capRelations([entity("e", relations)], "q", 8);
    assert.equal(out.relations.length, 8);
    assert.equal(out.relationCount, 20);
  });

  test("keeps targets that are also in the result set ahead of others", () => {
    const results = [
      entity("hub", [rel("uses", "zzz"), rel("uses", "yyy"), rel("uses", "visible")]),
      entity("visible", []),
    ];
    const [hub] = capRelations(results, "unrelated", 1);
    assert.deepEqual(hub.relations, [rel("uses", "visible")]);
  });

  test("then prefers targets whose name matches a query term", () => {
    const results = [entity("hub", [rel("uses", "aaa"), rel("uses", "decision:token-refresh"), rel("uses", "bbb")])];
    const [hub] = capRelations(results, "token refresh bug", 1);
    assert.deepEqual(hub.relations, [rel("uses", "decision:token-refresh")]);
  });

  test("a type prefix alone is not a query match", () => {
    const results = [entity("hub", [rel("uses", "decision:alpha"), rel("uses", "skill:beta")])];
    const [hub] = capRelations(results, "skill", 1);
    assert.deepEqual(hub.relations, [rel("uses", "decision:alpha")], "'skill' must not promote skill:beta by prefix");
  });

  test("breaks ties in the original order, so output is deterministic", () => {
    const relations = [rel("uses", "c"), rel("uses", "a"), rel("uses", "b")];
    const [out] = capRelations([entity("e", relations)], "q", 2);
    assert.deepEqual(out.relations, [rel("uses", "c"), rel("uses", "a")]);
  });

  test("Infinity keeps everything but still reports the count", () => {
    const relations = Array.from({ length: 30 }, (_, i) => rel("uses", `t${i}`));
    const [out] = capRelations([entity("e", relations)], "q", Infinity);
    assert.equal(out.relations.length, 30);
    assert.equal(out.relationCount, 30);
  });

  test("does not mutate its input", () => {
    const relations = Array.from({ length: 12 }, (_, i) => rel("uses", `t${i}`));
    const input = [entity("e", relations)];
    capRelations(input, "q", 3);
    assert.equal(input[0].relations.length, 12);
    assert.equal("relationCount" in input[0], false);
  });

  test("tolerates an entity with no relations field", () => {
    const [out] = capRelations([{ name: "e", observations: [] }], "q", 8);
    assert.deepEqual(out.relations, []);
    assert.equal(out.relationCount, 0);
  });
});
