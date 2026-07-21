#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { ensureSchema } from "../lib/schema.js";
import { detectProject } from "../lib/project.js";
import { upsertSession, getRecentContext, getStatus } from "../lib/graph.js";
import { closeDriver, verifyConnectivity } from "../lib/neo4jClient.js";
import { isConfigured } from "../lib/config.js";
import { consumeCaptureDigest } from "../lib/captureDigest.js";
import { sweepPendingCaptures, pruneStaleState } from "./capture.js";

const CLAUDE_MEM_DB = path.join(homedir(), ".claude-mem", "claude-mem.db");

// Only worth suggesting when there's unmigrated claude-mem history for THIS
// project and this project's Neo4j graph is still empty - once migrated (or
// if the user starts building up real memory some other way), never nag again.
// claude-mem always keys its "project" column on the cwd basename, while this
// plugin's detectProject() prefers the git remote - so check both names.
async function claudeMemMigrationHint(project, cwd) {
  if (!fs.existsSync(CLAUDE_MEM_DB)) return null;
  const basename = path.basename(cwd ?? process.cwd());
  const candidates = [...new Set([project, basename])];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(CLAUDE_MEM_DB, { readOnly: true });
    try {
      for (const name of candidates) {
        const row = db
          .prepare(
            `SELECT
               (SELECT count(*) FROM observations WHERE project = ?) +
               (SELECT count(*) FROM session_summaries WHERE project = ?) AS total`
          )
          .get(name, name);
        if (row?.total > 0) return row.total;
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null; // corrupt/locked/incompatible db - not worth failing session-start over
  }
}

const TOOLS_BLURB =
  "You have a persistent Neo4j-backed memory graph available via MCP tools: memory_search, " +
  "memory_get_entity, memory_recent, memory_add_observations, memory_create_relation, " +
  "memory_delete_observations, memory_delete_entity, memory_prune, memory_list_projects, " +
  "memory_status. Call " +
  "memory_add_observations when you learn a durable fact, decision, or preference worth keeping " +
  "beyond this session (automatic capture also runs at compaction and session end as a backstop, " +
  "so you don't need to log everything manually). memory_prune deletes old observations - only " +
  "call it with dryRun: false if the user explicitly asks to clean up/prune old memories.";

const SETUP_HINT =
  "Run scripts/setup-local.sh (needs Docker; generates docker/.env and starts the container for you) " +
  "to get a local Neo4j running and configured, or `node scripts/configure.mjs --mode remote --uri ...` " +
  "to point at a remote/hosted instance instead (e.g. Neo4j Aura). See README.md 'Setup' for details.";

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const { session_id: sessionId, cwd } = input;

  if (!isConfigured()) {
    process.stdout.write(
      JSON.stringify({
        systemMessage: `\u{1f9e0} Neo4j memory: not configured yet. ${SETUP_HINT}`,
      })
    );
    return;
  }

  try {
    await verifyConnectivity();
    await ensureSchema();

    const project = detectProject(cwd);
    await upsertSession({ id: sessionId, cwd, project });
    const recent = await getRecentContext({ project, limit: 15 });

    let additionalContext = `## Memory (Neo4j, project: ${project})\n${TOOLS_BLURB}`;
    let systemMessage;
    if (recent.length > 0) {
      const lines = recent.map((r) => {
        const obs = r.observations.map((o) => `  - ${o}`).join("\n");
        return `- ${r.name}${r.type ? ` (${r.type})` : ""}\n${obs}`;
      });
      additionalContext += `\n\nRelevant facts from past sessions:\n\n${lines.join("\n")}`;
      const observationCount = recent.reduce((sum, r) => sum + r.observations.length, 0);
      systemMessage = `\u{1f9e0} Neo4j memory: loaded ${observationCount} observation(s) across ${recent.length} entit${recent.length === 1 ? "y" : "ies"} for ${project}.`;
    } else {
      systemMessage = `\u{1f9e0} Neo4j memory: connected, nothing remembered yet for ${project}.`;
      const claudeMemCount = await claudeMemMigrationHint(project, cwd);
      if (claudeMemCount) {
        systemMessage +=
          ` Found ${claudeMemCount} claude-mem record(s) for this project - run ` +
          `\`npm run migrate-claude-mem\` to import them (one-off, only when you ask for it).`;
      }
    }

    const digest = consumeCaptureDigest(project);
    if (digest) {
      systemMessage += ` (Auto-capture also saved ${digest.added} observation(s) in the background since your last session.)`;
    }

    // A capture that died has no other trigger to retry it - the session it
    // belonged to is over - so session start is where stranded work resumes.
    // Reported rather than silent: a failed capture means a past session's
    // memory is missing, which the user can't otherwise tell.
    const retried = sweepPendingCaptures();
    if (retried > 0) {
      systemMessage += ` Retrying ${retried} capture(s) that failed earlier; results land in ~/.claude-neo4j/capture.log.`;
    }
    pruneStaleState();

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext,
        },
        systemMessage,
      })
    );
  } catch (error) {
    process.stderr.write(`claude-neo4j: session-start failed: ${error.message}\n`);
    const shortError = error.message.split("\n")[0].slice(0, 120);
    process.stdout.write(
      JSON.stringify({
        systemMessage:
          `\u{1f9e0} Neo4j memory: configured but unreachable (${shortError}). ` +
          "If you're using local Docker, try: scripts/setup-local.sh (starts the container if it's stopped).",
      })
    );
  } finally {
    await closeDriver();
  }
}

main().catch(() => process.exit(0));
