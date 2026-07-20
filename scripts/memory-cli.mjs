#!/usr/bin/env node
// Terminal access to the Neo4j memory graph, outside of a Claude Code session.
// Usage: node scripts/memory-cli.mjs <command> [args...] [--project NAME]
import { ensureSchema } from "../src/lib/schema.js";
import * as graph from "../src/lib/graph.js";
import { detectProject } from "../src/lib/project.js";
import { closeDriver } from "../src/lib/neo4jClient.js";
import { loadConnectionConfig, shouldNotifyOnWrite, setNotifyOnWrite } from "../src/lib/config.js";

function usage() {
  console.error(`Usage: memory-cli.mjs <command> [args...] [--project NAME]

Commands:
  status                              connection info + entity/observation counts
  search <query> [--limit N]          full-text search entities/observations
  recent [--limit N]                  most recently updated entities
  get <entity>                        full detail for one entity
  add <entity> <obs...> [--type T]    add one or more observations to an entity
  relate <from> <type> <to>           create a directed relation between entities
  timeline [--since DATE] [--limit N] chronological observation history
  forget-obs <entity> <id...>         delete specific observations by id
  forget <entity>                     delete an entity and all its data
  mute                                 stop relaying "remembered ..."/"forgot ..." confirmations mid-session
  unmute                               resume relaying write confirmations (default)

Global flags:
  --project NAME   override project scope (default: detected from cwd's git remote)
`);
  process.exit(1);
}

function parseFlags(args, flagSpecs) {
  const rest = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && flagSpecs[arg.slice(2)]) {
      const name = arg.slice(2);
      flags[name] = args[++i];
    } else {
      rest.push(arg);
    }
  }
  return { rest, flags };
}

function printEntity(e) {
  console.log(`\n${e.name}${e.type ? ` (${e.type})` : ""}`);
  if (e.score !== undefined) console.log(`  score: ${e.score.toFixed(3)}`);
  for (const o of e.observations ?? []) {
    if (typeof o === "string") console.log(`  - ${o}`);
    else console.log(`  - [${o.id}] ${o.text}${o.createdAt ? ` (${o.createdAt})` : ""}`);
  }
  for (const r of e.relations ?? e.outgoing ?? []) {
    console.log(`  -> ${r.type} -> ${r.entity}`);
  }
  for (const r of e.incoming ?? []) {
    console.log(`  <- ${r.type} <- ${r.entity}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  const { rest: args, flags } = parseFlags(rest, { project: true, limit: true, type: true, since: true });
  const project = flags.project ?? detectProject(process.cwd());
  const limit = flags.limit ? Number(flags.limit) : undefined;

  await ensureSchema();

  switch (command) {
    case "status": {
      const { uri, database, mode } = loadConnectionConfig();
      const counts = await graph.getStatus({ project });
      console.log(JSON.stringify({ uri, database, mode, project, ...counts }, null, 2));
      break;
    }
    case "search": {
      if (args.length === 0) usage();
      const results = await graph.searchMemory(args.join(" "), limit ?? 10, project);
      if (results.length === 0) console.log("No matches.");
      results.forEach(printEntity);
      break;
    }
    case "recent": {
      const results = await graph.getRecentContext({ project, limit: limit ?? 15 });
      if (results.length === 0) console.log("No entities yet.");
      results.forEach(printEntity);
      break;
    }
    case "get": {
      if (args.length === 0) usage();
      const entity = await graph.getEntity(args.join(" "), project);
      if (!entity) console.log(`No entity named "${args.join(" ")}"`);
      else printEntity(entity);
      break;
    }
    case "add": {
      const [entity, ...observations] = args;
      if (!entity || observations.length === 0) usage();
      const ids = await graph.addObservations({ entity, entityType: flags.type, observations, project });
      console.log(`Added ${ids.length} observation(s) to "${entity}": ${ids.join(", ")}`);
      break;
    }
    case "relate": {
      const [from, type, to] = args;
      if (!from || !type || !to) usage();
      await graph.createRelation({ from, to, type, project });
      console.log(`${from} -[${type}]-> ${to}`);
      break;
    }
    case "timeline": {
      const events = await graph.getTimeline({ project, since: flags.since, limit: limit ?? 300 });
      if (events.length === 0) console.log("No timeline events.");
      for (const e of events) {
        console.log(`${e.createdAt}  ${e.entity}${e.type ? ` (${e.type})` : ""}: ${e.text}`);
      }
      break;
    }
    case "forget-obs": {
      const [entity, ...ids] = args;
      if (!entity || ids.length === 0) usage();
      const deleted = await graph.deleteObservations(entity, ids, project);
      console.log(`Deleted ${deleted} observation(s) from "${entity}".`);
      break;
    }
    case "forget": {
      const [entity] = args;
      if (!entity) usage();
      await graph.deleteEntity(entity, project);
      console.log(`Deleted entity "${entity}" and its observations/relations.`);
      break;
    }
    case "mute": {
      setNotifyOnWrite(false);
      console.log("Write confirmations muted (set notifyOnWrite:false in ~/.claude-neo4j/config.json). Run `unmute` to re-enable, or set CLAUDE_NEO4J_QUIET=1 for a session-only mute.");
      break;
    }
    case "unmute": {
      setNotifyOnWrite(true);
      console.log(`Write confirmations ${shouldNotifyOnWrite() ? "enabled" : "still muted by CLAUDE_NEO4J_QUIET env var"}.`);
      break;
    }
    default:
      usage();
  }
}

main()
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
