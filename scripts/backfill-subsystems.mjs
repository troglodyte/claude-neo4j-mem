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
//   node scripts/backfill-subsystems.mjs --retag TAG     reclassify an existing tag
import { withSession, closeDriver } from "../src/lib/neo4jClient.js";
import { ensureSchema } from "../src/lib/schema.js";
import { listSubsystems } from "../src/lib/graph.js";
import { extractStructured } from "../src/lib/extract.js";
import { resolveSubsystem, filterVocabulary } from "../src/lib/subsystem.js";

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
        // `subsystem` is deliberately NOT required: a cross-cutting fact has
        // none, and a mandatory field leaves the model no way to say so except
        // by inventing a junk-drawer tag - which is exactly what happened.
        properties: { id: { type: "string" }, subsystem: { type: "string" } },
        required: ["id"],
      },
    },
  },
  required: ["assignments"],
};

function parseArgs(argv) {
  const flags = { project: null, dryRun: false, retag: null };
  // --project and --retag both require a value; reject a missing one rather
  // than swallowing the next flag. For --project this prevents silent scope
  // escalation to "every project"; for --retag it prevents selecting nothing.
  const requireValue = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
      console.error(`Error: ${name} requires a value`);
      process.exit(1);
    }
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") {
      requireValue(i, "--project");
      flags.project = argv[++i];
    } else if (argv[i] === "--retag") {
      requireValue(i, "--retag");
      flags.retag = argv[++i];
    } else if (argv[i] === "--dry-run") flags.dryRun = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "Usage: node scripts/backfill-subsystems.mjs [--project NAME] [--retag TAG] [--dry-run]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return flags;
}

// Selects untagged observations by default, so the script is idempotent and a
// re-run after an interruption picks up exactly what is left. `--retag TAG`
// instead reclassifies observations already carrying TAG, which is how a junk
// drawer created by an earlier run gets emptied - without it the only way to
// revisit a bad tag is to clear it by hand first.
async function pendingEntities(project, retag) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE ($project IS NULL OR e.project = $project)
         AND (($retag IS NULL AND o.subsystem IS NULL) OR o.subsystem = $retag)
       WITH e, collect({id: o.id, text: o.text}) AS observations
       RETURN e.name AS name, e.type AS type, e.project AS project, observations,
              size(observations) AS pending
       ORDER BY pending DESC`,
      { project: project ?? null, retag: retag ?? null }
    );
    // toObject() leaves `pending` as a Neo4j Integer (size() is a Cypher
    // integer), not a plain number - its valueOf() returns a BigInt, so
    // `sum + e.pending` below throws "Cannot mix BigInt and other types"
    // against real data. Converted here, once, at the query boundary.
    return result.records.map((r) => ({ ...r.toObject(), pending: r.get("pending").toNumber() }));
  });
}

// A row's subsystem may be null, meaning "cross-cutting, no tag". Neo4j removes
// a property set to null, which is what makes `--retag general` able to clear
// the junk drawer rather than merely relabel it.
async function writeTags(rows) {
  return withSession(async (session) => {
    // Deduplicate by id (last assignment wins) so count(o) reports distinct
    // observations touched, not inflated counts from duplicate ids.
    const deduplicated = Array.from(new Map(rows.map((r) => [r.id, r])).values());
    const result = await session.run(
      `UNWIND $rows AS row
       MATCH (o:Observation {id: row.id})
       SET o.subsystem = row.subsystem
       RETURN count(o) AS updated`,
      { rows: deduplicated }
    );
    return result.records[0]?.get("updated").toNumber() ?? 0;
  });
}

function buildPrompt(entity, vocabulary) {
  let prompt = `You are labelling stored memory observations with the subsystem each one belongs to.
All of these observations are attached to the entity "${entity.name}"${entity.type ? ` (type: ${entity.type})` : ""} in project "${entity.project}".
A subsystem is a short lowercase kebab-case area of the codebase or product, e.g. "auto-capture", "search", "backup", "gui", "save-format".
Return one assignment per observation id you were given. Judge each observation on its own merits - one entity's observations routinely span several subsystems.
Omit the subsystem field entirely for a fact that is genuinely cross-cutting, such as a user preference or a project-wide constraint. Do not invent a catch-all tag like "general", "misc" or "other" - omitting the field is how you say a fact belongs to no single subsystem, and an observation you are merely unsure about should still get your best specific guess.`;
  if (vocabulary.length) {
    prompt +=
      `\n\nThese tags are already in use for this project. Prefer one of them; invent a new tag only when ` +
      `none genuinely fits:\n${vocabulary.map((s) => `- ${s}`).join("\n")}`;
  }
  return prompt;
}

async function main() {
  const { project, dryRun, retag } = parseArgs(process.argv.slice(2));
  await ensureSchema();

  const entities = await pendingEntities(project, retag);
  if (!entities.length) {
    console.log(
      retag
        ? `Nothing to do - no observations carry the subsystem "${retag}".`
        : "Nothing to do - every observation already has a subsystem."
    );
    return;
  }

  const pending = entities.reduce((sum, e) => sum + e.pending, 0);
  const what = retag ? `observations tagged "${retag}"` : "untagged observations";
  console.log(`${entities.length} entities, ${pending} ${what}${dryRun ? " (dry run)" : ""}\n`);

  // Vocabulary accumulates per project across the run, so an entity processed
  // late converges on the tags the big entities established early.
  const vocabularies = new Map();
  let tagged = 0;
  let crossCutting = 0;

  for (const entity of entities) {
    if (!vocabularies.has(entity.project)) {
      vocabularies.set(
        entity.project,
        filterVocabulary((await listSubsystems(entity.project)).map((s) => s.subsystem))
      );
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
        // null means "cross-cutting, no subsystem" - either the model omitted
        // the field or it reached for a catch-all and resolveSubsystem folded
        // that back to the same thing. It is written, not skipped, so a
        // --retag run clears the old tag instead of leaving it in place.
        const slug = resolveSubsystem(assignment.subsystem, vocabulary);
        if (slug && !vocabulary.includes(slug)) vocabulary.push(slug);
        rows.push({ id: assignment.id, subsystem: slug });
      }

      const counts = rows.reduce(
        (acc, r) => ({ ...acc, [r.subsystem ?? "(cross-cutting)"]: (acc[r.subsystem ?? "(cross-cutting)"] ?? 0) + 1 }),
        {}
      );
      const summary = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s} ${n}`)
        .join(", ");
      console.log(`  ${entity.name} [${batch.length}] → ${summary || "(nothing assigned)"}`);

      crossCutting += rows.filter((r) => r.subsystem === null).length;
      // Written per batch, not at the end, so an interrupted run keeps its work.
      if (!dryRun && rows.length) tagged += await writeTags(rows);
    }
  }

  const touched = dryRun ? pending : tagged;
  console.log(
    `\n${dryRun ? "Would update" : "Updated"} ${touched} observation(s)` +
      (crossCutting ? `, ${crossCutting} of them cross-cutting (subsystem cleared).` : ".")
  );
}

main()
  .catch((error) => {
    console.error(`backfill-subsystems: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(closeDriver);
