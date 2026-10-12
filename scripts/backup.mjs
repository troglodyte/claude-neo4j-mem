#!/usr/bin/env node
// Online backup of the SQLite memory store into ~/.claude-neo4j/backups.
//   npm run backup [-- --keep N]
import path from "node:path";
import { CONFIG_DIR, memoryDbPath } from "../src/lib/config.js";
import { backupStore } from "../src/lib/backup.js";

const args = process.argv.slice(2);
const keepAt = args.indexOf("--keep");
const keep = keepAt === -1 ? null : Number(args[keepAt + 1]);
if (keep !== null && !(Number.isInteger(keep) && keep > 0)) {
  console.error("usage: backup [--keep N]   (N a positive integer)");
  process.exit(2);
}
try {
  const { file, pruned } = backupStore({ source: memoryDbPath(), dir: path.join(CONFIG_DIR, "backups"), keep });
  console.log(`backed up to ${file}${pruned.length ? `; pruned ${pruned.length} older backup(s)` : ""}`);
} catch (error) {
  console.error(`backup failed: ${error.message}`);
  process.exit(1);
}
