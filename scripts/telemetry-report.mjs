#!/usr/bin/env node
// Reports how the memory graph is actually *used*, as opposed to what it holds.
//
// `npm run usage` counts what landed in the graph and `npm run token-cost`
// prices what a read would cost. Neither could say whether memory was ever
// consulted, which left "is this helping?" unanswerable from data. This reads
// ~/.claude-neo4j/telemetry.jsonl, written by the MCP tool wrapper, and answers
// it in three numbers: how often reads happen, how often they come back empty,
// and the read:write ratio per project.
//
// Usage:
//   node scripts/telemetry-report.mjs             all recorded history
//   node scripts/telemetry-report.mjs --days 7    only the last 7 days
//   node scripts/telemetry-report.mjs --json      machine-readable
//   node scripts/telemetry-report.mjs --file PATH read a specific log
import { readTelemetry, summarize, telemetryFile, WEAK_SCORE } from "../src/lib/telemetry.js";

function parseArgs(argv) {
  const flags = { days: null, json: false, file: null, misses: 15 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") flags.days = Number(argv[++i]);
    else if (argv[i] === "--json") flags.json = true;
    else if (argv[i] === "--file") flags.file = argv[++i];
    else if (argv[i] === "--misses") flags.misses = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  if (flags.days !== null && !Number.isFinite(flags.days)) {
    console.error("--days needs a number");
    process.exit(1);
  }
  return flags;
}

const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
const num = (n) => n.toLocaleString("en-US");

function ratio(reads, writes) {
  if (writes === 0) return reads === 0 ? "—" : `${reads}:0`;
  return `${(reads / writes).toFixed(1)}:1`;
}

function pad(value, width, right = false) {
  const s = String(value);
  return right ? s.padStart(width) : s.padEnd(width);
}

function table(rows, columns) {
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i], columns[i].right)).join("  ").trimEnd();
  console.log(`  ${line(columns.map((c) => c.header))}`);
  for (const row of rows) console.log(`  ${line(columns.map((c) => c.get(row)))}`);
}

const flags = parseArgs(process.argv.slice(2));
const file = flags.file ?? telemetryFile();
let entries = readTelemetry(file);

if (entries.length === 0) {
  console.log(`No telemetry recorded yet (${file}).`);
  console.log("It fills up as MCP memory tools are called; set CLAUDE_NEO4J_DISABLE_TELEMETRY=1 to opt out.");
  process.exit(0);
}

if (flags.days !== null) {
  const cutoff = new Date(Date.now() - flags.days * 86_400_000).toISOString();
  entries = entries.filter((e) => (e.at ?? "") >= cutoff);
  if (entries.length === 0) {
    console.log(`No memory tool calls in the last ${flags.days} day(s).`);
    process.exit(0);
  }
}

const s = summarize(entries);

if (flags.json) {
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

const window = flags.days !== null ? `last ${flags.days} day(s)` : `${s.firstAt?.slice(0, 10)} → ${s.lastAt?.slice(0, 10)}`;
console.log(`\nMemory access patterns (${window})\n`);

console.log(
  `  ${num(s.totals.calls)} calls: ${num(s.totals.reads)} read, ${num(s.totals.writes)} write ` +
    `(${ratio(s.totals.reads, s.totals.writes)})`
);
console.log(`  ${num(s.totals.chars)} chars served (~${num(Math.round(s.totals.chars / 4))} tokens)`);
console.log(
  `  ${num(s.totals.missedReads)}/${num(s.totals.hitableReads)} lookups missed (${pct(s.totals.missedReads, s.totals.hitableReads)}) ` +
    `— ${num(s.totals.zeroHitReads)} empty, ${num(s.totals.weakReads)} weak (best match scored < ${WEAK_SCORE})`
);
if (s.totals.errors) console.log(`  ${num(s.totals.errors)} call(s) failed`);

console.log("\nPer project\n");
table(s.projects, [
  { header: "PROJECT", get: (r) => r.project },
  { header: "READS", right: true, get: (r) => num(r.reads) },
  { header: "WRITES", right: true, get: (r) => num(r.writes) },
  { header: "R:W", right: true, get: (r) => ratio(r.reads, r.writes) },
  { header: "CHARS", right: true, get: (r) => num(r.chars) },
]);

console.log("\nPer tool\n");
table(s.tools, [
  { header: "TOOL", get: (r) => r.tool },
  { header: "CALLS", right: true, get: (r) => num(r.calls) },
  { header: "CHARS", right: true, get: (r) => num(r.chars) },
  { header: "AVG", right: true, get: (r) => num(Math.round(r.chars / r.calls)) },
  { header: "ERR", right: true, get: (r) => num(r.errors) },
]);

if (s.missedQueries.length) {
  const shown = s.missedQueries.slice(0, flags.misses);
  console.log(`\nSearches that missed (${s.missedQueries.length} distinct) — candidates for what the graph is missing\n`);
  table(shown, [
    { header: "QUERY", get: (r) => (r.query.length > 60 ? `${r.query.slice(0, 57)}...` : r.query) },
    { header: "TIMES", right: true, get: (r) => num(r.count) },
    { header: "RESULT", get: (r) => (r.weak ? "weak match" : "empty") },
    { header: "PROJECT", get: (r) => r.project ?? "(unknown)" },
  ]);
  if (s.missedQueries.length > shown.length) {
    console.log(`\n  ...and ${s.missedQueries.length - shown.length} more (--misses N to show more).`);
  }
}

// A project that only ever writes is memory being filed and never consulted -
// the failure mode the graph's own counts cannot show.
const writeOnly = s.projects.filter((p) => p.writes > 0 && p.reads === 0);
if (writeOnly.length) {
  console.log("\nWrite-only projects (memory recorded but never read back):");
  for (const p of writeOnly) console.log(`  ${p.project}: ${num(p.writes)} write(s), 0 reads`);
}

console.log("");
