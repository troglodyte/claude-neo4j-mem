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
function runSessionStart(env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-"));
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
