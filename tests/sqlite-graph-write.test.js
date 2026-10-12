import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { useTempStore } from "./helpers/tempStore.js";
import { closeDb, getDb } from "../src/lib/memoryStore.js";
import * as graph from "../src/lib/graph.js";

const P = "github.com/acme/app";
const ENGINE = fileURLToPath(new URL("../src/lib/graph.js", import.meta.url));
const rows = (sql, ...params) => getDb().prepare(sql).all(...params);

beforeEach(() => {
  useTempStore();
});

after(() => {
  closeDb();
});

test("an observation batch shares one timestamp and keeps its order", async () => {
  await graph.addObservations({ entity: "decision:storage", entityType: "decision", project: P, observations: ["first", "second", "third"] });
  const stored = rows("SELECT text, created_at FROM observations ORDER BY rowid");
  assert.deepEqual(stored.map((row) => row.text), ["first", "second", "third"]);
  assert.equal(new Set(stored.map((row) => row.created_at)).size, 1);
});

test("addObservations returns the new ids and accepts plain strings and tagged objects", async () => {
  const ids = await graph.addObservations({ entity: "fact:x", project: P, observations: ["plain", { text: "tagged", subsystem: "capture" }] });
  assert.equal(ids.length, 2);
  const stored = rows("SELECT id, text, subsystem FROM observations ORDER BY rowid");
  assert.deepEqual(stored.map((row) => [row.id, row.text, row.subsystem]), [
    [ids[0], "plain", null],
    [ids[1], "tagged", "capture"],
  ]);
});

test("a global entity is visible from every project, a project entity only from its own", async () => {
  await graph.addObservations({ entity: "user", entityType: "person", project: null, observations: ["global fact"] });
  await graph.addObservations({ entity: "decision:mine", project: P, observations: ["mine"] });
  assert.deepEqual((await graph.listEntityNames(P)).sort(), ["decision:mine", "user"]);
  assert.deepEqual(await graph.listEntityNames("github.com/acme/other"), ["user"]);
  assert.deepEqual(rows("SELECT project FROM entities WHERE name = 'user'").map((row) => row.project), [""]);
});

test("an existing entity keeps its type unless a new one is given, and is marked updated", async () => {
  await graph.addObservations({ entity: "decision:typed", entityType: "decision", project: P, observations: ["one"] });
  const [created] = rows("SELECT type, updated_at FROM entities");
  assert.equal(created.type, "decision");
  assert.equal(created.updated_at, null);
  await graph.addObservations({ entity: "decision:typed", project: P, observations: ["two"] });
  const [kept] = rows("SELECT type, updated_at FROM entities");
  assert.equal(kept.type, "decision");
  assert.equal(typeof kept.updated_at, "number");
  await graph.addObservations({ entity: "decision:typed", entityType: "preference", project: P, observations: ["three"] });
  assert.equal(rows("SELECT type FROM entities")[0].type, "preference");
});

test("a near-identical name snaps onto the existing entity", async () => {
  await graph.addObservations({ entity: "decision:storage-layout", project: P, observations: ["one"] });
  await graph.addObservations({ entity: "decision:storage-layouts", project: P, observations: ["two"] });
  assert.deepEqual(rows("SELECT name FROM entities").map((row) => row.name), ["decision:storage-layout"]);
});

test("names and observations are searchable by word as soon as they are written", async () => {
  await graph.addObservations({ entity: "feature:capture-visibility", project: P, observations: ["prefers pnpm"] });
  assert.equal(rows("SELECT rowid FROM entity_name_fts WHERE entity_name_fts MATCH ?", '"feature:capture"').length, 1);
  assert.equal(rows("SELECT rowid FROM observation_text_fts WHERE observation_text_fts MATCH ?", '"pnpm"').length, 1);
});

