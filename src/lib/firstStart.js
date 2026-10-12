import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, memoryDbPath, readConfigFile } from "./config.js";
import { openMemoryDb } from "./sqliteDb.js";

// Where memory stands on this machine, decided without creating anything:
// opening the store would create an empty file, and an empty file would make
// first start think this machine had already moved off Neo4j.
// Spec: docs/superpowers/specs/2026-10-09-sqlite-engine-design.md, "First start".

export const LOCK_STALE_MS = 30 * 60 * 1000;
export const MOVING_MESSAGE = "memory is moving to SQLite; try again in a minute";

const lockPath = (stateDir) => path.join(stateDir, "migrate.lock");
const recordPath = (stateDir) => path.join(stateDir, "migrate.json");

/** The file the first-start worker builds and renames into place on a passed check. */
export const stagedPath = (dbPath = memoryDbPath()) => `${dbPath}.migrating`;

/** A machine has a Neo4j config when config.json holds a password or NEO4J_PASSWORD is set. */
export function hasNeo4jConfig({ env = process.env, config = readConfigFile() } = {}) {
  return Boolean(env.NEO4J_PASSWORD || config?.password);
}

// The liveness test claude-mem and process registries use: EPERM still means alive.
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The lock's holder, or null when it is free or stale (its pid gone, or older than 30 minutes). */
export function lockHolder({ stateDir = STATE_DIR, now = Date.now() } = {}) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath(stateDir), "utf8"));
  } catch {
    return null;
  }
  if (!Number.isInteger(lock?.pid) || !alive(lock.pid) || now - lock.startedAt > LOCK_STALE_MS) {
    return null;
  }
  return lock;
}

/** Takes the lock for `pid`; false when a live holder has it. A stale lock is reclaimed. */
export function acquireLock({ stateDir = STATE_DIR, pid = process.pid, now = Date.now() } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath(stateDir), JSON.stringify({ pid, startedAt: now }), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (lockHolder({ stateDir, now })) {
        return false;
      }
      fs.rmSync(lockPath(stateDir), { force: true });
    }
  }
  return false;
}

/** Releases the lock if `pid` holds it. */
export function releaseLock({ stateDir = STATE_DIR, pid = process.pid } = {}) {
  try {
    if (JSON.parse(fs.readFileSync(lockPath(stateDir), "utf8")).pid === pid) {
      fs.rmSync(lockPath(stateDir), { force: true });
    }
  } catch {
    // already gone
  }
}

/** The last migration's outcome as the first-start worker recorded it. */
export function readRecord(stateDir = STATE_DIR) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(stateDir), "utf8"));
  } catch {
    return null;
  }
}

export function writeRecord(record, stateDir = STATE_DIR) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordPath(stateDir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * ready      memory.sqlite exists
 * migrating  a migration holds the lock
 * new        no store and no Neo4j config: an empty store may be created
 * failed     no store, and the last migration failed
 * pending    no store, a Neo4j config, nothing running: a migration should start
 */
export function storeState({ dbPath = memoryDbPath(), stateDir = STATE_DIR, env = process.env, config, now = Date.now() } = {}) {
  if (fs.existsSync(dbPath)) {
    return { state: "ready" };
  }
  if (lockHolder({ stateDir, now })) {
    return { state: "migrating" };
  }
  if (!hasNeo4jConfig({ env, config: config === undefined ? readConfigFile() : config })) {
    return { state: "new" };
  }
  const record = readRecord(stateDir);
  if (record?.result === "failed") {
    return { state: "failed", record };
  }
  return { state: "pending" };
}

/** Why memory is off, for tools and captures; null when the store may be opened. */
export function offReason(status) {
  if (status.state === "migrating" || status.state === "pending") {
    return MOVING_MESSAGE;
  }
  if (status.state === "failed") {
    return `the move to SQLite failed (${status.record.reason}); the log is ${status.record.log}. Retry with \`npm run migrate-to-sqlite\``;
  }
  return null;
}

/** Begins with an empty store, leaving Neo4j untouched (npm run memory -- start-fresh). */
export function startFresh({ dbPath = memoryDbPath(), stateDir = STATE_DIR, now = Date.now() } = {}) {
  if (fs.existsSync(dbPath)) {
    return `a store already exists at ${dbPath}; nothing changed`;
  }
  if (lockHolder({ stateDir, now })) {
    return "a migration is running; wait for it to finish";
  }
  openMemoryDb(dbPath).close();
  writeRecord({ result: "started-fresh", finishedAt: now }, stateDir);
  return `started an empty store at ${dbPath}; Neo4j is untouched`;
}
