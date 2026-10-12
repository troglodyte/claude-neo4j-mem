import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { healthChecks } from "../src/lib/health.js";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "health-test-")), "memory.sqlite");
const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name, c]));

test("a healthy store passes every check", () => {
  const file = tempFile();
  openMemoryDb(file).close();
  const checks = healthChecks(file);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  assert.match(byName(checks).node.detail, /^\d+\.\d+\.\d+$/);
});

test("a missing store fails the store check and stops there", () => {
  const checks = byName(healthChecks(tempFile()));
  assert.equal(checks.store.ok, false);
  assert.equal(checks.integrity, undefined);
});

test("a file that is not a database fails the integrity check", () => {
  const file = tempFile();
  fs.writeFileSync(file, "not a database");
  const checks = byName(healthChecks(file));
  assert.equal(checks.store.ok, true);
  assert.equal(checks.integrity.ok, false);
});
