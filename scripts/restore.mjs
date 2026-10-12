#!/usr/bin/env node
// Replaces the SQLite memory store with a backup; the current store is moved aside.
//   npm run restore -- --latest | <backup file> [--force]
import path from "node:path";
import { CONFIG_DIR, memoryDbPath } from "../src/lib/config.js";
import { listBackups, restoreStore } from "../src/lib/backup.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const named = args.find((a) => !a.startsWith("--"));
const backup = args.includes("--latest")
  ? listBackups(path.join(CONFIG_DIR, "backups"))[0]
  : named && path.resolve(process.env.INIT_CWD ?? process.cwd(), named);
if (!backup) {
  console.error("usage: restore --latest | <backup file> [--force]   (no backup found)");
  process.exit(2);
}
try {
  const { target, movedAside } = restoreStore({ backup, target: memoryDbPath(), force });
  console.log(`restored ${backup} to ${target}${movedAside ? `; previous store kept at ${movedAside}` : ""}`);
} catch (error) {
  console.error(`restore refused: ${error.message}`);
  process.exit(1);
}
