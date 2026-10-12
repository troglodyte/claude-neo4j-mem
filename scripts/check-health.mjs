#!/usr/bin/env node
// PASS/FAIL per check for the SQLite memory store. Run through bin/memory-node
// (npm run health), so getting this far already proves the launcher found a Node.
import { memoryDbPath } from "../src/lib/config.js";
import { healthChecks } from "../src/lib/health.js";

const checks = healthChecks(memoryDbPath());
for (const { name, ok, detail } of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(10)} ${detail}`);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
