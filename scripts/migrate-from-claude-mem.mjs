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
// claude-mem scopes memory by bare directory name ("my-repo") while this plugin
// scopes by a git-remote-derived identifier ("github.com/you/my-repo"). Importing
// under claude-mem's name would split one repo's memory across two project scopes
// that can never see each other, so every claude-mem project is mapped onto the
// identifier detectProject() would produce - explicitly via --as, or automatically
// when the migration is run from inside the matching repo.
//
// Usage:
//   node scripts/migrate-from-claude-mem.mjs [--db PATH] [--project NAME] [--as ID] [--dry-run]
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { ensureSchema } from "../src/lib/schema.js";
import { withSession, int } from "../src/lib/neo4jClient.js";
import { closeDriver } from "../src/lib/neo4jClient.js";
import { detectProject } from "../src/lib/project.js";

function parseArgs(argv) {
  const flags = { db: path.join(homedir(), ".claude-mem", "claude-mem.db"), project: null, as: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") flags.db = argv[++i];
    else if (argv[i] === "--project") flags.project = argv[++i];
    else if (argv[i] === "--as") flags.as = argv[++i];
    else if (argv[i] === "--dry-run") flags.dryRun = true;
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return flags;
}

/**
 * Maps a claude-mem project name onto the project scope this plugin would use.
 * `--as` wins; otherwise the cwd is only trusted when its basename matches the
 * claude-mem project, which is the case when you migrate from inside the repo.
 * Falling back to the bare name is what causes split memory, so it's reported.
 */
function resolveScope(claudeMemProject, asFlag, cwd = process.cwd()) {
  if (asFlag) return { scope: asFlag, via: "--as" };
  if (path.basename(cwd) === claudeMemProject) {
    const detected = detectProject(cwd);
    if (detected !== claudeMemProject) return { scope: detected, via: "git remote of cwd" };
    return { scope: detected, via: "cwd basename (no git remote)" };
  }
  return { scope: claudeMemProject, via: "claude-mem name (unmapped)", unmapped: true };
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

// claude-mem tags every observation with a type (discovery, bugfix, decision,
// ...). The first version of this script dropped that and hung all of a
// project's history off a single entity, which produced a 711-observation node
// that was useless to browse and expensive to read. Each type gets its own
// entity instead, named to match the plugin's own "<type>:<subject>" convention.
function entityNameFor(type, project) {
  return `${type}:${project}`;
}

async function upsertEntity(session, name, type, scope) {
  await session.run(
    `MERGE (e:Entity {name: $name, project: $scope})
     ON CREATE SET e.type = $type, e.createdAt = datetime()
     ON MATCH SET e.type = coalesce(e.type, $type)`,
    { name, type, scope }
  );
}

// Re-attaching also detaches: an observation imported by an older version of
// this script is still hanging off the old single entity, so re-running moves
// it rather than leaving it double-attached. That makes the script self-healing
// for graphs imported before the per-type split existed.
async function attachObservations(session, name, scope, batch) {
  await session.run(
    `MATCH (e:Entity {name: $name, project: $scope})
     UNWIND $batch AS row
     MERGE (o:Observation {id: row.id})
     ON CREATE SET o.text = row.text, o.createdAt = datetime(row.createdAt), o.sessionId = row.sessionId,
                   o.source = "claude-mem"
     MERGE (o)-[:ABOUT]->(e)
     WITH o, e
     MATCH (o)-[stale:ABOUT]->(other:Entity)
     WHERE other <> e
     DELETE stale`,
    { name, scope, batch }
  );
}

async function importObservations(session, project, scope, rows, dryRun) {
  if (rows.length === 0) return 0;
  if (dryRun) return rows.length;

  const byType = new Map();
  for (const row of rows) {
    const type = row.type || "observation";
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push({
      id: stableId("obs", row.memory_session_id, String(row.id), row.content_hash ?? ""),
      text: observationText(row),
      createdAt: row.created_at,
      sessionId: row.memory_session_id,
    });
  }

  let count = 0;
  for (const [type, batch] of byType) {
    const name = entityNameFor(type, project);
    await upsertEntity(session, name, type, scope);
    await attachObservations(session, name, scope, batch);
    count += batch.length;
  }
  return count;
}

// Anything left holding zero observations after a re-run is the old single
// entity this script used to create; drop it rather than leaving an empty stub.
async function dropEmptyLegacyEntity(session, project, scope) {
  const result = await session.run(
    `MATCH (e:Entity {name: $project, project: $scope})
     WHERE NOT (:Observation)-[:ABOUT]->(e) AND NOT (e)-[:RELATES_TO]-()
     DELETE e
     RETURN count(*) AS dropped`,
    { project, scope }
  );
  return result.records[0]?.get("dropped")?.toNumber?.() ?? 0;
}

async function importSummaries(session, project, scope, rows, dryRun) {
  if (rows.length === 0) return 0;
  if (dryRun) return rows.length;
  const batch = rows.map((row) => ({
    id: stableId("summary", row.memory_session_id, String(row.id)),
    text: summaryText(row),
    createdAt: row.created_at,
    sessionId: row.memory_session_id,
  }));
  const name = entityNameFor("session-summary", project);
  await upsertEntity(session, name, "session-summary", scope);
  await attachObservations(session, name, scope, batch);
  return batch.length;
}

async function main() {
  const { db: dbPath, project: projectFilter, as: asFlag, dryRun } = parseArgs(process.argv.slice(2));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const projects = projectFilter
    ? [projectFilter]
    : db.prepare(`SELECT DISTINCT project FROM observations
                  UNION SELECT DISTINCT project FROM session_summaries`).all().map((r) => r.project);

  if (asFlag && projects.length > 1) {
    console.error(
      `--as maps a single project, but ${projects.length} were found (${projects.join(", ")}).\n` +
        `Pair it with --project, e.g. --project ${projects[0]} --as ${asFlag}`
    );
    process.exit(1);
  }

  if (!dryRun) await ensureSchema();

  let totalObs = 0;
  let totalSummaries = 0;
  const unmapped = [];

  await withSession(async (session) => {
    for (const project of projects) {
      const obsRows = db
        .prepare(`SELECT id, memory_session_id, type, title, narrative, text, content_hash, created_at
                  FROM observations WHERE project = ?`)
        .all(project);
      const summaryRows = db
        .prepare(`SELECT id, memory_session_id, request, learned, completed, next_steps, notes, created_at
                  FROM session_summaries WHERE project = ?`)
        .all(project);

      const { scope, via, unmapped: isUnmapped } = resolveScope(project, asFlag);
      if (isUnmapped) unmapped.push(project);

      const obsCount = await importObservations(session, project, scope, obsRows, dryRun);
      const summaryCount = await importSummaries(session, project, scope, summaryRows, dryRun);
      totalObs += obsCount;
      totalSummaries += summaryCount;

      const types = [...new Set(obsRows.map((r) => r.type || "observation"))].sort();
      console.log(
        `${dryRun ? "[dry-run] " : ""}${project} -> ${scope} (${via}): ` +
          `${obsCount} observation(s), ${summaryCount} session summary(ies)\n` +
          `  entities: ${[...types, "session-summary"].map((t) => entityNameFor(t, project)).join(", ")}`
      );

      if (!dryRun && (await dropEmptyLegacyEntity(session, project, scope))) {
        console.log(`  dropped legacy single entity "${project}" (its observations moved to the per-type entities above)`);
      }
    }
  });

  db.close();
  console.log(`\nTotal: ${totalObs} observations + ${totalSummaries} summaries across ${projects.length} project(s).`);

  if (unmapped.length > 0) {
    console.log(
      `\nWarning: ${unmapped.length} project(s) were imported under claude-mem's bare name ` +
        `(${unmapped.join(", ")}).\n` +
        `If a project is a git repo, this plugin will scope its memory to the git remote instead, ` +
        `and the two halves will never see each other.\n` +
        `To map them, re-run from inside the repo, or pass the identifier explicitly:\n` +
        unmapped.map((p) => `  npm run migrate-claude-mem -- --project ${p} --as github.com/you/${p}`).join("\n") +
        `\n(Re-running is safe: observation ids are content hashes, so nothing is duplicated. ` +
        `An earlier unmapped import can be moved with:\n` +
        `  MATCH (e:Entity {name:'${unmapped[0]}', project:'${unmapped[0]}'}) SET e.project = '<identifier>')`
    );
  }

  if (dryRun) console.log("Dry run only - nothing written. Re-run without --dry-run to import.");
}

main()
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
