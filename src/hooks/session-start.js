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

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const { session_id: sessionId, cwd } = input;

  if (!isConfigured()) {
    process.stdout.write("{}");
    return;
  }

  try {
    await verifyConnectivity();
    await ensureSchema();

    const project = detectProject(cwd);
    await upsertSession({ id: sessionId, cwd, project });
    const recent = await getRecentContext({ project, limit: 15 });

    let additionalContext = `## Memory (Neo4j, project: ${project})\n${TOOLS_BLURB}`;
    if (recent.length > 0) {
      const lines = recent.map((r) => {
        const obs = r.observations.map((o) => `  - ${o}`).join("\n");
        return `- ${r.name}${r.type ? ` (${r.type})` : ""}\n${obs}`;
      });
      additionalContext += `\n\nRelevant facts from past sessions:\n\n${lines.join("\n")}`;
    }

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext,
        },
      })
    );
  } catch (error) {
    process.stderr.write(`claude-neo4j: session-start failed: ${error.message}\n`);
    process.stdout.write("{}");
  } finally {
    await closeDriver();
  }
}

main().catch(() => process.exit(0));
