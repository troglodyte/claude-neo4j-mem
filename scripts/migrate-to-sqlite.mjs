#!/usr/bin/env node
// Copies the Neo4j memory graph into a SQLite file and checks every row.
// Neo4j is only read; the plugin's config is not changed.
//   node scripts/migrate-to-sqlite.mjs [--out PATH] [--check-only] [--report PATH]
// Spec: docs/superpowers/specs/2026-10-09-sqlite-migration-design.md
import path from "node:path";
import { CONFIG_DIR } from "../src/lib/config.js";
import { parseArgs, withoutCredentials } from "../src/lib/migrate/cli.js";

async function main() {
  const { flags, error } = parseArgs(process.argv.slice(2), {
    cwd: process.env.INIT_CWD ?? process.cwd(),
    defaultOut: path.join(CONFIG_DIR, "memory.sqlite"),
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
    console.error(`migrate-to-sqlite needs node:sqlite, in Node 22.5 or later; this is Node ${process.versions.node}.`);
    return 2;
  }
  const { default: neo4j } = await import("neo4j-driver");
  const { loadConnectionConfig } = await import("../src/lib/config.js");
  const { getDriver, verifyConnectivity, closeDriver } = await import("../src/lib/neo4jClient.js");
  const { readGraph } = await import("../src/lib/migrate/readNeo4j.js");
  const { runMigration } = await import("../src/lib/migrate/runMigration.js");

  try {
    let config;
    try {
      config = loadConnectionConfig();
      await verifyConnectivity();
    } catch (connectError) {
      console.error(`Cannot reach Neo4j: ${connectError.message}`);
      return 2;
    }
    const source = withoutCredentials(config.uri);
    if (config.mode === "remote") {
      console.warn(`Warning: the source is a remote graph (${source}); the SQLite file serves this machine only.`);
    }
    const readOnce = async () => {
      const session = getDriver().session({ database: config.database, defaultAccessMode: neo4j.session.READ });
      try {
        return await readGraph(session);
      } finally {
        await session.close();
      }
    };
    const { exitCode } = await runMigration({
      readOnce,
      out: flags.out,
      checkOnly: flags.checkOnly,
      reportPath: flags.report,
      sourceLabel: `${source} (${config.mode})`,
    });
    return exitCode;
  } finally {
    await closeDriver();
  }
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
