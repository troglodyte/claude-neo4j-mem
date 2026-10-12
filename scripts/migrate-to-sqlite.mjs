#!/usr/bin/env node
// Copies the Neo4j memory graph into a SQLite file and checks every row.
// Neo4j is only read; the plugin's config is not changed.
//   node scripts/migrate-to-sqlite.mjs [--out PATH] [--check-only] [--report PATH]
// Without --out it moves the graph into the live store the way first start does:
// staged, checked, then put in place without overwriting, under the same lock.
// Spec: docs/superpowers/specs/2026-10-09-sqlite-migration-design.md
import { memoryDbPath } from "../src/lib/config.js";
import { parseArgs } from "../src/lib/migrate/cli.js";

async function main() {
  const { flags, error } = parseArgs(process.argv.slice(2), {
    cwd: process.env.INIT_CWD ?? process.cwd(),
    defaultOut: memoryDbPath(),
  });
  if (error) {
    console.error(error);
    return 2;
  }
  // Checked before anything that imports node:sqlite, so an old Node gets this
  // message instead of a module-resolution crash.
  try {
    await import("node:sqlite");
  } catch {
    console.error(`migrate-to-sqlite needs node:sqlite, in Node 22.13 or later; this is Node ${process.versions.node}.`);
    return 2;
  }
  if (!process.argv.slice(2).includes("--out") && !flags.checkOnly) {
    const { runFirstStartMigration } = await import("../src/lib/firstStartWorker.js");
    return runFirstStartMigration();
  }
  const { migrateFromNeo4j } = await import("../src/lib/migrate/fromNeo4j.js");
  const { exitCode } = await migrateFromNeo4j({ out: flags.out, checkOnly: flags.checkOnly, reportPath: flags.report });
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
  }
);
