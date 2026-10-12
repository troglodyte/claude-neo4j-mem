#!/usr/bin/env node
// Is memory_search returning more than it needs to, or less? Read-only; two parts.
//
//   node scripts/search-payload-review.mjs              both parts
//   node scripts/search-payload-review.mjs --followups  telemetry only (no Neo4j needed)
//   node scripts/search-payload-review.mjs --replay     replay only
//
// Part 1 replays every logged search against the live graph and measures what a
// compact result (fewer observations per entity) or fewer entities would remove.
// Part 2 reads telemetry.jsonl and ranks each memory_get_entity lookup against the
// entities the preceding search showed. How to read both, and when they justify
// changing the defaults: docs/search-payload-review.md.
import { readTelemetry } from "../src/lib/telemetry.js";

const FOLLOWUP_WINDOW_MS = 10 * 60 * 1000;
const pct = (a, b) => (b === 0 ? "n/a" : `${Math.round((100 * a) / b)}%`);
const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const size = (x) => JSON.stringify(x).length;

function followups(entries) {
  const searches = entries.filter((e) => e.tool === "memory_search" && e.ok && Array.isArray(e.shown));
  const lookups = entries.filter((e) => e.tool === "memory_get_entity" && e.entity);
  const rank = { "1-3": 0, "4-10": 0, "not shown": 0 };
  let followed = 0;
  for (const lookup of lookups) {
    const at = Date.parse(lookup.at);
    const prior = searches
      .filter((s) => s.project === lookup.project && Date.parse(s.at) <= at && at - Date.parse(s.at) <= FOLLOWUP_WINDOW_MS)
      .at(-1);
    if (!prior) {
      continue;
    }
    followed++;
    const i = prior.shown.indexOf(lookup.entity);
    rank[i < 0 ? "not shown" : i < 3 ? "1-3" : "4-10"]++;
  }
  console.log("\nFollow-ups (memory_get_entity within 10 min of a search, same project)");
  console.log(`  searches with a shown list: ${searches.length}`);
  console.log(`  lookups that followed one:  ${followed}  (${pct(followed, searches.length)} of searches)`);
  console.log(`  followed entity's rank:     ${JSON.stringify(rank)}`);
  if (searches.length < 30 || followed < 20) {
    console.log("  -> too little data to act on; recheck once both counts are larger.");
  }
}

async function replay(entries) {
  const { searchMemory } = await import("../src/lib/graph.js");
  const queries = entries.filter((e) => e.tool === "memory_search" && e.ok && e.query);
  const byRank = [0, 0, 0];
  const total = { chars: 0, obs: 0, obsMatching: 0, obs3to5: 0, obs3to5Matching: 0, compactChars: 0, entities: 0, runs: 0 };
  const flat = { "ge0.7": 0, "0.5-0.7": 0, "lt0.5": 0 };
  for (const q of queries) {
    const out = await searchMemory(q.query, 10, q.project).catch(() => null);
    if (!out || out.results.length === 0) {
      continue;
    }
    total.runs++;
    const qw = words(q.query);
    const top = out.results[0].score || 1;
    out.results.forEach((r, i) => {
      total.chars += size(r);
      total.entities++;
      byRank[i < 3 ? 0 : i < 6 ? 1 : 2] += size(r);
      total.compactChars += size({ ...r, observations: r.observations.slice(0, 2), relations: r.relations.slice(0, 3) });
      const ratio = r.score / top;
      if (i > 0) {
        flat[ratio >= 0.7 ? "ge0.7" : ratio >= 0.5 ? "0.5-0.7" : "lt0.5"]++;
      }
      r.observations.forEach((o, j) => {
        const match = [...words(o.text)].some((w) => qw.has(w));
        total.obs++;
        total.obsMatching += match ? 1 : 0;
        total.obs3to5 += j >= 2 ? 1 : 0;
        total.obs3to5Matching += j >= 2 && match ? 1 : 0;
      });
    });
  }
  console.log(`Replay of ${total.runs} logged searches`);
  console.log(`  avg result: ${Math.round(total.chars / total.runs)} chars, ${(total.entities / total.runs).toFixed(1)} entities`);
  console.log(`  chars by entity rank 1-3 / 4-6 / 7-10: ${byRank.map((c) => pct(c, total.chars)).join(" / ")}`);
  console.log(`  score of ranks 2+ relative to the top (flat = no clean cut): ${JSON.stringify(flat)}`);
  console.log(`  observations containing a query word: ${pct(total.obsMatching, total.obs)} (3rd-5th only: ${pct(total.obs3to5Matching, total.obs3to5)})`);
  console.log(`  compact (2 obs, 3 relations) would save: ${pct(total.chars - total.compactChars, total.chars)}`);
}

const args = new Set(process.argv.slice(2));
const entries = readTelemetry();
if (!args.has("--followups")) {
  await replay(entries);
}
if (!args.has("--replay")) {
  followups(entries);
}
process.exit(0);
