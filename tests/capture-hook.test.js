import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const CAPTURE_JS = fileURLToPath(new URL("../src/hooks/capture.js", import.meta.url));

// capture.log is the only record the detached worker and the inline PreCompact
// path leave behind, so these drive it through the real hook entry point.
// CONFIG_DIR is derived from os.homedir(), so an isolated $HOME gives each run
// its own log without touching the developer's real one.
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "capture-log-"));
  const transcript = path.join(home, "transcript.jsonl");
  fs.writeFileSync(
    transcript,
    JSON.stringify({
      message: { role: "user", content: "Please remember that the migration runs under Podman now." },
    }) + "\n"
  );
  return { home, transcript, logFile: path.join(home, ".claude-neo4j", "capture.log") };
}

// Unroutable port: verifyConnectivity fails before any extraction or write,
// which is exactly the transient failure the log has to explain.
const UNREACHABLE = {
  NEO4J_URI: "bolt://127.0.0.1:1",
  NEO4J_USERNAME: "neo4j",
  NEO4J_PASSWORD: "not-a-real-password",
};

function runHook(input, { home }, extraEnv = UNREACHABLE) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CAPTURE_JS], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_NEO4J_CAPTURE_INPUT_FILE: "",
        ...extraEnv,
      },
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", () => {});
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

test("a failed PreCompact names the session it lost", async () => {
  const box = sandbox();
  const sessionId = "1f6c9a02-dead-4beef-9999-000000000001";

  await runHook(
    {
      hook_event_name: "PreCompact",
      session_id: sessionId,
      transcript_path: box.transcript,
      cwd: process.cwd(),
    },
    box
  );

  const log = fs.readFileSync(box.logFile, "utf8");
  assert.match(log, /PreCompact: failed/, "the failure must be recorded at all");
  assert.match(
    log,
    new RegExp(sessionId),
    "without the session id the failure can't be tied to a transcript or recovered by hand"
  );
});

test("a failed PreCompact queues itself for the SessionStart sweep", async () => {
  const box = sandbox();
  const sessionId = "1f6c9a02-dead-4beef-9999-000000000002";

  await runHook(
    {
      hook_event_name: "PreCompact",
      session_id: sessionId,
      transcript_path: box.transcript,
      cwd: process.cwd(),
    },
    box
  );

  // Only SessionEnd ever left a pending input behind, so a failed PreCompact
  // had no retry trigger at all: lastLine stays put, but nothing re-runs it.
  // The following SessionEnd re-covers the same range only while it still fits
  // under the 50k x 3 chunk ceiling - and a session long enough to compact is
  // precisely the one that outgrows it, oldest content dropped first.
  const stateDir = path.join(box.home, ".claude-neo4j", "state");
  const pending = (fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []).filter(
    (f) => f.includes(sessionId) && f.endsWith(".pending.json")
  );

  assert.equal(pending.length, 1, "the failed capture must be left where the sweep will find it");
  const queued = JSON.parse(fs.readFileSync(path.join(stateDir, pending[0]), "utf8"));
  assert.equal(queued.transcript_path, box.transcript, "the sweep re-runs from the transcript, so it must be recorded");
});

// --- the success path -------------------------------------------------------
// Needs a reachable Neo4j, so it is skipped rather than failed where there
// isn't one; `npm test` stays runnable on a machine with no container. The
// model is faked (a fixed structured payload) but everything downstream of it
// is real: chunking, the Neo4j writes, and the log line under test.
function realCredentials() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".claude-neo4j", "config.json"), "utf8")
    );
    if (!cfg.password) return null;
    return {
      NEO4J_URI: cfg.uri ?? "bolt://localhost:7687",
      NEO4J_USERNAME: cfg.username ?? "neo4j",
      NEO4J_PASSWORD: cfg.password,
      NEO4J_DATABASE: cfg.database ?? "neo4j",
    };
  } catch {
    return null;
  }
}

const CREDS = realCredentials();

async function neo4jReachable() {
  if (!CREDS) return false;
  Object.assign(process.env, CREDS);
  try {
    const { verifyConnectivity, closeDriver } = await import("../src/lib/neo4jClient.js");
    await verifyConnectivity();
    await closeDriver();
    return true;
  } catch {
    return false;
  }
}

const NEO4J_UP = await neo4jReachable();

