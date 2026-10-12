#!/usr/bin/env node
// Claude Code statusLine command: prints one line to stdout showing the model
// and, when the memory store can be opened, entity/observation counts for the
// current project. Must be fast and must never block the UI, so the lookup is
// capped with a hard timeout and failures are swallowed.
import { detectProject } from "../src/lib/project.js";
import { getStatus } from "../src/lib/graph.js";
import { storeStatus, closeDb } from "../src/lib/memoryStore.js";

const TIMEOUT_MS = 1500;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    // no/invalid stdin — proceed with defaults
  }

  const modelName = input.model?.display_name ?? input.model?.id ?? "Claude";
  const cwd = input.workspace?.current_dir ?? input.cwd ?? process.cwd();

  let memorySegment = "";
  if (storeStatus().ready) {
    try {
      const project = detectProject(cwd);
      const { entityCount, observationCount } = await withTimeout(getStatus({ project }), TIMEOUT_MS);
      memorySegment = ` · 🧠 ${entityCount}e/${observationCount}o`;
    } catch {
      memorySegment = " · 🧠 offline";
    } finally {
      closeDb();
    }
  }

  process.stdout.write(`${modelName}${memorySegment}`);
}

main()
  .catch(() => process.stdout.write("Claude"))
  .finally(() => process.exit(0));
