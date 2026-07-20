#!/usr/bin/env node
import fs from "node:fs";
import { ensureSchema } from "../lib/schema.js";
import { detectProject } from "../lib/project.js";
import { upsertSession, getRecentContext } from "../lib/graph.js";
import { closeDriver, verifyConnectivity } from "../lib/neo4jClient.js";
import { isConfigured } from "../lib/config.js";

const TOOLS_BLURB =
  "You have a persistent Neo4j-backed memory graph available via MCP tools: memory_search, " +
  "memory_get_entity, memory_recent, memory_add_observations, memory_create_relation, " +
  "memory_delete_observations, memory_delete_entity, memory_status. Call memory_add_observations " +
  "when you learn a durable fact, decision, or preference worth keeping beyond this session " +
  "(automatic capture also runs at compaction and session end as a backstop, so you don't need to " +
  "log everything manually).";

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
