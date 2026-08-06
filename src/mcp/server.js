#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureSchema } from "../lib/schema.js";
import * as graph from "../lib/graph.js";
import { detectProject } from "../lib/project.js";
import { closeDriver } from "../lib/neo4jClient.js";
import { loadConnectionConfig, shouldNotifyOnWrite } from "../lib/config.js";
import { recordToolCall } from "../lib/telemetry.js";

const project = detectProject();

const server = new McpServer({ name: "neo4j-memory", version: "0.1.0" });

/**
 * Register a tool whose handler returns a plain value.
 *
 * Every tool used to repeat the same try/catch/serialize block, which made the
 * response envelope eleven separate decisions instead of one. Folding it here
 * also gives access telemetry a single chokepoint: a tool added later is
 * measured because it registered, not because someone remembered to log it.
 */
function registerTool(name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    const startedAt = Date.now();
    try {
      const value = await handler(args ?? {});
      const text = JSON.stringify(value, null, 2);
      recordToolCall({ tool: name, project, args, value, chars: text.length, ok: true, ms: Date.now() - startedAt });
      return { content: [{ type: "text", text }] };
    } catch (error) {
      const text = JSON.stringify({ error: error.message });
      recordToolCall({ tool: name, project, args, chars: text.length, ok: false, ms: Date.now() - startedAt, error });
      return { content: [{ type: "text", text }], isError: true };
    }
  });
}

registerTool(
  "memory_search",
  "Full-text search the Neo4j memory graph for entities and observations matching a query. Returns {results, relevance, topScore} where results are matching entities with their most recent observations and directly related entities. `relevance` is 'strong', 'weak', or 'none': the index tokenizes on punctuation, so a query can match a fragment and return real-looking rows that do not answer it. When `relevance` is 'weak' a `note` explains why - tell the user memory doesn't appear to have this rather than presenting those rows as the answer.",
  {
    query: z.string().describe("Search text"),
    limit: z.number().int().min(1).max(50).optional(),
    subsystem: z
      .string()
      .optional()
      .describe(
        "Narrow to one subsystem tag, as listed in the SessionStart memory map. Pass '(untagged)' to select only observations with no tag. Every returned observation carries its own `subsystem` (null when untagged)."
      ),
  },
  async ({ query, limit, subsystem }) => graph.searchMemory(query, limit ?? 10, project, { subsystem })
);

registerTool(
  "memory_get_entity",
  "Get detail for one entity: its most recent observations plus all incoming and outgoing relations to other entities. Each observation carries its `subsystem` (null for cross-cutting facts). Observations are capped (default 50, newest first) since an entity's history can be arbitrarily long; `observationCount` reports the true total, so raise `limit` if you need more than what came back.",
  { name: z.string(), limit: z.number().int().positive().optional().describe("Max observations to return (default 50, newest first)") },
  async ({ name, limit }) => {
    const entity = await graph.getEntity(name, project, { limit: limit ?? 50 });
    return entity ?? { error: `no entity named "${name}"` };
  }
);

registerTool(
  "memory_add_observations",
  "Record one or more durable facts/observations about an entity (a person, project, decision, preference, or convention). Creates the entity if it doesn't exist yet. Only record things worth remembering across sessions, not ephemeral chit-chat. If the response includes a `confirmation` field, relay it to the user in a short line (e.g. '🧠 remembered: ...') rather than staying silent about the write.",
  {
    entity: z.string().describe("Entity name, e.g. 'user', 'decision:auth-approach', 'preference:testing'"),
    entityType: z.string().optional().describe("e.g. person, project, decision, preference, fact"),
    observations: z.array(z.string()).min(1),
    subsystem: z
      .string()
      .optional()
      .describe(
        "Area this batch belongs to, e.g. 'auto-capture', 'search'. Reuse a tag from the SessionStart memory map when one fits; omit for cross-cutting facts like user preferences. Reclassifying existing observations is a maintenance script, not a tool: `npm run backfill-subsystems [--retag TAG] [--dry-run]`."
      ),
  },
  async ({ entity, entityType, observations, subsystem }) => {
    const ids = await graph.addObservations({
      entity,
      entityType,
      observations: observations.map((text) => ({ text, subsystem })),
      project,
    });
    const result = { entity, added: ids.length, observationIds: ids };
    if (shouldNotifyOnWrite()) {
      result.confirmation = `remembered ${ids.length} observation(s) on "${entity}"`;
    }
    return result;
  }
);