test(
  "a successful PreCompact records what it captured",
  { skip: NEO4J_UP ? false : "no reachable Neo4j" },
  async () => {
    const box = sandbox();
    const sessionId = "1f6c9a02-dead-4beef-9999-000000000003";
    const entity = "test:precompact-success-logging";

    // Stands in for `claude -p`: same JSON envelope extractStructured unwraps.
    const fake = path.join(box.home, "fake-claude");
    fs.writeFileSync(
      fake,
      "#!/usr/bin/env bash\ncat >/dev/null\n" +
        `cat <<'JSON'\n${JSON.stringify({
          structured_output: {
            entities: [
              { name: entity, type: "test", observations: [{ text: "throwaway fixture from capture-hook.test.js" }] },
            ],
            relations: [],
          },
        })}\nJSON\n`
    );
    fs.chmodSync(fake, 0o755);

    // cwd with no git remote, so detectProject falls back to this basename and
    // the fixture lands in its own throwaway project scope.
    const project = path.basename(box.home);

    try {
      const { stdout } = await runHook(
        {
          hook_event_name: "PreCompact",
          session_id: sessionId,
          transcript_path: box.transcript,
          cwd: box.home,
        },
        box,
        { ...CREDS, CLAUDE_NEO4J_CAPTURE_CLI: fake }
      );

      // Guards the test against passing vacuously: the systemMessage is only
      // emitted once observations were actually written, so if this holds, the
      // run really did reach the success branch and any missing log line is
      // the defect rather than an early return.
      assert.match(
        stdout,
        /captured 1 new memory observation/,
        "the capture itself must have succeeded for the log assertion to mean anything"
      );

      const log = fs.existsSync(box.logFile) ? fs.readFileSync(box.logFile, "utf8") : "";
      assert.match(
        log,
        /PreCompact: captured 1 observation\(s\)/,
        "a success that leaves no trace is why this path looked unverified for weeks"
      );
      assert.match(log, new RegExp(sessionId), "the success line must name its session too");
    } finally {
      Object.assign(process.env, CREDS);
      const { deleteEntity } = await import("../src/lib/graph.js");
      const { closeDriver } = await import("../src/lib/neo4jClient.js");
      await deleteEntity(entity, project).catch(() => {});
      await closeDriver();
    }
  }
);

test("a retried capture is logged under the hook it actually came from", async () => {
  const box = sandbox();
  const sessionId = "1f6c9a02-dead-4beef-9999-000000000004";
  const stateDir = path.join(box.home, ".claude-neo4j", "state");
  fs.mkdirSync(stateDir, { recursive: true });

  // Pending inputs used to come only from SessionEnd, so the worker's log
  // label was safe to hardcode. PreCompact queues too now, and a retry that
  // reports the wrong hook sends the next reader to the wrong code path.
  const inputFile = path.join(stateDir, `${sessionId}-1.pending.json`);
  fs.writeFileSync(
    inputFile,
    JSON.stringify({
      hook_event_name: "PreCompact",
      session_id: sessionId,
      transcript_path: box.transcript,
      cwd: process.cwd(),
    })
  );

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [CAPTURE_JS], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, HOME: box.home, CLAUDE_NEO4J_CAPTURE_INPUT_FILE: inputFile, ...UNREACHABLE },
    });
    child.on("close", resolve);
  });

  const log = fs.readFileSync(box.logFile, "utf8");
  assert.match(log, new RegExp(sessionId), "the retry must be recorded");
  assert.doesNotMatch(log, /SessionEnd worker/, "this input came from PreCompact, not SessionEnd");
});

test("an unreadable pending input is reported, not silently swallowed", async () => {
  const box = sandbox();
  const stateDir = path.join(box.home, ".claude-neo4j", "state");
  fs.mkdirSync(stateDir, { recursive: true });

  // A truncated write (killed mid-flush, full disk) leaves exactly this. The
  // worker must still say so: main() swallows every throw to keep the hook
  // from failing the session, so anything that escapes here vanishes.
  const inputFile = path.join(stateDir, "broken-1.pending.json");
  fs.writeFileSync(inputFile, '{"session_id": "trunc');

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [CAPTURE_JS], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, HOME: box.home, CLAUDE_NEO4J_CAPTURE_INPUT_FILE: inputFile, ...UNREACHABLE },
    });
    child.on("close", resolve);
  });

  const log = fs.existsSync(box.logFile) ? fs.readFileSync(box.logFile, "utf8") : "";
  assert.match(log, /failed to read input file/, "a corrupt pending input must leave a trace");
});
