#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureSchema } from "../lib/schema.js";
import * as graph from "../lib/graph.js";
import { detectProject } from "../lib/project.js";
import { closeDriver } from "../lib/neo4jClient.js";
import { loadConnectionConfig, shouldNotifyOnWrite } from "../lib/config.js";

const project = detectProject();

const server = new McpServer({ name: "neo4j-memory", version: "0.1.0" });

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
}

server.tool(
  "memory_search",
  "Full-text search the Neo4j memory graph for entities and observations matching a query. Returns matching entities with their most recent observations and directly related entities.",
  { query: z.string().describe("Search text"), limit: z.number().int().min(1).max(50).optional() },
  async ({ query, limit }) => {
    try {
      return textResult(await graph.searchMemory(query, limit ?? 10, project));
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "memory_get_entity",
  "Get full detail for one entity: all of its observations plus all incoming and outgoing relations to other entities.",
  { name: z.string() },
  async ({ name }) => {
    try {
      const entity = await graph.getEntity(name, project);
      return textResult(entity ?? { error: `no entity named "${name}"` });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "memory_add_observations",
  "Record one or more durable facts/observations about an entity (a person, project, decision, preference, or convention). Creates the entity if it doesn't exist yet. Only record things worth remembering across sessions, not ephemeral chit-chat. If the response includes a `confirmation` field, relay it to the user in a short line (e.g. '🧠 remembered: ...') rather than staying silent about the write.",
  {
    entity: z.string().describe("Entity name, e.g. 'user', 'decision:auth-approach', 'preference:testing'"),
    entityType: z.string().optional().describe("e.g. person, project, decision, preference, fact"),
    observations: z.array(z.string()).min(1),
  },
  async ({ entity, entityType, observations }) => {
    try {
      const ids = await graph.addObservations({ entity, entityType, observations, project });
      const result = { entity, added: ids.length, observationIds: ids };
      if (shouldNotifyOnWrite()) {
        result.confirmation = `remembered ${ids.length} observation(s) on "${entity}"`;
      }
      return textResult(result);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "memory_create_relation",
  "Create a directed, typed relationship between two entities in the memory graph, e.g. from='claude-neo4j' type='uses' to='neo4j-driver'. Creates either entity if missing. If the response includes a `confirmation` field, relay it to the user in a short line.",
  { from: z.string(), to: z.string(), type: z.string() },
  async ({ from, to, type }) => {
    try {
      await graph.createRelation({ from, to, type, project });
      const result = { ok: true };
      if (shouldNotifyOnWrite()) {
        result.confirmation = `linked "${from}" --${type}--> "${to}"`;
      }
      return textResult(result);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "memory_recent",
  "List the most recently updated entities and their latest observations, scoped to the current project when possible. Useful as a general 'what do you remember' refresh.",
  { limit: z.number().int().min(1).max(50).optional() },
  async ({ limit }) => {
    try {
      return textResult(await graph.getRecentContext({ project, limit: limit ?? 15 }));
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "memory_delete_observations",
  "Delete specific observations from an entity by observation id (ids are returned from memory_add_observations or memory_get_entity). If the response includes a `confirmation` field, relay it to the user in a short line.",
  { entity: z.string(), observationIds: z.array(z.string()).min(1) },
  async ({ entity, observationIds }) => {
    try {
      const deleted = await graph.deleteObservations(entity, observationIds, project);
      const result = { deleted };
      if (shouldNotifyOnWrite()) {
        result.confirmation = `forgot ${deleted} observation(s) on "${entity}"`;
      }
      return textResult(result);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "memory_delete_entity",
  "Delete an entity and all of its observations and relations. Use when the user asks you to forget something. If the response includes a `confirmation` field, relay it to the user in a short line.",
  { entity: z.string() },
  async ({ entity }) => {
    try {
      await graph.deleteEntity(entity, project);
      const result = { ok: true };
      if (shouldNotifyOnWrite()) {
        result.confirmation = `forgot entity "${entity}" (all observations and relations)`;
      }
      return textResult(result);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "memory_timeline",
  "Fetch the chronological history of observations (optionally since a given ISO date), oldest first, scoped to the current project. Use for narrative timeline/digest reports of project history, not for point lookups.",
  {
    since: z.string().optional().describe("ISO 8601 date/time; only observations at or after this point are returned"),
    limit: z.number().int().min(1).max(2000).optional(),
  },
  async ({ since, limit }) => {
    try {
      return textResult(await graph.getTimeline({ project, since, limit: limit ?? 300 }));
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "memory_status",
  "Report memory backend connection info (local Docker vs remote) and entity/observation counts for the current project.",
  {},
  async () => {
    try {
      const { uri, database, mode } = loadConnectionConfig();
      const counts = await graph.getStatus({ project });
      return textResult({ uri, database, mode, project, ...counts });
    } catch (error) {
      return errorResult(error);
    }
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
