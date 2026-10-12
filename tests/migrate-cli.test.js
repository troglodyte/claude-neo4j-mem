import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("../scripts/migrate-to-sqlite.mjs", import.meta.url));

// CONFIG_DIR comes from os.homedir(), so an isolated $HOME keeps every run away
// from the developer's real ~/.claude-neo4j. Port 1 refuses connections at once.
function runCli(args, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-cli-"));
  const result = spawnSync(process.execPath, ["--no-warnings", SCRIPT, ...args], {
    env: { ...process.env, HOME: home, NEO4J_URI: "bolt://127.0.0.1:1", NEO4J_PASSWORD: "unused", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { ...result, home };
}

test("an unreachable Neo4j exits 2 and writes nothing", () => {
  const { status, stderr, home } = runCli([]);
  assert.equal(status, 2);
  assert.match(stderr, /Cannot reach Neo4j/);
  assert.equal(fs.existsSync(path.join(home, ".claude-neo4j", "memory.sqlite")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude-neo4j", "memory.sqlite.tmp")), false);
});

test("an unknown flag exits 2 with the usage line", () => {
  const { status, stderr } = runCli(["--frobnicate"]);
  assert.equal(status, 2);
  assert.match(stderr, /usage: migrate-to-sqlite/);
});

test("with no --out, the move runs through the first-start worker and records its outcome", () => {
  const { status, home } = runCli([]);
  assert.equal(status, 2);
  const record = JSON.parse(fs.readFileSync(path.join(home, ".claude-neo4j", "state", "migrate.json"), "utf8"));
  assert.equal(record.result, "could-not-run");
  assert.equal(fs.existsSync(path.join(home, ".claude-neo4j", "memory.sqlite")), false);
});