test("text with emoji or a broken character is stored and found by its words", async () => {
  await graph.addObservations({ entity: "fact:odd", project: P, observations: ["deploy 🚀 done \uD83D"] });
  assert.equal(rows("SELECT text FROM observations")[0].text, "deploy 🚀 done �");
  assert.equal(rows("SELECT rowid FROM observation_text_fts WHERE observation_text_fts MATCH ?", '"deploy"').length, 1);
});

test("createRelation creates missing ends and never duplicates an edge", async () => {
  await graph.createRelation({ from: "decision:a", to: "ticket:B-1", type: "implements", project: P });
  await graph.createRelation({ from: "decision:a", to: "ticket:B-1", type: "implements", project: P });
  assert.deepEqual(rows("SELECT name FROM entities ORDER BY name").map((row) => row.name), ["decision:a", "ticket:B-1"]);
  assert.equal(rows("SELECT * FROM relations").length, 1);
});

test("upsertSession records a session once", async () => {
  await graph.upsertSession({ id: "s1", cwd: "/repo", project: P });
  const [first] = rows("SELECT started_at FROM sessions");
  await graph.upsertSession({ id: "s1", cwd: "/elsewhere", project: P });
  const stored = rows("SELECT cwd, started_at FROM sessions");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].cwd, "/repo");
  assert.equal(stored[0].started_at, first.started_at);
});

test("listSubsystems and getSubsystemMap count tags, with an untagged bucket and ISO dates", async () => {
  await graph.addObservations({
    entity: "fact:t",
    project: P,
    observations: [{ text: "a", subsystem: "capture" }, { text: "b", subsystem: "capture" }, "c"],
  });
  assert.deepEqual(await graph.listSubsystems(P), [{ subsystem: "capture", observations: 2 }]);
  const byName = Object.fromEntries((await graph.getSubsystemMap(P)).map((row) => [row.subsystem, row]));
  assert.equal(byName.capture.observations, 2);
  assert.equal(byName.capture.entities, 1);
  assert.equal(byName["(untagged)"].observations, 1);
  assert.match(byName.capture.lastSeen, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("getStatus counts within scope and listProjects skips the global scope", async () => {
  await graph.addObservations({ entity: "user", project: null, observations: ["g"] });
  await graph.addObservations({ entity: "decision:mine", project: P, observations: ["x", "y"] });
  assert.deepEqual(await graph.getStatus({ project: P }), { entityCount: 2, observationCount: 3 });
  const projects = await graph.listProjects();
  assert.deepEqual(projects.map((p) => [p.project, p.entityCount, p.observationCount]), [[P, 1, 2]]);
  assert.match(projects[0].lastActivity, /Z$/);
});

// A capture hook and the memory server are separate processes writing the same
// file. The child says "ready" once it is loaded and spinning, and only then is
// the starting gun fired, so both write loops start together however slowly the
// child came up; a wall-clock head start let the parent finish first.
test("two processes writing at the same moment both land", async () => {
  const file = process.env.CLAUDE_NEO4J_SQLITE;
  getDb();
  const go = path.join(path.dirname(file), "go");
  const script = `import fs from "node:fs";
    import * as g from ${JSON.stringify(ENGINE)};
    fs.writeSync(1, "ready\\n");
    while (!fs.existsSync(${JSON.stringify(go)})) {}
    for (let i = 0; i < 300; i++) {
      await g.addObservations({ entity: "fact:child", project: "p", observations: ["child " + i] });
    }`;
  const writer = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    env: { ...process.env, CLAUDE_NEO4J_SQLITE: file },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  writer.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => writer.on("close", resolve));
  await new Promise((resolve) => {
    writer.stdout.once("data", resolve);
    writer.on("close", resolve);
  });
  fs.writeFileSync(go, "");
  for (let i = 0; i < 300; i++) {
    await graph.addObservations({ entity: "fact:parent", project: "p", observations: [`parent ${i}`] });
  }
  assert.equal(await exited, 0, stderr);
  assert.equal(rows("SELECT count(*) AS n FROM observations")[0].n, 600);
});
