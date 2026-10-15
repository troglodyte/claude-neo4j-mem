import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useTempStore } from "./helpers/tempStore.js";
import { getDb, closeDb } from "../src/lib/memoryStore.js";

const SCRIPT = fileURLToPath(new URL("../scripts/memory-stats.mjs", import.meta.url));
const PROJECT = "github.com/acme/widget";
let store;
let repo;

// npm sets INIT_CWD to where `npm run` was typed, which is how the report finds
// the project being worked on while the script itself runs in the plugin root.
function runCli(args, env = {}) {
  return spawnSync(process.execPath, ["--no-warnings", SCRIPT, ...args], {
    cwd: os.tmpdir(),
    env: { ...process.env, CLAUDE_NEO4J_SQLITE: store, INIT_CWD: repo, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

before(() => {
  store = useTempStore();
  const db = getDb();
  const insertEntity = db.prepare("INSERT INTO entities (name, project, created_at) VALUES (?, ?, ?)");
  const insertObservation = db.prepare("INSERT INTO observations (id, entity_id, text, created_at) VALUES (?, ?, ?, ?)");
  const widget = Number(insertEntity.run("w", PROJECT, Date.now()).lastInsertRowid);
  const gadget = Number(insertEntity.run("g", "github.com/acme/gadget", Date.now()).lastInsertRowid);
  insertObservation.run("o1", widget, "a fact", Date.now());
  insertObservation.run("o2", gadget, "a fact", Date.now());
  insertObservation.run("o3", gadget, "a fact", Date.now());
  closeDb();

  repo = fs.mkdtempSync(path.join(os.tmpdir(), "stats-cli-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", `git@github.com:acme/widget.git`], { cwd: repo });
});

after(() => {
  closeDb();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("with no flags, reports the project of the directory npm was run from", () => {
  const { status, stdout } = runCli([]);

  assert.equal(status, 0);
  assert.match(stdout, /Memory stats: github\.com\/acme\/widget/);
  assert.match(stdout, /1 entities, 1 observations/);
});

test("--project reports the named project instead", () => {
  const { status, stdout } = runCli(["--project", "github.com/acme/gadget"]);

  assert.equal(status, 0);
  assert.match(stdout, /1 entities, 2 observations/);
});

test("--all reports the whole store", () => {
  const { status, stdout } = runCli(["--all"]);

  assert.equal(status, 0);
  assert.match(stdout, /Memory stats: all projects/);
  assert.match(stdout, /2 entities, 3 observations/);
});

test("an unknown flag exits 2 with the usage line", () => {
  const { status, stderr } = runCli(["--frobnicate"]);

  assert.equal(status, 2);
  assert.match(stderr, /usage: memory-stats/);
});

test("--project without a value exits 2 rather than reading the next flag as the ID", () => {
  const { status, stderr } = runCli(["--project", "--all"]);

  assert.equal(status, 2);
  assert.match(stderr, /usage: memory-stats/);
});

test("a missing store exits 1 without creating one", () => {
  const missing = path.join(os.tmpdir(), `stats-cli-missing-${process.pid}.sqlite`);

  const { status, stderr } = runCli([], { CLAUDE_NEO4J_SQLITE: missing });

  assert.equal(status, 1);
  assert.match(stderr, /no memory store/);
  assert.equal(fs.existsSync(missing), false);
});
