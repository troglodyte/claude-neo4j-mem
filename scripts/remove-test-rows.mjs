#!/usr/bin/env node
// Removes the rows a test run wrote into the live Neo4j graph on 2026-10-09
// (19:10–19:14Z), which the move to SQLite then copied: the projects
// github.com/acme/app, github.com/acme/other and p, plus observations on the
// global `user` entity from that window ("g", "global", "quokka global", ...).
// SQLite only; Neo4j is never touched. Dry run unless --apply.
import { getDb, closeDb } from "../src/lib/memoryStore.js";
import { deleteEntity, deleteObservations } from "../src/lib/graph.js";

const TEST_PROJECTS = ["github.com/acme/app", "github.com/acme/other", "p"];
const WINDOW = [Date.parse("2026-10-09T19:00:00Z"), Date.parse("2026-10-09T19:30:00Z")];
const apply = process.argv.includes("--apply");
const db = getDb();

const entities = db
  .prepare(`SELECT name, project FROM entities WHERE project IN (${TEST_PROJECTS.map(() => "?").join(",")})`)
  .all(...TEST_PROJECTS);
const userObs = db
  .prepare(
    `SELECT o.id, o.text, o.created_at FROM observations o JOIN entities e ON e.id = o.entity_id
     WHERE e.name = 'user' AND e.project = '' AND o.created_at BETWEEN ? AND ?`
  )
  .all(...WINDOW);

console.log(`${entities.length} test entities in ${TEST_PROJECTS.join(", ")}`);
console.log(`${userObs.length} global "user" observations from the test window:`);
for (const o of userObs) {
  console.log(`  ${new Date(o.created_at).toISOString()}  ${o.text}`);
}
if (apply) {
  for (const { name, project } of entities) {
    await deleteEntity(name, project);
  }
  if (userObs.length) {
    await deleteObservations("user", userObs.map((o) => o.id), "");
  }
  console.log("deleted");
} else {
  console.log("dry run; pass --apply to delete");
}
closeDb();
