import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "./config.js";
import { topScore, WEAK_SCORE } from "./relevance.js";

/**
 * Access-pattern telemetry for the MCP tools.
 *
 * The graph's write side has always been measurable (`npm run usage` counts
 * what landed). The read side was not: nothing recorded whether memory was
 * ever consulted, so "the plugin is capturing well" could never be turned into
 * "the plugin is helping". This log closes that gap.
 *
 * Every entry is best-effort. A telemetry failure must never turn into a tool
 * failure, so every filesystem call here is swallowed - a missing log is a
 * missing report, not a broken memory_search.
 */

const DEFAULT_LOG_FILE = path.join(CONFIG_DIR, "telemetry.jsonl");

// One line runs ~200 bytes, so this holds roughly 25k tool calls - months of
// use at the observed ~500 sessions/6 weeks. Past it the log rotates once;
// there is deliberately no multi-generation archive, since the report only
// ever reads the live file and stale access patterns aren't worth the disk.
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

const WRITE_TOOLS = new Set([
  "memory_add_observations",
  "memory_create_relation",
  "memory_delete_observations",
  "memory_delete_entity",
  "memory_prune",
]);

/** Tools whose result is a lookup that can legitimately come back empty. */
const SEARCH_TOOLS = new Set(["memory_search", "memory_get_entity", "memory_recent", "memory_timeline"]);

export function telemetryFile() {
  return process.env.CLAUDE_NEO4J_TELEMETRY_FILE ?? DEFAULT_LOG_FILE;
}

export function isDisabled() {
  return process.env.CLAUDE_NEO4J_DISABLE_TELEMETRY === "1";
}

export function toolKind(tool) {
  return WRITE_TOOLS.has(tool) ? "write" : "read";
}

/**
 * How many things came back. The read paths return three different shapes -
 * a bare array, a `{facts|events, total, truncated}` envelope, or one entity
 * object - and the wrapper shouldn't need per-tool configuration to count them.
 *
 * An in-band `{error}` miss counts as zero: `memory_get_entity` reports "no
 * entity named X" as a successful call, and counting that as one hit would
 * hide exactly the misses this log exists to surface.
 */
export function countResults(value) {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "object") return 1;
  for (const key of ["facts", "events", "results", "entities"]) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  if (value.error) return 0;
  return 1;
}

// The miss metric and `graph.searchMemory` must agree on what "weak" means, so
// both read the same calibrated definition rather than each carrying a number.
export { topScore, WEAK_SCORE } from "./relevance.js";

function rotateIfLarge(file) {
  try {
    if (fs.statSync(file).size <= MAX_LOG_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or the rename lost a race: either way, just append.
  }
}

/**
 * Append one entry. `chars` is the size of the payload actually handed to the
 * model - the same number `npm run token-cost` budgets against - so the report
 * can price reads in the units the ceilings are written in.
 */
export function recordToolCall({ tool, project = null, args = null, value = null, chars = 0, ok = true, ms = null, error = null }) {
  if (isDisabled()) return;

  const entry = {
    at: new Date().toISOString(),
    tool,
    kind: toolKind(tool),
    project,
    ok,
    hits: ok ? countResults(value) : 0,
    chars,
  };
  if (ms !== null) entry.ms = ms;
  if (error) entry.error = error.message ?? String(error);
  if (ok) {
    const score = topScore(value);
    if (score !== null) entry.topScore = score;
  }
  // Only lookups carry a query. Write tools would otherwise leak observation
  // text into a second store, which is duplication with no reporting value.
  if (SEARCH_TOOLS.has(tool) && typeof args?.query === "string") entry.query = args.query;

  const file = telemetryFile();
  try {
    rotateIfLarge(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort by design; see the module comment.
  }
}

export function readTelemetry(file = telemetryFile()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn final line from a killed process shouldn't void the report.
    }
  }
  return entries;
}

function bump(map, key, entry) {
  const row = map.get(key) ?? { calls: 0, reads: 0, writes: 0, chars: 0, errors: 0, hits: 0 };
  row.calls += 1;
  row[entry.kind === "write" ? "writes" : "reads"] += 1;
  row.chars += entry.chars ?? 0;
  row.hits += entry.hits ?? 0;
  if (entry.ok === false) row.errors += 1;
  map.set(key, row);
  return row;
}

/**
 * Aggregate raw entries into the numbers the report prints.
 *
 * `zeroHitReads` is scoped to *successful lookups* - a failed call returned
 * nothing because the database was unreachable, which says nothing about
 * whether the graph holds the answer, and folding the two together would make
 * every overnight outage look like a memory gap.
 *
 * `missedReads` is the number to actually read: empty results plus results
 * whose best match was only a fragment (see WEAK_SCORE). The two are kept
 * separate as well, because they have different fixes - nothing recorded
 * versus recorded under words nobody searches for.
 */
export function summarize(entries) {
  const totals = { calls: 0, reads: 0, writes: 0, chars: 0, errors: 0, zeroHitReads: 0, weakReads: 0, missedReads: 0, hitableReads: 0 };
  const byProject = new Map();
  const byTool = new Map();
  const missed = new Map();
  let firstAt = null;
  let lastAt = null;

  for (const entry of entries) {
    totals.calls += 1;
    totals[entry.kind === "write" ? "writes" : "reads"] += 1;
    totals.chars += entry.chars ?? 0;
    if (entry.ok === false) totals.errors += 1;

    if (entry.kind !== "write" && entry.ok !== false && SEARCH_TOOLS.has(entry.tool)) {
      totals.hitableReads += 1;
      const empty = (entry.hits ?? 0) === 0;
      const weak = !empty && typeof entry.topScore === "number" && entry.topScore < WEAK_SCORE;
      if (empty) totals.zeroHitReads += 1;
      if (weak) totals.weakReads += 1;
      if (empty || weak) {
        totals.missedReads += 1;
        if (entry.query) {
          const row = missed.get(entry.query) ?? { query: entry.query, count: 0, project: entry.project, weak: false };
          row.count += 1;
          row.weak = row.weak || weak;
          missed.set(entry.query, row);
        }
      }
    }

    bump(byProject, entry.project ?? "(unknown)", entry);
    bump(byTool, entry.tool, entry);
    if (entry.at) {
      if (!firstAt || entry.at < firstAt) firstAt = entry.at;
      if (!lastAt || entry.at > lastAt) lastAt = entry.at;
    }
  }

  return {
    totals,
    firstAt,
    lastAt,
    projects: [...byProject.entries()]
      .map(([project, row]) => ({ project, ...row }))
      .sort((a, b) => b.calls - a.calls),
    tools: [...byTool.entries()]
      .map(([tool, row]) => ({ tool, ...row }))
      .sort((a, b) => b.calls - a.calls),
    missedQueries: [...missed.values()].sort((a, b) => b.count - a.count || a.query.localeCompare(b.query)),
  };
}
