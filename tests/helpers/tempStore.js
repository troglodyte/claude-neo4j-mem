import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb } from "../../src/lib/memoryStore.js";

/** Points this test process's memory store at a fresh, empty file. */
export function useTempStore() {
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-")), "memory.sqlite");
  process.env.CLAUDE_NEO4J_SQLITE = file;
  return file;
}
