import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import neo4j from "neo4j-driver";
import { readGraph } from "../src/lib/migrate/readNeo4j.js";
import { runMigration } from "../src/lib/migrate/runMigration.js";
import { readSqliteGraph } from "../src/lib/migrate/readSqlite.js";
import { fingerprint } from "../src/lib/migrate/fingerprint.js";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { fixtureRecords, FIXTURE_PROJECTS } from "./helpers/graphFixture.js";
import { assertRehearsalTarget } from "./helpers/rehearsalGuard.js";

const URI = process.env.CLAUDE_NEO4J_REHEARSAL_URI;
const PASSWORD = process.env.CLAUDE_NEO4J_REHEARSAL_PASSWORD;
const SKIP =
  !URI || !PASSWORD
    ? "set CLAUDE_NEO4J_REHEARSAL_URI and CLAUDE_NEO4J_REHEARSAL_PASSWORD to rehearse against a throwaway Neo4j"
    : false;

// Every test wipes the database it points at, so it refuses the real graph's
// port. Bolt's default port is 7687, so an omitted port is refused too.
if (URI) {
  const port = new URL(URI.replace(/^[a-z0-9+.-]+:/i, "http:")).port;
  if (port === "7687" || port === "") {
    throw new Error("CLAUDE_NEO4J_REHEARSAL_URI points at port 7687, the real memory graph; use a throwaway on another port");
  }
}

const SCRIPT = fileURLToPath(new URL("../scripts/migrate-to-sqlite.mjs", import.meta.url));
const driver = SKIP ? null : neo4j.driver(URI, neo4j.auth.basic("neo4j", PASSWORD));
after(async () => {
  await driver?.close();
});

const quiet = () => {};
const out = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-rehearsal-")), "memory.sqlite");
const ms = (value) => (value === null ? null : neo4j.int(value));

async function readOnce() {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    return await readGraph(session);
  } finally {
    await session.close();
  }
}

async function write(query, params = {}) {
  const session = driver.session();
  try {
    await session.run(query, params);
  } finally {
    await session.close();
  }
}

// Builds the fixture as a Neo4j graph: global entities get a null project,
// absent values are left unset, and PRODUCED exists only where the Session does.
async function seed(records) {
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      const foreign = await tx.run(
        "MATCH (e:Entity) WHERE NOT coalesce(e.project, '') IN $projects RETURN count(e) AS n",
        { projects: FIXTURE_PROJECTS }
      );
      assertRehearsalTarget(neo4j.integer.toNumber(foreign.records[0].get("n")));
      await tx.run("MATCH (n) DETACH DELETE n");
      for (const e of records.entities) {
        await tx.run(
          `CREATE (e:Entity {name: $name, createdAt: datetime({epochMillis: $createdAt})})
           SET e.project = CASE $project WHEN '' THEN null ELSE $project END,
               e.type = $type,
               e.updatedAt = CASE WHEN $updatedAt IS NULL THEN null ELSE datetime({epochMillis: $updatedAt}) END`,
          { name: e.name, project: e.project, type: e.type, createdAt: ms(e.createdAt), updatedAt: ms(e.updatedAt) }
        );
      }
      for (const s of records.sessions) {
        await tx.run(
          `CREATE (s:Session {id: $id, startedAt: datetime({epochMillis: $startedAt})})
           SET s.cwd = $cwd, s.project = $project`,
          { id: s.id, cwd: s.cwd, project: s.project, startedAt: ms(s.startedAt) }
        );
      }
      for (const o of [...records.observations].sort((a, b) => a.seq - b.seq)) {
        await tx.run(
          `MATCH (e:Entity {name: $entityName}) WHERE coalesce(e.project, '') = $entityProject
           CREATE (o:Observation {id: $id, text: $text, createdAt: datetime({epochMillis: $createdAt})})-[:ABOUT]->(e)
           SET o.subsystem = $subsystem, o.source = $source, o.sessionId = $sessionId
           WITH o
           OPTIONAL MATCH (s:Session {id: $sessionId})
           FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | CREATE (s)-[:PRODUCED]->(o))`,
          {
            id: o.id,
            entityName: o.entityName,
            entityProject: o.entityProject,
            text: o.text,
            subsystem: o.subsystem,
            source: o.source ?? null,
            sessionId: o.sessionId,
            createdAt: ms(o.createdAt),
          }
        );
      }
      for (const r of records.relations) {
        await tx.run(
          `MATCH (a:Entity {name: $fromName}) WHERE coalesce(a.project, '') = $fromProject
           MATCH (b:Entity {name: $toName}) WHERE coalesce(b.project, '') = $toProject
           CREATE (a)-[rel:RELATES_TO {type: $type}]->(b)
           SET rel.createdAt = CASE WHEN $createdAt IS NULL THEN null ELSE datetime({epochMillis: $createdAt}) END`,
          { ...r, createdAt: ms(r.createdAt) }
        );
      }
    });
  } finally {
    await session.close();
  }
}

const addObservation = (id) =>
  write(
    `MATCH (e:Entity {name: 'user'}) WHERE e.project IS NULL
     CREATE (:Observation {id: $id, text: 'written mid-migration', createdAt: datetime({epochMillis: timestamp()})})-[:ABOUT]->(e)`,
    { id }
  );

test("a full copy of the seeded graph passes and matches the fixture exactly", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  const file = out();
  const { exitCode } = await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  assert.equal(exitCode, 0);
  const db = openMemoryDb(file, { readOnly: true });
  assert.deepEqual(fingerprint(readSqliteGraph(db)), fingerprint(fixtureRecords()));
  db.close();
});

test("a write landing between reads forces another read and is included", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  let reads = 0;
  const racingRead = async () => {
    const records = await readOnce();
    if (++reads === 1) {
      await addObservation("obs-raced");
    }
    return records;
  };
  const { exitCode, report } = await runMigration({ readOnce: racingRead, out: out(), sourceLabel: URI, log: quiet });
  assert.equal(exitCode, 0);
  assert.ok(report.reads >= 3, `expected a retry, got ${report.reads} reads`);
  assert.equal(report.comparison.types.observations.source, 7);
});

test("observations written after a copy are added by the next run", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  const file = out();
  await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  await addObservation("obs-after");
  const { exitCode, report } = await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  assert.equal(exitCode, 0);
  assert.equal(report.write.inserted.observations, 1);
});

test("updates and deletes after a copy are reported and not applied", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  const file = out();
  await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  await write("MATCH (e:Entity {name: 'ticket:APP-1'}) SET e.type = 'ticket'");
  await write("MATCH (o:Observation {id: 'obs-3'}) DETACH DELETE o");
  const { exitCode, report } = await runMigration({ readOnce, out: file, sourceLabel: URI, log: quiet });
  assert.equal(exitCode, 1);
  assert.deepEqual(report.comparison.types.entities.changed.map((row) => row.fields), [["type"]]);
  assert.deepEqual(report.comparison.types.observations.extra, ['["obs-3"]']);
});

test("the command exits 0 against the rehearsal graph", { skip: SKIP }, async () => {
  await seed(fixtureRecords());
  const file = out();
  const result = spawnSync(process.execPath, ["--no-warnings", SCRIPT, "--out", file], {
    env: {
      ...process.env,
      HOME: path.dirname(file),
      NEO4J_URI: URI,
      NEO4J_USERNAME: "neo4j",
      NEO4J_PASSWORD: PASSWORD,
      NEO4J_DATABASE: "neo4j",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^PASS /m);
});
