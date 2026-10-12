import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs, withoutCredentials } from "../src/lib/migrate/cli.js";

const DEFAULT_OUT = "/home/someone/.claude-neo4j/memory.sqlite";

test("credentials in a connection URI are dropped from what is printed and stored", () => {
  assert.equal(withoutCredentials("bolt://neo4j:s3cret@db.example.com:7687"), "bolt://db.example.com:7687");
  assert.equal(withoutCredentials("neo4j+s://user@abc.databases.neo4j.io"), "neo4j+s://abc.databases.neo4j.io");
  assert.equal(withoutCredentials("bolt://localhost:7687"), "bolt://localhost:7687");
});

test("relative paths resolve against the directory the command was run from", () => {
  const { flags } = parseArgs(["--out", "copy/memory.sqlite", "--report", "r.json"], { cwd: "/work/repo", defaultOut: DEFAULT_OUT });
  assert.equal(flags.out, path.join("/work/repo", "copy/memory.sqlite"));
  assert.equal(flags.report, path.join("/work/repo", "r.json"));
});

test("with no flags the default target is used", () => {
  const { flags } = parseArgs([], { cwd: "/work/repo", defaultOut: DEFAULT_OUT });
  assert.deepEqual(flags, { out: DEFAULT_OUT, checkOnly: false, report: undefined });
});

test("an unknown or incomplete flag is an error carrying the usage line", () => {
  assert.match(parseArgs(["--frobnicate"], { cwd: "/", defaultOut: DEFAULT_OUT }).error, /usage: migrate-to-sqlite/);
  assert.match(parseArgs(["--out"], { cwd: "/", defaultOut: DEFAULT_OUT }).error, /usage: migrate-to-sqlite/);
});
