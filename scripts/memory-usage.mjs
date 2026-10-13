#!/usr/bin/env node
// Cross-project usage report for the SQLite memory store: every project with
// its counts and activity window, totals, and hygiene warnings.
//   npm run usage [-- --quiet]   --quiet prints the table and totals only
import fs from "node:fs";
import { memoryDbPath } from "../src/lib/config.js";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { buildUsageReport, renderUsageReport } from "../src/lib/usageReport.js";

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--quiet");
if (unknown.length > 0) {
  console.error(`usage: memory-usage [--quiet]   (unknown: ${unknown.join(" ")})`);
  process.exit(2);
}
const file = memoryDbPath();
if (!fs.existsSync(file)) {
  console.error(`memory-usage: no memory store at ${file}`);
  process.exit(1);
}
const db = openMemoryDb(file, { readOnly: true });
try {
  process.stdout.write(renderUsageReport(buildUsageReport(db), { quiet: args.includes("--quiet") }));
} finally {
  db.close();
}
