import { test } from "node:test";
import assert from "node:assert/strict";
import neo4j from "neo4j-driver";
import { toEpochMs, toRecords, inventoryProblems } from "../src/lib/migrate/readNeo4j.js";

const { DateTime, LocalDateTime } = neo4j.types;
const EXPECTED = Date.UTC(2026, 6, 22, 13, 32, 22, 780);

test("a UTC datetime Neo4j prints as .78Z converts to 780 ms", () => {
  assert.equal(toEpochMs(new DateTime(2026, 7, 22, 13, 32, 22, 780_000_000, 0), "x"), EXPECTED);
});

test("a datetime with an offset converts to the same instant", () => {
  assert.equal(toEpochMs(new DateTime(2026, 7, 22, 15, 32, 22, 780_000_000, 7200), "x"), EXPECTED);
});

test("a missing timestamp stays null", () => {
  assert.equal(toEpochMs(null, "x"), null);
  assert.equal(toEpochMs(undefined, "x"), null);
});

test("sub-millisecond precision is refused, naming the value", () => {
  assert.throws(
    () => toEpochMs(new DateTime(2026, 7, 22, 13, 32, 22, 780_000_001, 0), "observation o1 createdAt"),
    /observation o1 createdAt has sub-millisecond precision/
  );
});

test("a local datetime or a string is refused rather than guessed at", () => {
  assert.throws(
    () => toEpochMs(new LocalDateTime(2026, 7, 22, 13, 32, 22, 0), "entity e createdAt"),
    /entity e createdAt is not a zoned datetime/
  );
  assert.throws(() => toEpochMs("2026-07-22T13:32:22.78Z", "entity e createdAt"), /not a zoned datetime/);
});

test("raw rows become records with global projects as '' and seq as a number", () => {
  const at = new DateTime(2026, 7, 22, 13, 32, 22, 780_000_000, 0);
  const records = toRecords({
    entities: [{ name: "user", project: null, type: null, createdAt: at, updatedAt: null }],
    observations: [
      { id: "o1", entityName: "user", entityProject: null, text: "t", subsystem: null, sessionId: null, createdAt: at, seq: neo4j.int(42) },
    ],
    relations: [{ fromName: "user", fromProject: null, type: "self", toName: "user", toProject: null, createdAt: null }],
    sessions: [{ id: "s1", cwd: null, project: null, startedAt: at }],
    sessionLinks: [{ sessionId: "s1", observationId: "o1" }],
  });
  assert.equal(records.entities[0].project, "");
  assert.equal(records.entities[0].createdAt, EXPECTED);
  assert.equal(records.observations[0].entityProject, "");
  assert.equal(records.observations[0].seq, 42);
  assert.equal(records.relations[0].fromProject, "");
  assert.equal(records.relations[0].createdAt, null);
  assert.equal(records.sessions[0].project, null, "a session's project is not an entity project and stays null");
  assert.deepEqual(records.sessionLinks, [{ sessionId: "s1", observationId: "o1" }]);
});

// What readGraph's inventory queries return for a graph holding only what the
// migration carries.
const inventory = (overrides = {}) => ({
  nodeLabels: [
    { labels: ["Entity"], count: neo4j.int(3) },
    { labels: ["Observation"], count: neo4j.int(5) },
    { labels: ["Session"], count: neo4j.int(1) },
  ],
  nodeKeys: [{ labels: ["Observation"], key: "source", count: neo4j.int(5) }],
  relationshipPatterns: [
    { from: ["Observation"], type: "ABOUT", to: ["Entity"], count: neo4j.int(5) },
    { from: ["Session"], type: "PRODUCED", to: ["Observation"], count: neo4j.int(2) },
    { from: ["Entity"], type: "RELATES_TO", to: ["Entity"], count: neo4j.int(1) },
  ],
  relationshipKeys: [{ type: "RELATES_TO", key: "createdAt", count: neo4j.int(1) }],
  ...overrides,
});

test("a graph holding only mapped labels, relationships and properties has nothing unmapped", () => {
  assert.deepEqual(inventoryProblems(inventory()), []);
});

test("labels, relationships and properties outside the mapping are named with their counts", () => {
  const problems = inventoryProblems(
    inventory({
      nodeLabels: [
        { labels: ["Entity"], count: 3 },
        { labels: ["Entity", "Pinned"], count: 1 },
        { labels: ["Tag"], count: 2 },
      ],
      nodeKeys: [{ labels: ["Observation"], key: "mood", count: 2 }],
      relationshipPatterns: [
        { from: ["Entity"], type: "LIKES", to: ["Entity"], count: 4 },
        { from: ["Session"], type: "RELATES_TO", to: ["Entity"], count: 1 },
      ],
      relationshipKeys: [{ type: "RELATES_TO", key: "weight", count: 1 }],
    })
  );
  assert.deepEqual(problems, [
    "1 node(s) labelled :Entity:Pinned are not migrated",
    "2 node(s) labelled :Tag are not migrated",
    "Observation.mood on 2 node(s) is not migrated",
    "4 :LIKES relationship(s) from :Entity to :Entity are not migrated",
    "1 :RELATES_TO relationship(s) from :Session to :Entity are not migrated",
    "RELATES_TO.weight on 1 relationship(s) is not migrated",
  ]);
});

test("an observation's source is carried, and unmapped content travels with the records", () => {
  const at = new DateTime(2026, 7, 22, 13, 32, 22, 780_000_000, 0);
  const records = toRecords({
    entities: [],
    relations: [],
    sessions: [],
    sessionLinks: [],
    observations: [
      { id: "o1", entityName: "user", entityProject: null, text: "t", subsystem: null, source: "claude-mem", sessionId: null, createdAt: at, seq: 1 },
    ],
    inventory: inventory({ nodeKeys: [{ labels: ["Observation"], key: "mood", count: 2 }] }),
  });
  assert.equal(records.observations[0].source, "claude-mem");
  assert.deepEqual(records.unmapped, ["Observation.mood on 2 node(s) is not migrated"]);
});
