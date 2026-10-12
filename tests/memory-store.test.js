import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getDb, closeDb, storeStatus, inTransaction } from "../src/lib/memoryStore.js";
import { memoryDbPath } from "../src/lib/config.js";
import { SCHEMA_VERSION } from "../src/lib/sqliteDb.js";

const STORE = fileURLToPath(new URL("../src/lib/memoryStore.js", import.meta.url));
const tempPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-")), "memory.sqlite");

afterEach(() => {
  closeDb();
  delete process.env.CLAUDE_NEO4J_SQLITE;
});

test("CLAUDE_NEO4J_SQLITE names the store", () => {
  const file = tempPath();
  process.env.CLAUDE_NEO4J_SQLITE = file;
  assert.equal(memoryDbPath(), file);
});

test("getDb opens the store once and reuses the connection", () => {
  process.env.CLAUDE_NEO4J_SQLITE = tempPath();
  const first = getDb();
  assert.equal(getDb(), first);
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
});

// A config.json that is briefly unreadable (mid-rewrite) or edited by hand
// changes the resolved path; a running server must keep writing where it began.
test("an open store stays put when the configured path changes, until closeDb", () => {
  const original = tempPath();
  process.env.CLAUDE_NEO4J_SQLITE = original;
  const first = getDb();
  process.env.CLAUDE_NEO4J_SQLITE = tempPath();
  assert.equal(getDb(), first, "the store must not be swapped mid-process");
  assert.equal(storeStatus().path, original);
  closeDb();
  assert.notEqual(getDb(), first, "after closeDb the new path is used");
  assert.throws(() => first.prepare("SELECT 1"), /not open/i);
});

test("storeStatus says why a store cannot be opened instead of throwing", () => {
  process.env.CLAUDE_NEO4J_SQLITE = "/dev/null/memory.sqlite";
  const status = storeStatus();
  assert.equal(status.ready, false);
  assert.equal(status.path, "/dev/null/memory.sqlite");
  assert.match(status.reason, /EEXIST|ENOTDIR|not a directory/i);
});

test("storeStatus reports a usable store as ready", () => {
  process.env.CLAUDE_NEO4J_SQLITE = tempPath();
  assert.deepEqual(storeStatus(), { ready: true, path: process.env.CLAUDE_NEO4J_SQLITE });
});

test("inTransaction commits on success and rolls back on error", () => {
  process.env.CLAUDE_NEO4J_SQLITE = tempPath();
  const db = getDb();
  inTransaction(db, () => db.exec("INSERT INTO sessions (id, started_at) VALUES ('kept', 1)"));
  assert.throws(
    () =>
      inTransaction(db, () => {
        db.exec("INSERT INTO sessions (id, started_at) VALUES ('dropped', 1)");
        throw new Error("boom");
      }),
    /boom/
  );
  assert.deepEqual(db.prepare("SELECT id FROM sessions").all().map((row) => row.id), ["kept"]);
});

// Opens the store at `file` from a separate process the moment `go` exists.
// The child says "ready" once it is loaded and spinning, so the test fires the
// starting gun only when every opener is waiting. Racing a wall-clock instant
// instead passed vacuously whenever start-up outran the head start.
function opener(file, go) {
  const script = `import fs from "node:fs";
    import { getDb } from ${JSON.stringify(STORE)};
    fs.writeSync(1, "ready\\n");
    while (!fs.existsSync(${JSON.stringify(go)})) {}
    getDb();`;
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    env: { ...process.env, CLAUDE_NEO4J_SQLITE: file },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    ready: new Promise((resolve) => {
      child.stdout.once("data", resolve);
      child.on("close", resolve);
    }),
    done: new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr }))),
  };
}

// On a first session the session-start hook and the memory server start
// together. Each round releases six waiting openers at once; even then a round
// collides only some of the time, hence eight rounds.
test("processes opening a brand-new store at the same moment all succeed", async () => {
  for (let round = 0; round < 8; round++) {
    const file = tempPath();
    const go = path.join(path.dirname(file), "go");
    const openers = Array.from({ length: 6 }, () => opener(file, go));
    await Promise.all(openers.map((o) => o.ready));
    fs.writeFileSync(go, "");
    const results = await Promise.all(openers.map((o) => o.done));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }
    closeDb();
    process.env.CLAUDE_NEO4J_SQLITE = file;
    assert.equal(getDb().prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  }
});
