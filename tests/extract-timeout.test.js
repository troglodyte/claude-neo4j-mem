import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Stand-ins for the `claude` binary. Real timeouts are a rare tail event that
// can't be triggered on demand, so the child is faked: the point of these
// tests is that whatever the child managed to say survives the SIGKILL and
// reaches the caller, which is the only thing that makes a timeout in
// capture.log explainable after the fact.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-timeout-"));

function fakeClaude(name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// `exec` so the shell replaces itself with sleep: SIGKILL is delivered to the
// spawned pid, and a bash wrapper would otherwise leave an orphan holding the
// stdio pipes open long after the test asserted.
const NOISY = fakeClaude("noisy-claude", "echo 'API Error: 429 rate limit' >&2\nexec sleep 30");
const SILENT = fakeClaude("silent-claude", "exec sleep 30");

async function rejection(promise) {
  return promise.then(
    () => null,
    (error) => error
  );
}

test("a timed-out extraction reports what the killed child said", async () => {
  process.env.CLAUDE_NEO4J_CAPTURE_CLI = NOISY;
  const { runClaudeExtraction } = await import("../src/lib/extract.js?noisy");

  const error = await rejection(
    runClaudeExtraction({ input: "hi", systemPrompt: "s", schema: {}, timeoutMs: 500 })
  );

  assert.ok(error, "the call must reject on timeout");
  assert.match(error.message, /timed out after 500ms/);
  assert.match(
    error.message,
    /API Error: 429 rate limit/,
    "the child's stderr is the only clue to why it stalled - it must survive the kill"
  );
});

test("a timed-out extraction distinguishes a child that said nothing at all", async () => {
  process.env.CLAUDE_NEO4J_CAPTURE_CLI = SILENT;
  const { runClaudeExtraction } = await import("../src/lib/extract.js?silent");

  const error = await rejection(
    runClaudeExtraction({ input: "hi", systemPrompt: "s", schema: {}, timeoutMs: 500 })
  );

  assert.ok(error, "the call must reject on timeout");
  assert.match(
    error.message,
    /no output/,
    "silence is itself diagnostic: it separates a stalled request from a slow one"
  );
});
