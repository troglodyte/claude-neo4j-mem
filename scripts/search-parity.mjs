#!/usr/bin/env node
// Replays the logged memory_search queries through the Lucene-era Neo4j search
// and the SQLite engine, over the same data, and checks they agree.
// Neo4j is only read. The SQLite side is a fresh migration of it into a
// scratch directory, deleted afterwards unless --keep.
//   node scripts/search-parity.mjs [--keep]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import neo4j from "neo4j-driver";
import { CONFIG_DIR, loadConnectionConfig } from "../src/lib/config.js";
import { getDriver, closeDriver } from "../src/lib/neo4jClient.js";
import { readGraph } from "../src/lib/migrate/readNeo4j.js";
import { runMigration } from "../src/lib/migrate/runMigration.js";
import { closeDb } from "../src/lib/memoryStore.js";
import { searchMemory } from "../src/lib/graph.js";
import { WEAK_SCORE } from "../src/lib/relevance.js";
import { parityReport, passesGates, PARITY_GATES } from "../src/lib/searchParity.js";

// The Neo4j engine's ranking (graph.js before the SQLite switch), kept as the
// reference until Neo4j is retired.
const LUCENE_SPECIAL = /([+\-!(){}[\]^"~*?:\\/&|])/g;
const NEO4J_SEARCH = `
  CALL {
    CALL db.index.fulltext.queryNodes('entityNameFulltext', $query) YIELD node, score
    RETURN node AS entity, score
    UNION
    CALL db.index.fulltext.queryNodes('observationTextFulltext', $query) YIELD node, score
    MATCH (node)-[:ABOUT]->(entity)
    RETURN entity, score
  }
  WITH entity, max(score) AS score
  WHERE $project IS NULL OR entity.project = $project OR entity.project IS NULL
  OPTIONAL MATCH (recent:Observation)-[:ABOUT]->(entity)
  WITH entity, score, max(recent.createdAt) AS lastSeen
  WITH entity, CASE WHEN lastSeen IS NULL THEN score
                    ELSE score * (1.0 / (1.0 + duration.inDays(lastSeen, datetime()).days / 30.0)) END AS rankScore
  ORDER BY rankScore DESC
  LIMIT 10
  RETURN entity.name AS name, rankScore AS score`;

function loggedQueries() {
  const seen = new Map();
  const file = path.join(CONFIG_DIR, "telemetry.jsonl");
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.tool === "memory_search" && typeof entry.query === "string") {
      seen.set(`${entry.project}\u0000${entry.query}`, { query: entry.query, project: entry.project ?? null });
    }
  }
  return [...seen.values()];
}

async function neo4jSearch(session, { query, project }) {
  const result = await session.executeRead((tx) =>
    tx.run(NEO4J_SEARCH, { query: query.replace(LUCENE_SPECIAL, "\\$1"), project })
  );
  const rows = result.records.map((r) => ({ name: r.get("name"), score: r.get("score") }));
  const relevance = rows.length === 0 ? "none" : Math.max(...rows.map((r) => r.score)) < WEAK_SCORE ? "weak" : "strong";
  return { names: rows.map((r) => r.name), relevance };
}

async function main() {
  const keep = process.argv.includes("--keep");
  const config = loadConnectionConfig();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "search-parity-"));
  const store = path.join(scratch, "memory.sqlite");
  try {
    const readOnce = async () => {
      const session = getDriver().session({ database: config.database, defaultAccessMode: neo4j.session.READ });
      try {
        return await readGraph(session);
      } finally {
        await session.close();
      }
    };
    const migrated = await runMigration({
      readOnce,
      out: store,
      reportPath: path.join(scratch, "migration-report.json"),
      sourceLabel: "neo4j (search parity)",
      log: () => {},
    });
    if (migrated.exitCode !== 0) {
      console.error(`The scratch migration failed (exit ${migrated.exitCode}); see ${scratch}.`);
      return 2;
    }
    process.env.CLAUDE_NEO4J_SQLITE = store;
    const session = getDriver().session({ database: config.database, defaultAccessMode: neo4j.session.READ });
    const pairs = [];
    try {
      for (const q of loggedQueries()) {
        const before = await neo4jSearch(session, q);
        const found = await searchMemory(q.query, 10, q.project);
        pairs.push({ ...q, before, after: { names: found.results.map((r) => r.name), relevance: found.relevance } });
      }
    } finally {
      await session.close();
    }
    const report = parityReport(pairs);
    console.log(JSON.stringify({ ...report, gates: PARITY_GATES }, null, 2));
    console.log(passesGates(report) ? "PASS" : "FAIL");
    return passesGates(report) ? 0 : 1;
  } finally {
    closeDb();
    await closeDriver();
    if (!keep) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
  }
);
