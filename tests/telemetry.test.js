import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recordToolCall, readTelemetry, countResults, topScore, summarize, MAX_LOG_BYTES, WEAK_SCORE } from "../src/lib/telemetry.js";

let dir;
let logFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn4j-telemetry-"));
  logFile = path.join(dir, "telemetry.jsonl");
  process.env.CLAUDE_NEO4J_TELEMETRY_FILE = logFile;
  delete process.env.CLAUDE_NEO4J_DISABLE_TELEMETRY;
});

afterEach(() => {
  delete process.env.CLAUDE_NEO4J_TELEMETRY_FILE;
  delete process.env.CLAUDE_NEO4J_DISABLE_TELEMETRY;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("countResults", () => {
  test("counts arrays, keyed payloads, single objects and misses", () => {
    assert.equal(countResults([1, 2, 3]), 3);
    assert.equal(countResults({ events: [1, 2], total: 9 }), 2);
    assert.equal(countResults({ facts: [1], total: 1 }), 1);
    assert.equal(countResults({ name: "user" }), 1);
    assert.equal(countResults(null), 0);
    assert.equal(countResults(undefined), 0);
    // A miss reported in-band still counts as zero hits, not one object.
    assert.equal(countResults({ error: 'no entity named "nope"' }), 0);
  });
});

describe("topScore", () => {
  test("takes the best relevance score when the payload carries one", () => {
    assert.equal(topScore([{ score: 1.2 }, { score: 4.8 }, { score: 0.3 }]), 4.8);
    assert.equal(topScore([{ name: "a" }]), null, "no score field means unscored, not zero");
    assert.equal(topScore([]), null);
    assert.equal(topScore({ events: [] }), null);
    assert.equal(topScore(null), null);
  });
});

describe("recordToolCall", () => {
  test("writes one JSONL entry per call with the fields the report needs", () => {
    recordToolCall({
      tool: "memory_search",
      project: "github.com/troglodyte/claude-neo4j-mem",
      args: { query: "podman" },
      value: [{ name: "a" }, { name: "b" }],
      chars: 412,
      ok: true,
      ms: 17,
    });

    const entries = readTelemetry(logFile);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.tool, "memory_search");
    assert.equal(e.kind, "read");
    assert.equal(e.project, "github.com/troglodyte/claude-neo4j-mem");
    assert.equal(e.hits, 2);
    assert.equal(e.chars, 412);
    assert.equal(e.ok, true);
    assert.equal(e.ms, 17);
    assert.equal(e.query, "podman");
    assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("records the top relevance score so weak matches stay distinguishable", () => {
    recordToolCall({ tool: "memory_search", project: "p", args: { query: "x" }, value: [{ score: 1.61 }], chars: 100, ok: true });
    const [e] = readTelemetry(logFile);
    assert.equal(e.topScore, 1.61);
  });

  test("tags write tools as writes and records no query", () => {
    recordToolCall({ tool: "memory_add_observations", project: "p", args: { entity: "user" }, value: { added: 3 }, chars: 90, ok: true });
    const [e] = readTelemetry(logFile);
    assert.equal(e.kind, "write");
    assert.equal(e.query, undefined);
  });

  test("records failures without a hit count", () => {
    recordToolCall({ tool: "memory_search", project: "p", args: { query: "x" }, error: new Error("boom"), chars: 30, ok: false });
    const [e] = readTelemetry(logFile);
    assert.equal(e.ok, false);
    assert.equal(e.hits, 0);
    assert.equal(e.error, "boom");
  });

  test("is silent when opted out", () => {
    process.env.CLAUDE_NEO4J_DISABLE_TELEMETRY = "1";
    recordToolCall({ tool: "memory_search", project: "p", args: { query: "x" }, value: [1], chars: 10, ok: true });
    assert.equal(fs.existsSync(logFile), false);
  });

  test("never throws when the log cannot be written", () => {
    // A directory where the file should be: every write fails, the tool must not.
    fs.mkdirSync(logFile);
    assert.doesNotThrow(() =>
      recordToolCall({ tool: "memory_search", project: "p", args: { query: "x" }, value: [1], chars: 10, ok: true })
    );
  });

  test("rotates rather than growing without bound", () => {
    fs.writeFileSync(logFile, "x".repeat(MAX_LOG_BYTES + 1));
    recordToolCall({ tool: "memory_recent", project: "p", value: [1], chars: 10, ok: true });

    assert.ok(fs.existsSync(`${logFile}.1`), "previous log kept as .1");
    const entries = readTelemetry(logFile);
    assert.equal(entries.length, 1, "live log restarted with just the new entry");
  });
});

describe("readTelemetry", () => {
  test("returns empty for a missing file and skips corrupt lines", () => {
    assert.deepEqual(readTelemetry(path.join(dir, "nope.jsonl")), []);
    fs.writeFileSync(logFile, `{"tool":"memory_recent","kind":"read"}\nnot json\n\n{"tool":"memory_search","kind":"read"}\n`);
    assert.equal(readTelemetry(logFile).length, 2);
  });
});

describe("summarize", () => {
  const entries = [
    { at: "2026-08-01T10:00:00.000Z", tool: "memory_search", kind: "read", project: "a", hits: 0, chars: 100, ok: true, query: "podman volumes" },
    { at: "2026-08-01T11:00:00.000Z", tool: "memory_search", kind: "read", project: "a", hits: 4, chars: 900, ok: true, query: "engine" },
    { at: "2026-08-02T10:00:00.000Z", tool: "memory_recent", kind: "read", project: "a", hits: 15, chars: 6000, ok: true },
    { at: "2026-08-02T10:05:00.000Z", tool: "memory_add_observations", kind: "write", project: "a", hits: 1, chars: 90, ok: true },
    { at: "2026-08-02T10:06:00.000Z", tool: "memory_add_observations", kind: "write", project: "b", hits: 1, chars: 90, ok: true },
    { at: "2026-08-02T10:07:00.000Z", tool: "memory_search", kind: "read", project: "b", hits: 0, chars: 40, ok: false, error: "boom" },
  ];

  test("totals reads, writes and characters served", () => {
    const s = summarize(entries);
    assert.equal(s.totals.calls, 6);
    assert.equal(s.totals.reads, 4);
    assert.equal(s.totals.writes, 2);
    assert.equal(s.totals.chars, 7220);
    assert.equal(s.totals.errors, 1);
  });

  test("reports read:write ratio per project so write-only memory is visible", () => {
    const s = summarize(entries);
    const a = s.projects.find((p) => p.project === "a");
    const b = s.projects.find((p) => p.project === "b");
    assert.equal(a.reads, 3);
    assert.equal(a.writes, 1);
    assert.equal(b.reads, 1);
    assert.equal(b.writes, 1);
  });

  test("zero-hit rate counts only successful reads that could have hit", () => {
    const s = summarize(entries);
    // 3 successful reads with a hit count; one of them returned nothing.
    assert.equal(s.totals.zeroHitReads, 1);
    assert.equal(s.totals.hitableReads, 3);
  });

  test("surfaces the queries that found nothing", () => {
    const s = summarize(entries);
    assert.deepEqual(
      s.missedQueries.map((q) => q.query),
      ["podman volumes"]
    );
  });

  test("counts a hit that only matched a fragment as a weak read, not a success", () => {
    // Lucene tokenizes on hyphens, so a junk query can match one common token
    // and come back with a single low-scoring row. Counting that as a hit is
    // how a zero-hit rate ends up flattering the graph.
    const weak = [
      ...entries,
      { at: "2026-08-02T12:00:00.000Z", tool: "memory_search", kind: "read", project: "a", hits: 1, topScore: 1.61, chars: 200, ok: true, query: "zzz-nonexistent-term-qqq" },
      { at: "2026-08-02T12:01:00.000Z", tool: "memory_search", kind: "read", project: "a", hits: 6, topScore: 4.8, chars: 900, ok: true, query: "engine resolution" },
    ];
    const s = summarize(weak);
    assert.equal(s.totals.weakReads, 1);
    assert.equal(s.totals.zeroHitReads, 1, "the weak match is not also counted as empty");
    assert.equal(s.totals.missedReads, 2, "empty plus weak is the honest miss count");
    assert.ok(
      s.missedQueries.some((q) => q.query === "zzz-nonexistent-term-qqq" && q.weak),
      "weak matches are listed as candidate gaps, flagged as weak"
    );
    assert.ok(WEAK_SCORE > 1.61 && WEAK_SCORE < 3.35, "threshold sits between fragment noise and real relevance");
  });

  test("breaks calls down per tool", () => {
    const s = summarize(entries);
    const search = s.tools.find((t) => t.tool === "memory_search");
    assert.equal(search.calls, 3);
    assert.equal(search.chars, 1040);
  });
});
