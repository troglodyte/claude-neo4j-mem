#!/usr/bin/env node
// One-off: assigns Observation.subsystem to observations captured before
// subsystem tagging existed. Without it the SessionStart map reads "(untagged)"
// for everything and the feature it was built for does nothing on day one.
//
// Entities are processed largest-first on purpose: the junk drawers hold the
// most observations and therefore establish the vocabulary that every smaller
// entity then reuses, which is what stops the map fragmenting.
//
// Usage:
//   node scripts/backfill-subsystems.mjs                 every project
//   node scripts/backfill-subsystems.mjs --project NAME  one project
//   node scripts/backfill-subsystems.mjs --dry-run       classify, don't write
import { withSession, closeDriver } from "../src/lib/neo4jClient.js";
import { ensureSchema } from "../src/lib/schema.js";
import { listSubsystems } from "../src/lib/graph.js";
import { extractStructured } from "../src/lib/extract.js";
import { resolveSubsystem } from "../src/lib/subsystem.js";

// One entity's observations can run to hundreds; batching keeps each prompt
// well inside a sensible input size and makes the run resumable at batch
// granularity rather than entity granularity.
const BATCH_SIZE = 40;
// Classification needs the gist, not the whole observation - the longest live
// observations run to ~4k chars and reading them in full would cost far more
// than the tag is worth.
const CLASSIFY_TEXT_CHARS = 400;
const TIMEOUT_MS = 180_000;

const SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, subsystem: { type: "string" } },
        required: ["id", "subsystem"],
      },
    },
  },
  required: ["assignments"],
};

function parseArgs(argv) {
  const flags = { project: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") flags.project = argv[++i];
    else if (argv[i] === "--dry-run") flags.dryRun = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/backfill-subsystems.mjs [--project NAME] [--dry-run]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return flags;
}

// Only ever selects untagged observations, so the script is idempotent and a
// re-run after an interruption picks up exactly what is left.
async function untaggedEntities(project) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE ($project IS NULL OR e.project = $project) AND o.subsystem IS NULL
       WITH e, collect({id: o.id, text: o.text}) AS observations
       RETURN e.name AS name, e.type AS type, e.project AS project, observations,
              size(observations) AS pending
       ORDER BY pending DESC`,
      { project: project ?? null }
    );
    // toObject() leaves `pending` as a Neo4j Integer (size() is a Cypher
    // integer), not a plain number - its valueOf() returns a BigInt, so
    // `sum + e.pending` below throws "Cannot mix BigInt and other types"
    // against real data. Converted here, once, at the query boundary.
    return result.records.map((r) => ({ ...r.toObject(), pending: r.get("pending").toNumber() }));
  });
}

async function writeTags(rows) {
  return withSession(async (session) => {
    const result = await session.run(
      `UNWIND $rows AS row
       MATCH (o:Observation {id: row.id})
       SET o.subsystem = row.subsystem
       RETURN count(o) AS updated`,
      { rows }
    );
    return result.records[0]?.get("updated").toNumber() ?? 0;
  });
}

function buildPrompt(entity, vocabulary) {
  let prompt = `You are labelling stored memory observations with the subsystem each one belongs to.
All of these observations are attached to the entity "${entity.name}"${entity.type ? ` (type: ${entity.type})` : ""} in project "${entity.project}".
A subsystem is a short lowercase kebab-case area of the codebase or product, e.g. "auto-capture", "search", "backup", "gui", "save-format".
Return one assignment per observation id you were given. Judge each observation on its own merits - one entity's observations routinely span several subsystems.
For a fact that is genuinely cross-cutting (a user preference, a project-wide constraint), use the subsystem "general".`;
  if (vocabulary.length) {
    prompt +=
      `\n\nThese tags are already in use for this project. Prefer one of them; invent a new tag only when ` +
      `none genuinely fits:\n${vocabulary.map((s) => `- ${s}`).join("\n")}`;
  }
  return prompt;
}

async function main() {
  const { project, dryRun } = parseArgs(process.argv.slice(2));
  await ensureSchema();

  const entities = await untaggedEntities(project);
  if (!entities.length) {
    console.log("Nothing to do - every observation already has a subsystem.");
    return;
  }

  const pending = entities.reduce((sum, e) => sum + e.pending, 0);
  console.log(`${entities.length} entities, ${pending} untagged observations${dryRun ? " (dry run)" : ""}\n`);

  // Vocabulary accumulates per project across the run, so an entity processed
  // late converges on the tags the big entities established early.
  const vocabularies = new Map();
  let tagged = 0;

  for (const entity of entities) {
    if (!vocabularies.has(entity.project)) {
      vocabularies.set(entity.project, (await listSubsystems(entity.project)).map((s) => s.subsystem));
    }
    const vocabulary = vocabularies.get(entity.project);

    for (let start = 0; start < entity.observations.length; start += BATCH_SIZE) {
      const batch = entity.observations.slice(start, start + BATCH_SIZE);
      const input = batch
        .map((o) => `${o.id}\n${o.text.slice(0, CLASSIFY_TEXT_CHARS)}`)
        .join("\n\n---\n\n");

      let assignments;
      try {
        const structured = await extractStructured({
          input,
          systemPrompt: buildPrompt(entity, vocabulary),
          schema: SCHEMA,
          timeoutMs: TIMEOUT_MS,
        });
        assignments = structured.assignments ?? [];
      } catch (error) {
        console.error(`  ! ${entity.name}: ${error.message} - skipping this batch, re-run to retry`);
        continue;
      }

      const known = new Set(batch.map((o) => o.id));
      const rows = [];
      for (const assignment of assignments) {
        if (!known.has(assignment.id)) continue; // ignore hallucinated ids
        const slug = resolveSubsystem(assignment.subsystem, vocabulary);
        if (!slug) continue;
        if (!vocabulary.includes(slug)) vocabulary.push(slug);
        rows.push({ id: assignment.id, subsystem: slug });
      }

      const counts = rows.reduce((acc, r) => ({ ...acc, [r.subsystem]: (acc[r.subsystem] ?? 0) + 1 }), {});
      const summary = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s} ${n}`)
        .join(", ");
      console.log(`  ${entity.name} [${batch.length}] → ${summary || "(nothing assigned)"}`);

      // Written per batch, not at the end, so an interrupted run keeps its work.
      if (!dryRun && rows.length) tagged += await writeTags(rows);
    }
  }

  console.log(`\n${dryRun ? "Would tag" : "Tagged"} ${dryRun ? pending : tagged} observation(s).`);
}

main()
  .catch((error) => {
    console.error(`backfill-subsystems: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(closeDriver);
