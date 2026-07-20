#!/usr/bin/env node
// One-off migration: claude-mem's per-project SQLite DB -> this plugin's Neo4j graph.
//
// claude-mem models memory as flat observation/session_summary rows per project.
// This plugin models it as Entity(name, project) <-[:ABOUT]- Observation, so every
// claude-mem project becomes one Entity (type "project") and every observation/
// summary row becomes an Observation attached to it, preserving the original
// timestamp and using claude-mem's content_hash (or a stable hash of the summary
// row) as the Observation id - so re-running this script is a no-op, not a
// duplicate import.
//
// Usage:
//   node scripts/migrate-from-claude-mem.mjs [--db PATH] [--project NAME] [--dry-run]
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { ensureSchema } from "../src/lib/schema.js";
import { withSession, int } from "../src/lib/neo4jClient.js";
import { closeDriver } from "../src/lib/neo4jClient.js";

function parseArgs(argv) {
  const flags = { db: path.join(homedir(), ".claude-mem", "claude-mem.db"), project: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") flags.db = argv[++i];
    else if (argv[i] === "--project") flags.project = argv[++i];
    else if (argv[i] === "--dry-run") flags.dryRun = true;
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return flags;
}

function observationText(row) {
  const parts = [row.title, row.narrative || row.text].filter(Boolean);
  return parts.join(": ") || row.text || row.type;
}

function summaryText(row) {
  const parts = [
    row.request && `Request: ${row.request}`,
    row.learned && `Learned: ${row.learned}`,
    row.completed && `Completed: ${row.completed}`,
    row.next_steps && `Next steps: ${row.next_steps}`,
  ].filter(Boolean);
  return parts.join(" | ") || row.notes || "session summary";
}

function stableId(...parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

async function upsertProjectEntity(session, project) {
  await session.run(
    `MERGE (e:Entity {name: $project, project: $project})
     ON CREATE SET e.type = "project", e.createdAt = datetime()
     ON MATCH SET e.type = coalesce(e.type, "project")`,
    { project }
  );
}

async function importObservations(session, project, rows, dryRun) {
  if (rows.length === 0) return 0;
  if (dryRun) return rows.length;
  const batch = rows.map((row) => ({
    id: stableId("obs", row.memory_session_id, String(row.id), row.content_hash ?? ""),
    text: observationText(row),
    createdAt: row.created_at,
    sessionId: row.memory_session_id,
  }));
  await session.run(
    `MATCH (e:Entity {name: $project, project: $project})
     UNWIND $batch AS row
     MERGE (o:Observation {id: row.id})
     ON CREATE SET o.text = row.text, o.createdAt = datetime(row.createdAt), o.sessionId = row.sessionId,
                   o.source = "claude-mem"
     MERGE (o)-[:ABOUT]->(e)`,
    { project, batch }
  );
  return batch.length;
}

async function importSummaries(session, project, rows, dryRun) {
  if (rows.length === 0) return 0;
  if (dryRun) return rows.length;
  const batch = rows.map((row) => ({
    id: stableId("summary", row.memory_session_id, String(row.id)),
    text: summaryText(row),
    createdAt: row.created_at,
    sessionId: row.memory_session_id,
  }));
  await session.run(
    `MATCH (e:Entity {name: $project, project: $project})
     UNWIND $batch AS row
     MERGE (o:Observation {id: row.id})
     ON CREATE SET o.text = row.text, o.createdAt = datetime(row.createdAt), o.sessionId = row.sessionId,
                   o.source = "claude-mem"
     MERGE (o)-[:ABOUT]->(e)`,
    { project, batch }
  );
  return batch.length;
}

async function main() {
  const { db: dbPath, project: projectFilter, dryRun } = parseArgs(process.argv.slice(2));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const projects = projectFilter
    ? [projectFilter]
    : db.prepare(`SELECT DISTINCT project FROM observations
                  UNION SELECT DISTINCT project FROM session_summaries`).all().map((r) => r.project);

  if (!dryRun) await ensureSchema();

  let totalObs = 0;
  let totalSummaries = 0;

  await withSession(async (session) => {
    for (const project of projects) {
      const obsRows = db
        .prepare(`SELECT id, memory_session_id, title, narrative, text, content_hash, created_at
                  FROM observations WHERE project = ?`)
        .all(project);
      const summaryRows = db
        .prepare(`SELECT id, memory_session_id, request, learned, completed, next_steps, notes, created_at
                  FROM session_summaries WHERE project = ?`)
        .all(project);

      if (!dryRun) await upsertProjectEntity(session, project);

      const obsCount = await importObservations(session, project, obsRows, dryRun);
      const summaryCount = await importSummaries(session, project, summaryRows, dryRun);
      totalObs += obsCount;
      totalSummaries += summaryCount;

      console.log(
        `${dryRun ? "[dry-run] " : ""}${project}: ${obsCount} observation(s), ${summaryCount} session summary(ies)`
      );
    }
  });

  db.close();
  console.log(`\nTotal: ${totalObs} observations + ${totalSummaries} summaries across ${projects.length} project(s).`);
  if (dryRun) console.log("Dry run only - nothing written. Re-run without --dry-run to import.");
}

main()
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
