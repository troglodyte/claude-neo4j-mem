#!/usr/bin/env node
// Measures what each read path puts into a model's context, and fails if any
// exceeds its ceiling. Payload size drives token spend, and none of these paths
// bound it by row count alone - a project whose observations are 5x longer than
// average pays 5x at every one. This catches that before a user does.
//
// Usage:
//   node scripts/token-cost.mjs                 measure the current project
//   node scripts/token-cost.mjs --project NAME  measure a specific project
//   node scripts/token-cost.mjs --all           measure every project in the db
import * as graph from "../src/lib/graph.js";
import { detectProject } from "../src/lib/project.js";
import { closeDriver } from "../src/lib/neo4jClient.js";
import { ensureSchema } from "../src/lib/schema.js";

// Ceilings are per single call, in characters. ~4 chars/token, so the timeline
// ceiling is roughly 10k tokens - large, but a bounded, predictable large.
const CEILINGS = {
  "SessionStart injection": 14_000,
  memory_search: 26_000,
  memory_recent: 14_000,
  memory_get_entity: 42_000,
  memory_timeline: 42_000,
  memory_list_projects: 8_000,
};

const chars = (value) => JSON.stringify(value ?? null).length;

function parseArgs(argv) {
  const flags = { project: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") flags.project = argv[++i];
    else if (argv[i] === "--all") flags.all = true;
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return flags;
}

// The largest entity is the worst case for get_entity, and a term drawn from
// real observation text is the worst realistic case for search - measuring with
// a term that matches nothing would report a reassuring zero.
async function probesFor(project) {
  const recent = await graph.getRecentContext({ project, limit: 15 });
  const biggest = recent[0]?.name ?? "user";
  const searchTerm = recent[0]?.observations?.[0]?.split(/\s+/).find((w) => w.length > 5) ?? "the";
  return { biggest, searchTerm };
}

async function measure(project) {
  const { biggest, searchTerm } = await probesFor(project);
  const results = [];

  const recent = await graph.getRecentContext({ project, limit: 15 });
  // Mirrors how session-start.js renders the same data into the prompt.
  const injection = recent
    .map((r) => `- ${r.name}${r.type ? ` (${r.type})` : ""}\n${r.observations.map((o) => `  - ${o}`).join("\n")}`)
    .join("\n");
  results.push(["SessionStart injection", injection.length, "per session, always"]);
  results.push(["memory_search", chars(await graph.searchMemory(searchTerm, 10, project)), `query "${searchTerm}"`]);
  results.push(["memory_recent", chars(recent), "limit 15"]);
  results.push(["memory_get_entity", chars(await graph.getEntity(biggest, project)), `"${biggest}"`]);
  results.push(["memory_timeline", chars(await graph.getTimeline({ project })), "default limit"]);
  results.push(["memory_list_projects", chars(await graph.listProjects()), "all projects"]);
  return results;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  await ensureSchema();

  const projects = flags.all
    ? (await graph.listProjects()).map((p) => p.project)
    : [flags.project ?? detectProject(process.cwd())];

  let failures = 0;
  for (const project of projects) {
    console.log(`\n${project}`);
    console.log("  " + "PATH".padEnd(24) + "CHARS".padStart(9) + "~TOKENS".padStart(9) + "  STATUS  NOTE");
    for (const [name, size, note] of await measure(project)) {
      const ceiling = CEILINGS[name] ?? Infinity;
      const over = size > ceiling;
      if (over) failures++;
      console.log(
        "  " +
          name.padEnd(24) +
          String(size).padStart(9) +
          String(Math.round(size / 4)).padStart(9) +
          `  ${over ? `OVER (>${ceiling})` : "ok"}`.padEnd(9) +
          `  ${note}`
      );
    }
  }

  console.log(
    failures === 0
      ? "\nAll read paths within their per-call ceilings."
      : `\n${failures} read path(s) over ceiling - see src/lib/budget.js.`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
