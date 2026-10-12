#!/usr/bin/env node
// Detached by session start for 7 days after the switch: copies what sessions
// still running the Neo4j engine wrote. Neo4j unreachable or unconfigured: skipped quietly.
import { withNeo4jReader, Neo4jUnreachableError } from "../src/lib/migrate/fromNeo4j.js";
import { runCatchUp } from "../src/lib/catchUp.js";

try {
  await withNeo4jReader((readOnce) => runCatchUp({ readOnce }));
} catch (error) {
  console.log(error instanceof Neo4jUnreachableError ? `catch-up: skipped: ${error.message}` : `catch-up: failed: ${error.message}`);
}
