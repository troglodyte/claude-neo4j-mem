#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { detectProject } from "../lib/project.js";
import { upsertSession, getPinnedFacts, getSubsystemMap } from "../lib/graph.js";
import { renderInjection } from "../lib/injection.js";
import { UNTAGGED } from "../lib/subsystem.js";
import { storeStatus, closeDb } from "../lib/memoryStore.js";
import { consumeCaptureDigest } from "../lib/captureDigest.js";
import { sweepPendingCaptures, pruneStaleState } from "./capture.js";

const CLAUDE_MEM_DB = path.join(homedir(), ".claude-mem", "claude-mem.db");

// Only worth suggesting when there's unmigrated claude-mem history for THIS
// project and this project's Neo4j graph is still empty - once migrated (or
// if the user starts building up real memory some other way), never nag again.
// claude-mem always keys its "project" column on the cwd basename, while this
// plugin's detectProject() prefers the git remote - so check both names.
async function claudeMemMigrationHint(project, cwd) {
  if (!fs.existsSync(CLAUDE_MEM_DB)) {
    return null;
  }
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
        if (row?.total > 0) {
          return row.total;
        }
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null; // corrupt/locked/incompatible db - not worth failing session-start over
  }
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const { session_id: sessionId, cwd } = input;

  const status = storeStatus();
  if (!status.ready) {
    process.stdout.write(JSON.stringify({ systemMessage: `\u{1f9e0} Memory: unavailable (${status.reason}).` }));
    return;
  }

  try {
    const project = detectProject(cwd);
    await upsertSession({ id: sessionId, cwd, project });

    const [pinned, map] = await Promise.all([getPinnedFacts({ project }), getSubsystemMap(project)]);
    const additionalContext = renderInjection({ project, pinned, map });

    let systemMessage;
    if (map.length > 0) {
      const observationCount = map.reduce((sum, row) => sum + row.observations, 0);
      const tagCount = map.filter((row) => row.subsystem !== UNTAGGED).length;
      systemMessage =
        `\u{1f9e0} Memory: ${observationCount} observation(s) across ${tagCount} ` +
        `subsystem(s) for ${project}.`;
    } else {
      systemMessage = `\u{1f9e0} Memory: nothing remembered yet for ${project}.`;
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
        systemMessage: `\u{1f9e0} Memory: session start failed (${shortError}).`,
      })
    );
  } finally {
    closeDb();
  }
}

main().catch(() => process.exit(0));
