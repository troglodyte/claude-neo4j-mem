import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { backupStore, listBackups, restoreStore } from "../src/lib/backup.js";

function storeWithEntity(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  const file = path.join(dir, "memory.sqlite");
  const db = openMemoryDb(file);
  db.prepare("INSERT INTO entities (name, project, type, created_at, updated_at) VALUES (?, 'p', NULL, 1, 1)").run(name);
  db.close();
  return { dir, file };
}

const entityNames = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM entities ORDER BY name").all().map((r) => r.name);
  } finally {
    db.close();
  }
};

test("a backup is a private, complete copy named by its UTC time", () => {
  const { dir, file } = storeWithEntity("alpha");
  const { file: backup } = backupStore({ source: file, dir: path.join(dir, "backups"), now: new Date("2026-10-12T17:15:00.123Z") });
  assert.equal(path.basename(backup), "memory-20261012T171500Z.sqlite");
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.deepEqual(entityNames(backup), ["alpha"]);
});

test("--keep prunes the oldest memory backups and leaves other files alone", () => {
  const { dir, file } = storeWithEntity("alpha");
  const backups = path.join(dir, "backups");
  fs.mkdirSync(backups);
  fs.writeFileSync(path.join(backups, "neo4j-20260101T000000Z.dump"), "legacy");
  for (const hour of ["01", "02", "03"]) {
    backupStore({ source: file, dir: backups, keep: 2, now: new Date(`2026-10-12T${hour}:00:00Z`) });
  }
  assert.deepEqual(listBackups(backups).map((f) => path.basename(f)), ["memory-20261012T030000Z.sqlite", "memory-20261012T020000Z.sqlite"]);
  assert.ok(fs.existsSync(path.join(backups, "neo4j-20260101T000000Z.dump")));
});

test("restore moves the current store aside and puts the backup in its place", () => {
  const { dir, file: backupSource } = storeWithEntity("from-backup");
  const { file: backup } = backupStore({ source: backupSource, dir: path.join(dir, "backups") });
  const { file: target } = storeWithEntity("current");
  const { movedAside } = restoreStore({ backup, target, holders: [], now: new Date("2026-10-12T18:00:00Z") });
  assert.deepEqual(entityNames(target), ["from-backup"]);
  assert.deepEqual(entityNames(movedAside), ["current"]);
  assert.match(movedAside, /memory\.sqlite\.pre-restore-20261012T180000Z$/);
});

test("restore refuses while a process holds the store, unless forced", () => {
  const { dir, file: source } = storeWithEntity("from-backup");
  const { file: backup } = backupStore({ source, dir: path.join(dir, "backups") });
  const { file: target } = storeWithEntity("current");
  assert.throws(() => restoreStore({ backup, target, holders: ["4242"] }), /4242/);
  assert.deepEqual(entityNames(target), ["current"]);
  restoreStore({ backup, target, holders: ["4242"], force: true });
  assert.deepEqual(entityNames(target), ["from-backup"]);
});

test("restore refuses a backup that is not a healthy memory store", () => {
  const { dir, file: target } = storeWithEntity("current");
  const junk = path.join(dir, "junk.sqlite");
  fs.writeFileSync(junk, "not a database");
  assert.throws(() => restoreStore({ backup: junk, target, holders: [] }));
  assert.deepEqual(entityNames(target), ["current"]);
});
