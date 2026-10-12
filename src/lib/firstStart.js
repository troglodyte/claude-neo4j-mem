import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_DIR, memoryDbPath, readConfigFile } from "./config.js";
import { openMemoryDb } from "./sqliteDb.js";

// Where memory stands on this machine, decided without creating anything:
// opening the store would create an empty file, and an empty file would make
// first start think this machine had already moved off Neo4j.
// Spec: docs/superpowers/specs/2026-10-09-sqlite-engine-design.md, "First start".

export const LOCK_STALE_MS = 30 * 60 * 1000;
// A lock file is created empty and then written; for this long an unreadable one still counts as held.
const LOCK_SETTLE_MS = 5000;
export const MOVING_MESSAGE = "memory is moving to SQLite; try again in a minute";

const lockPath = (stateDir) => path.join(stateDir, "migrate.lock");
const recordPath = (stateDir) => path.join(stateDir, "migrate.json");

/** The file one first-start worker builds; each run has its own, so two workers never share a build. */
export const stagedPath = (dbPath, token) => `${dbPath}.migrating-${token}`;

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

// The holder recorded in a lock file, or null when the file is stale: its pid gone,
// older than 30 minutes, or unreadable for longer than a write takes.
function holderOf(file, now) {
  let text;
  let stat;
  try {
    text = fs.readFileSync(file, "utf8");
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return now - stat.mtimeMs < LOCK_SETTLE_MS ? { pid: null, startedAt: stat.mtimeMs } : null;
  }
  if (!Number.isInteger(lock?.pid) || !alive(lock.pid) || now - lock.startedAt > LOCK_STALE_MS) {
    return null;
  }
  return lock;
}

/** The lock's holder, or null when it is free or stale (its pid gone, or older than 30 minutes). */
export function lockHolder({ stateDir = STATE_DIR, now = Date.now() } = {}) {
  return holderOf(lockPath(stateDir), now);
}

/** Takes the lock for `pid`; false when a live holder has it. A stale lock is reclaimed. */
export function acquireLock({ stateDir = STATE_DIR, pid = process.pid, now = Date.now() } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = lockPath(stateDir);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, startedAt: now }), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    if (holderOf(file, now)) {
      return false;
    }
    // Reclaim by renaming the stale lock aside: only one taker's rename succeeds, and a
    // lock someone took in the meantime is put back instead of being deleted.
    const aside = `${file}.stale-${pid}-${attempt}`;
    try {
      fs.renameSync(file, aside);
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const taken = holderOf(aside, now);
    if (taken) {
      try {
        fs.linkSync(aside, file);
      } catch {
        // someone else already holds the slot
      }
    }
    fs.rmSync(aside, { force: true });
    if (taken) {
      return false;
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

export const MOVING_LINE = "moving to SQLite; memory is off for about a minute.";
export const UNREACHABLE_LINE =
  "Neo4j is not running, so memory cannot move to SQLite yet. Start it once (scripts/setup-local.sh) so memory can move, " +
  "or run `npm run memory -- start-fresh` to begin empty with Neo4j left untouched.";

const WORKER = fileURLToPath(new URL("../../scripts/first-start-migrate.mjs", import.meta.url));

/** Whether the configured Neo4j accepts a TCP connection; a quick probe, not a login. */
export function neo4jReachable({ env = process.env, config = readConfigFile(), timeoutMs = 1500 } = {}) {
  let host;
  let port;
  try {
    const url = new URL(env.NEO4J_URI ?? config?.uri ?? "bolt://localhost:7687");
    host = url.hostname;
    port = Number(url.port) || 7687;
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Detaches the first-start worker; its output goes to state/migrate.log. */
export function spawnMigrationWorker({ stateDir = STATE_DIR, nodePath = process.execPath } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(stateDir, "migrate.log"), "a", 0o600);
  try {
    const child = spawn(nodePath, ["--disable-warning=ExperimentalWarning", WORKER], { detached: true, stdio: ["ignore", log, log] });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

/** Session start's first-start step: null when the store can be used, else the line to show. */
export async function beginFirstStart({ probe = neo4jReachable, spawnWorker = spawnMigrationWorker, ...where } = {}) {
  const status = storeState(where);
  if (status.state === "ready" || status.state === "new") {
    return null;
  }
  if (status.state === "migrating") {
    return MOVING_LINE;
  }
  if (status.state === "failed") {
    return offReason(status);
  }
  if (!(await probe())) {
    return UNREACHABLE_LINE;
  }
  spawnWorker();
  return MOVING_LINE;
}
