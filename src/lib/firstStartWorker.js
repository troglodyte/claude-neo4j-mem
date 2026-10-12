import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, memoryDbPath } from "./config.js";
import { acquireLock, releaseLock, writeRecord, stagedPath } from "./firstStart.js";
import { migrateFromNeo4j } from "./migrate/fromNeo4j.js";

const lastLine = (lines) =>
  lines
    .flatMap((line) => line.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

/**
 * Moves this machine's Neo4j graph into SQLite: migrates into memory.sqlite.migrating
 * and renames it to memory.sqlite only when the check passes, so a failed check
 * never becomes the live store. Records the outcome where session start reads it.
 */
export async function runFirstStartMigration({ dbPath = memoryDbPath(), stateDir = STATE_DIR, migrate = migrateFromNeo4j, now = Date.now, log = console.log } = {}) {
  if (!acquireLock({ stateDir })) {
    log("first start: another migration holds the lock");
    return 0;
  }
  const staged = stagedPath(dbPath);
  const base = { staged, log: path.join(stateDir, "migrate.log"), report: path.join(stateDir, "migrate-report.json") };
  try {
    if (fs.existsSync(dbPath)) {
      log(`first start: ${dbPath} already exists`);
      return 0;
    }
    const lines = [];
    const capture = (line) => {
      lines.push(String(line));
      log(line);
    };
    let exitCode;
    try {
      ({ exitCode } = await migrate({ out: staged, reportPath: base.report, log: capture, warn: capture }));
    } catch (error) {
      writeRecord({ ...base, result: "failed", exitCode: 2, reason: error.message, finishedAt: now() }, stateDir);
      log(`first start: failed: ${error.message}`);
      return 2;
    }
    // Closing the last connection checkpoints the WAL; one still on disk holds rows the rename would leave behind.
    if (exitCode === 0 && !fs.existsSync(`${staged}-wal`)) {
      fs.renameSync(staged, dbPath);
      writeRecord({ ...base, result: "passed", exitCode, finishedAt: now() }, stateDir);
      log(`first start: memory moved to ${dbPath}`);
      return 0;
    }
    const reason = exitCode === 0 ? `${staged}-wal survived; not moved into place` : (lastLine(lines) ?? `exit ${exitCode}`);
    writeRecord({ ...base, result: "failed", exitCode, reason, finishedAt: now() }, stateDir);
    log(`first start: failed: ${reason}`);
    return exitCode || 1;
  } finally {
    releaseLock({ stateDir });
  }
}
