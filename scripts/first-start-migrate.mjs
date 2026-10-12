#!/usr/bin/env node
// Detached by session start on a machine with a Neo4j config and no store yet.
// Its output goes to ~/.claude-neo4j/state/migrate.log; its outcome to migrate.json.
import { runFirstStartMigration } from "../src/lib/firstStartWorker.js";

runFirstStartMigration().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`first start: ${error.message}`);
    process.exitCode = 2;
  }
);
