import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SESSION_START = fileURLToPath(new URL("../src/hooks/session-start.js", import.meta.url));

// Runs the hook as Claude Code does: JSON in on stdin, JSON out on stdout. HOME
// is a fresh directory, so no real config, store or capture state is touched.
function runSessionStart(env = {}, prepare = () => {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-"));
  prepare(home);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SESSION_START], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, HOME: home, CLAUDE_NEO4J_SQLITE: path.join(home, "memory.sqlite"), ...env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", () => resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ session_id: "session-start-test", cwd: home }));
  });
}

test("a first session opens an empty store and says nothing is remembered yet", async () => {
  const out = await runSessionStart();
  assert.match(out.systemMessage, /Memory: nothing remembered yet/);
  assert.match(out.hookSpecificOutput.additionalContext, /^## Memory \(/);
});

test("a store that cannot be opened is reported, not fatal", async () => {
  const out = await runSessionStart({ CLAUDE_NEO4J_SQLITE: "/dev/null/memory.sqlite" });
  assert.match(out.systemMessage, /Memory: unavailable/);
});

test("a machine with a Neo4j config but Neo4j down keeps memory off and creates no store", async () => {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  let store;
  // NEO4J_URI is pinned too, so a URI in the developer's own environment cannot point the probe at a live graph.
  const out = await runSessionStart({ NEO4J_URI: `bolt://127.0.0.1:${port}` }, (home) => {
    store = path.join(home, "memory.sqlite");
    fs.mkdirSync(path.join(home, ".claude-neo4j"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude-neo4j", "config.json"), JSON.stringify({ password: "x", uri: `bolt://127.0.0.1:${port}` }));
  });
  assert.match(out.systemMessage, /Memory: off — Neo4j is not running/);
  assert.equal(fs.existsSync(store), false);
});

test("claude-mem history no longer prompts an import that cannot reach the SQLite store", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const out = await runSessionStart({}, (home) => {
    fs.mkdirSync(path.join(home, ".claude-mem"), { recursive: true });
    const db = new DatabaseSync(path.join(home, ".claude-mem", "claude-mem.db"));
    db.exec("CREATE TABLE observations (project TEXT); CREATE TABLE session_summaries (project TEXT);");
    db.prepare("INSERT INTO observations (project) VALUES (?)").run(path.basename(home));
    db.close();
  });
  assert.doesNotMatch(out.systemMessage, /migrate-claude-mem/);
});
