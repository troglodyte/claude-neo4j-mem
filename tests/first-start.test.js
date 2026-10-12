import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  storeState,
  offReason,
  acquireLock,
  releaseLock,
  lockHolder,
  writeRecord,
  startFresh,
  MOVING_MESSAGE,
  LOCK_STALE_MS,
} from "../src/lib/firstStart.js";
import { getDb, closeDb } from "../src/lib/memoryStore.js";

// A machine in a temp folder: its store path, state folder, environment and config.
function machine({ password = true, store = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-start-"));
  const dbPath = path.join(dir, "memory.sqlite");
  if (store) {
    fs.writeFileSync(dbPath, "");
  }
  return { dir, dbPath, stateDir: path.join(dir, "state"), env: {}, config: password ? { password: "secret" } : {} };
}

const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;

test("an existing store is ready", () => {
  assert.equal(storeState(machine({ store: true })).state, "ready");
});

test("no store and no Neo4j config is a new user", () => {
  assert.equal(storeState(machine({ password: false })).state, "new");
});

test("NEO4J_PASSWORD counts as a Neo4j config", () => {
  const m = machine({ password: false });
  assert.equal(storeState({ ...m, env: { NEO4J_PASSWORD: "x" } }).state, "pending");
});

test("no store with a Neo4j config is pending, and memory is off while it moves", () => {
  const m = machine();
  assert.equal(storeState(m).state, "pending");
  assert.equal(offReason(storeState(m)), MOVING_MESSAGE);
});

test("a held lock means migrating, and a second taker is refused", () => {
  const m = machine();
  assert.equal(acquireLock({ stateDir: m.stateDir }), true);
  assert.equal(storeState(m).state, "migrating");
  assert.equal(acquireLock({ stateDir: m.stateDir }), false);
  releaseLock({ stateDir: m.stateDir });
  assert.equal(storeState(m).state, "pending");
});

test("a lock whose process is gone, or older than 30 minutes, is stale and reclaimed", () => {
  const m = machine();
  fs.mkdirSync(m.stateDir, { recursive: true });
  const lock = path.join(m.stateDir, "migrate.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), startedAt: Date.now() }));
  assert.equal(lockHolder({ stateDir: m.stateDir }), null);
  assert.equal(acquireLock({ stateDir: m.stateDir }), true);
  releaseLock({ stateDir: m.stateDir });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - LOCK_STALE_MS - 1 }));
  assert.equal(lockHolder({ stateDir: m.stateDir }), null);
});

test("a failed last migration keeps memory off with its reason, log and retry command", () => {
  const m = machine();
  writeRecord({ result: "failed", reason: "observations: 2 missing", log: "/x/migrate.log" }, m.stateDir);
  const status = storeState(m);
  assert.equal(status.state, "failed");
  assert.match(offReason(status), /failed \(observations: 2 missing\).*\/x\/migrate\.log.*npm run migrate-to-sqlite/);
});

test("start-fresh creates an empty store once, leaving Neo4j alone", () => {
  const m = machine();
  assert.match(startFresh(m), /empty store/);
  assert.equal(storeState(m).state, "ready");
  assert.match(startFresh(m), /already/);
});

test("start-fresh refuses while a migration runs", () => {
  const m = machine();
  acquireLock({ stateDir: m.stateDir });
  assert.match(startFresh(m), /migration is running/);
  assert.equal(fs.existsSync(m.dbPath), false);
  releaseLock({ stateDir: m.stateDir });
});

test("the store gate will not create an empty store while memory should be moving", () => {
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-")), "memory.sqlite");
  process.env.CLAUDE_NEO4J_SQLITE = file;
  process.env.NEO4J_PASSWORD = "secret";
  try {
    assert.throws(() => getDb(), new RegExp(MOVING_MESSAGE));
    assert.equal(fs.existsSync(file), false);
  } finally {
    delete process.env.NEO4J_PASSWORD;
    closeDb();
  }
});
