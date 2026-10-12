import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { STATE_DIR, memoryDbPath } from "./config.js";
import { acquireLock, releaseLock, writeRecord, stagedPath } from "./firstStart.js";
import { migrateFromNeo4j } from "./migrate/fromNeo4j.js";

const lastLine = (lines) =>
  lines
    .flatMap((line) => line.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

const removeDbFiles = (file) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
};

// Links the staged file to the live path, never over an existing store, then drops the
// staged name. False when a store appeared at the live path while this run was building.
function placeStaged(staged, dbPath) {
  try {
    fs.linkSync(staged, dbPath);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    return false;
  } finally {
    removeDbFiles(staged);
  }
}

// Records why nothing was moved and returns the exit code. A connection or read problem
// is could-not-run, which session start retries; anything else is failed, which it shows.
function recordNotMoved({ base, exitCode, transient, lines, stateDir, now, log }) {
  const reason = exitCode === 0 ? `${base.staged}-wal survived; not moved into place` : (lastLine(lines) ?? `exit ${exitCode}`);
  const outcome = transient ? "could-not-run" : "failed";
  writeRecord({ ...base, result: outcome, exitCode, reason, finishedAt: now() }, stateDir);
  log(`first start: ${outcome}: ${reason}`);
  return exitCode || 1;
}

/**
 * Moves this machine's Neo4j graph into SQLite: migrates into a staged file of this
 * run's own and links it to memory.sqlite only when the check passes, never over an
 * existing store, so a failed check never becomes the live store and two workers never
 * undo each other. Records the outcome where session start reads it; a connection or
 * read problem is recorded as could-not-run, which the next session start retries.
 */
export async function runFirstStartMigration({
  dbPath = memoryDbPath(),
  stateDir = STATE_DIR,
  migrate = migrateFromNeo4j,
  now = Date.now,
  log = console.log,
  warn = console.error,
} = {}) {
  if (!acquireLock({ stateDir })) {
    log("first start: another migration holds the lock");
    return 0;
  }
  const staged = stagedPath(dbPath, `${process.pid}-${randomBytes(4).toString("hex")}`);
  const base = { staged, log: path.join(stateDir, "migrate.log"), report: path.join(stateDir, "migrate-report.json") };
  try {
    if (fs.existsSync(dbPath)) {
      log(`first start: ${dbPath} already exists`);
      return 0;
    }
    const lines = [];
    const capture = (write) => (line) => {
      lines.push(String(line));
      write(line);
    };
    let result;
    try {
      result = await migrate({ out: staged, reportPath: base.report, log: capture(log), warn: capture(warn) });
    } catch (error) {
      writeRecord({ ...base, result: "failed", exitCode: 2, reason: error.message, finishedAt: now() }, stateDir);
      log(`first start: failed: ${error.message}`);
      return 2;
    }
    const { exitCode, transient = false } = result;
    // Closing the last connection checkpoints the WAL; one still on disk holds rows a link would leave behind.
    if (exitCode === 0 && !fs.existsSync(`${staged}-wal`)) {
      if (!placeStaged(staged, dbPath)) {
        log(`first start: ${dbPath} appeared while this run was building; left it in place`);
        return 0;
      }
      writeRecord({ ...base, result: "passed", exitCode, finishedAt: now() }, stateDir);
      log(`first start: memory moved to ${dbPath}`);
      return 0;
    }
    return recordNotMoved({ base, exitCode, transient, lines, stateDir, now, log });
  } finally {
    releaseLock({ stateDir });
  }
}
