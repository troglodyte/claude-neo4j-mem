import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFirstStartMigration } from "../src/lib/firstStartWorker.js";
import { acquireLock, releaseLock, readRecord, lockHolder, storeState } from "../src/lib/firstStart.js";

function where() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-start-worker-"));
  return { dbPath: path.join(dir, "memory.sqlite"), stateDir: path.join(dir, "state"), log: () => {} };
}

// Stands in for the migration: writes the staged file, logs a last line, exits.
const migrateStub = (exitCode, lastLine) => async ({ out, log }) => {
  fs.writeFileSync(out, "built");
  log(lastLine);
  return { exitCode };
};

test("a passing migration is renamed into place and recorded", async () => {
  const w = where();
  assert.equal(await runFirstStartMigration({ ...w, migrate: migrateStub(0, "PASS   report: r.json") }), 0);
  assert.equal(fs.readFileSync(w.dbPath, "utf8"), "built");
  assert.equal(fs.existsSync(readRecord(w.stateDir).staged), false);
  assert.equal(readRecord(w.stateDir).result, "passed");
  assert.equal(lockHolder({ stateDir: w.stateDir }), null);
});

test("a failed check never becomes memory.sqlite; the staged file and the reason stay", async () => {
  const w = where();
  assert.equal(await runFirstStartMigration({ ...w, migrate: migrateStub(1, "FAIL   report: r.json") }), 1);
  assert.equal(fs.existsSync(w.dbPath), false);
  assert.equal(fs.readFileSync(readRecord(w.stateDir).staged, "utf8"), "built");
  const record = readRecord(w.stateDir);
  assert.equal(record.result, "failed");
  assert.equal(record.reason, "FAIL   report: r.json");
  assert.equal(lockHolder({ stateDir: w.stateDir }), null);
});

test("a migration that throws is recorded as failed", async () => {
  const w = where();
  const migrate = async () => {
    throw new Error("boom");
  };
  assert.equal(await runFirstStartMigration({ ...w, migrate }), 2);
  assert.equal(readRecord(w.stateDir).reason, "boom");
});

test("a worker that finds the lock held leaves the running migration alone", async () => {
  const w = where();
  acquireLock({ stateDir: w.stateDir });
  let ran = false;
  const migrate = async () => {
    ran = true;
    return { exitCode: 0 };
  };
  assert.equal(await runFirstStartMigration({ ...w, migrate }), 0);
  assert.equal(ran, false);
  releaseLock({ stateDir: w.stateDir });
});

test("a store that appeared meanwhile is left alone", async () => {
  const w = where();
  fs.writeFileSync(w.dbPath, "existing");
  let ran = false;
  const migrate = async () => {
    ran = true;
    return { exitCode: 0 };
  };
  assert.equal(await runFirstStartMigration({ ...w, migrate }), 0);
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(w.dbPath, "utf8"), "existing");
});

test("each run builds in its own staged file", async () => {
  const w = where();
  const outs = [];
  const migrate = async ({ out }) => {
    outs.push(out);
    return { exitCode: 1 };
  };
  await runFirstStartMigration({ ...w, migrate });
  await runFirstStartMigration({ ...w, migrate });
  assert.equal(outs.length, 2);
  assert.notEqual(outs[0], outs[1]);
  for (const out of outs) {
    assert.match(out, /memory\.sqlite\.migrating-\d+-[0-9a-f]{8}$/);
  }
});

test("a store that appears while the worker builds is never overwritten", async () => {
  const w = where();
  const migrate = async ({ out }) => {
    fs.writeFileSync(out, "built");
    fs.writeFileSync(w.dbPath, "another worker's store");
    return { exitCode: 0 };
  };
  assert.equal(await runFirstStartMigration({ ...w, migrate }), 0);
  assert.equal(fs.readFileSync(w.dbPath, "utf8"), "another worker's store");
  assert.deepEqual(fs.readdirSync(path.dirname(w.dbPath)).filter((name) => name.includes(".migrating")), []);
});

test("a connection or read problem is recorded as could-not-run, so the next session start tries again", async () => {
  const w = where();
  const migrate = async ({ log }) => {
    log("Cannot reach Neo4j: connection refused");
    return { exitCode: 2, transient: true };
  };
  assert.equal(await runFirstStartMigration({ ...w, migrate }), 2);
  assert.equal(readRecord(w.stateDir).result, "could-not-run");
  assert.equal(storeState({ dbPath: w.dbPath, stateDir: w.stateDir, env: {}, config: { password: "x" } }).state, "pending");
});
