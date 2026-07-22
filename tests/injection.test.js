import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInjection } from "../src/lib/injection.js";

const PROJECT = "github.com/troglodyte/claude-neo4j-mem";

const PINNED = {
  facts: [
    { text: "bound every read path by characters, not row count" },
    { text: "wants write confirmations visible in-band" },
  ],
  total: 2,
  returned: 2,
  truncated: false,
};

const MAP = [
  { subsystem: "capture", observations: 34, entities: 5, lastSeen: "2026-07-21T09:00:00Z" },
  { subsystem: "backup", observations: 21, entities: 3, lastSeen: "2026-07-20T09:00:00Z" },
  { subsystem: "(untagged)", observations: 126, entities: 19, lastSeen: "2026-07-19T09:00:00Z" },
];

test("renderInjection quotes pinned facts and indexes everything else", () => {
  const out = renderInjection({ project: PROJECT, pinned: PINNED, map: MAP });

  assert.ok(out.includes(PROJECT), "names the project it is scoped to");
  assert.ok(out.includes("bound every read path by characters"), "pinned facts appear verbatim");
  assert.ok(out.includes("capture (34, 07-21)"), "each tag carries its count and short date");
  assert.ok(out.includes("(untagged) (126"), "the untagged bucket is shown, not hidden");
  assert.ok(out.includes("memory_search"), "tells the model how to follow the index");
  assert.ok(!out.includes("memory_get_entity"), "no tool enumeration - MCP already registers those");
});

test("renderInjection stays inside its budget on realistic input", () => {
  const out = renderInjection({ project: PROJECT, pinned: PINNED, map: MAP });
  assert.ok(out.length < 6_000, `injection was ${out.length} chars`);
});

test("renderInjection says so when standing facts were dropped", () => {
  const clipped = { ...PINNED, total: 9, returned: 2, truncated: true };
  const out = renderInjection({ project: PROJECT, pinned: clipped, map: MAP });
  assert.ok(out.includes("7 more"), "names how many standing facts are missing");
  assert.ok(out.includes("memory_search"), "says how to read the rest");

  const whole = renderInjection({ project: PROJECT, pinned: PINNED, map: MAP });
  assert.ok(!whole.includes("more standing fact"), "no truncation note when nothing was dropped");
});

test("renderInjection omits empty sections rather than printing empty headings", () => {
  const none = { facts: [], total: 0, returned: 0, truncated: false };
  const noPinned = renderInjection({ project: PROJECT, pinned: none, map: MAP });
  assert.ok(!noPinned.includes("Always applies"));
  assert.ok(noPinned.includes("capture (34"));

  const empty = renderInjection({ project: PROJECT, pinned: none, map: [] });
  assert.ok(!empty.includes("Always applies"));
  assert.ok(!empty.includes("Tagged history"));
  assert.ok(empty.includes(PROJECT), "still identifies the project");
});
