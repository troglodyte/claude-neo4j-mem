import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMemories } from "../src/hooks/capture.js";

test("mergeMemories keeps each observation's subsystem across chunks", () => {
  const merged = mergeMemories([
    {
      entities: [
        {
          name: "plugin:neo4j-memory",
          type: "plugin",
          observations: [{ text: "capture retries up to 3 times", subsystem: "auto-capture" }],
        },
      ],
      relations: [],
    },
    {
      entities: [
        {
          name: "plugin:neo4j-memory",
          type: "plugin",
          observations: [{ text: "backup writes a .sha256 sidecar", subsystem: "backup" }],
        },
      ],
      relations: [],
    },
  ]);

  assert.equal(merged.entities.length, 1, "the same entity across chunks merges into one write");
  const subsystems = merged.entities[0].observations.map((o) => o.subsystem);
  assert.deepEqual(subsystems, ["auto-capture", "backup"], "tags survive the merge, one per observation");
});

test("mergeMemories still drops entities with no observations", () => {
  const merged = mergeMemories([{ entities: [{ name: "empty:stub", observations: [] }], relations: [] }]);
  assert.equal(merged.entities.length, 0);
});