registerTool(
  "memory_create_relation",
  "Create a directed, typed relationship between two entities in the memory graph, e.g. from='claude-neo4j' type='uses' to='neo4j-driver'. Creates either entity if missing. If the response includes a `confirmation` field, relay it to the user in a short line.",
  { from: z.string(), to: z.string(), type: z.string() },
  async ({ from, to, type }) => {
    await graph.createRelation({ from, to, type, project });
    const result = { ok: true };
    if (shouldNotifyOnWrite()) {
      result.confirmation = `linked "${from}" --${type}--> "${to}"`;
    }
    return result;
  }
);

registerTool(
  "memory_recent",
  "List the most recently updated entities and their latest observations, scoped to the current project when possible. Useful as a general 'what do you remember' refresh.",
  {
    limit: z.number().int().min(1).max(50).optional(),
    subsystem: z
      .string()
      .optional()
      .describe("Narrow to one subsystem tag, or '(untagged)' for observations with no tag"),
  },
  async ({ limit, subsystem }) => graph.getRecentContext({ project, limit: limit ?? 15, subsystem })
);

registerTool(
  "memory_delete_observations",
  "Delete specific observations from an entity by observation id (ids are returned from memory_add_observations or memory_get_entity). If the response includes a `confirmation` field, relay it to the user in a short line.",
  { entity: z.string(), observationIds: z.array(z.string()).min(1) },
  async ({ entity, observationIds }) => {
    const deleted = await graph.deleteObservations(entity, observationIds, project);
    const result = { deleted };
    if (shouldNotifyOnWrite()) {
      result.confirmation = `forgot ${deleted} observation(s) on "${entity}"`;
    }
    return result;
  }
);

registerTool(
  "memory_delete_entity",
  "Delete an entity and all of its observations and relations. Use when the user asks you to forget something. If the response includes a `confirmation` field, relay it to the user in a short line.",
  { entity: z.string() },
  async ({ entity }) => {
    await graph.deleteEntity(entity, project);
    const result = { ok: true };
    if (shouldNotifyOnWrite()) {
      result.confirmation = `forgot entity "${entity}" (all observations and relations)`;
    }
    return result;
  }
);

registerTool(
  "memory_prune",
  "Delete observations older than a given age, keeping the most recent few per entity regardless of age. Defaults to a dry run (dryRun: true) - call it that way first, show the user the count and sample, and only call again with dryRun: false if they explicitly confirm. Never call with dryRun: false unprompted.",
  {
    olderThanDays: z.number().int().min(1).optional().describe("Delete observations older than this many days (default 180)"),
    keepPerEntity: z.number().int().min(0).optional().describe("Always keep this many most-recent observations per entity (default 3)"),
    dryRun: z.boolean().optional().describe("If true (default), report what would be deleted without deleting"),
  },
  async ({ olderThanDays, keepPerEntity, dryRun }) => {
    const result = await graph.pruneObservations({
      project,
      olderThanDays: olderThanDays ?? 180,
      keepPerEntity: keepPerEntity ?? 3,
      dryRun: dryRun ?? true,
    });
    if (!(dryRun ?? true) && shouldNotifyOnWrite()) {
      result.confirmation = `pruned ${result.pruned} old observation(s)`;
    }
    return result;
  }
);

registerTool(
  "memory_timeline",
  "Fetch the chronological history of observations (optionally since a given ISO date), oldest first, scoped to the current project. Use for narrative timeline/digest reports of project history, not for point lookups. Each entry's text is abridged to its opening ~200 characters, which is what narrative summarization needs; returns {events, total, returned, truncated}. When `truncated` is true, walk the history in date windows with `since` rather than raising `limit` - a full history can run to tens of thousands of tokens in one response.",
  {
    since: z.string().optional().describe("ISO 8601 date/time; only observations at or after this point are returned"),
    limit: z.number().int().min(1).max(500).optional().describe("Max events to return (default 100)"),
    subsystem: z
      .string()
      .optional()
      .describe("Narrow to one subsystem tag, or '(untagged)' for observations with no tag"),
  },
  async ({ since, limit, subsystem }) => graph.getTimeline({ project, since, limit: limit ?? 100, subsystem })
);

registerTool(
  "memory_list_projects",
  "List every project tracked anywhere in the memory graph (not scoped to the current project), with entity/observation counts and last activity. Useful for 'what have you got memory for' questions.",
  {},
  async () => graph.listProjects()
);

registerTool(
  "memory_status",
  "Report memory backend connection info (local Docker vs remote) and entity/observation counts for the current project.",
  {},
  async () => {
    const { uri, database, mode } = loadConnectionConfig();
    const counts = await graph.getStatus({ project });
    return { uri, database, mode, project, ...counts };
  }
);

await ensureSchema().catch(() => {
  // Connectivity/config problems surface per-tool-call instead of killing the server at startup.
});

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown() {
  await closeDriver();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
