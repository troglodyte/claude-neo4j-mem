#!/usr/bin/env node
import fs from "node:fs";
import { detectProject } from "../lib/project.js";
import { upsertSession, getPinnedFacts, getSubsystemMap } from "../lib/graph.js";
import { renderInjection } from "../lib/injection.js";
import { UNTAGGED } from "../lib/subsystem.js";
import { storeStatus, closeDb, getDb } from "../lib/memoryStore.js";
import { catchUpDue, spawnCatchUp } from "../lib/catchUp.js";
import { beginFirstStart } from "../lib/firstStart.js";
import { consumeCaptureDigest } from "../lib/captureDigest.js";
import { sweepPendingCaptures, pruneStaleState } from "./capture.js";

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const { session_id: sessionId, cwd } = input;

  const firstStart = await beginFirstStart();
  if (firstStart) {
    process.stdout.write(JSON.stringify({ systemMessage: `\u{1f9e0} Memory: off — ${firstStart}` }));
    return;
  }

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
    try {
      if (catchUpDue(getDb())) {
        spawnCatchUp();
      }
    } catch (error) {
      process.stderr.write(`claude-neo4j: catch-up not started: ${error.message}\n`);
    }

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
