#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureSchema } from "../lib/schema.js";
import { detectProject } from "../lib/project.js";
import { addObservations, createRelation, listEntityNames } from "../lib/graph.js";
import { closeDriver, verifyConnectivity } from "../lib/neo4jClient.js";
import { isConfigured, CONFIG_DIR, STATE_DIR, ensureStateDir } from "../lib/config.js";
import { recordCapture } from "../lib/captureDigest.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const LOG_FILE = path.join(CONFIG_DIR, "capture.log");
// Presence of this env var means "I am the detached SessionEnd worker" - it
// carries the path to the hook input file instead of reading stdin.
const INPUT_FILE_ENV = "CLAUDE_NEO4J_CAPTURE_INPUT_FILE";

const MAX_CHARS = 15000;
// Model alias, not a raw ID: passed straight through to `claude --model`.
const CAPTURE_MODEL = process.env.CLAUDE_NEO4J_CAPTURE_MODEL ?? "haiku";
// Headless Claude Code CLI, not the Anthropic SDK: rides on the user's own
// logged-in session (OAuth/subscription), so auto-capture doesn't need a
// separate ANTHROPIC_API_KEY. Same trick claude-mem uses.
const CLAUDE_BIN = process.env.CLAUDE_NEO4J_CAPTURE_CLI ?? "claude";
const CAPTURE_TIMEOUT_MS = 90_000;

function buildExtractionSystemPrompt(knownNames) {
  const base = `You extract durable, worth-remembering facts from a slice of a coding-assistant conversation transcript.
Respond with JSON matching the given schema:
- entities: distinct people, projects, decisions, or preferences/conventions mentioned, each as {name, type, observations}. Use short stable names (e.g. "user", "decision:auth-approach", "preference:testing", "project:<repo>"). Only include observations that would still be useful in a future, unrelated session - skip step-by-step task narration, file paths, or anything ephemeral to this one task.
- relations: {from, to, type} triples linking entities, e.g. {from: "project:claude-neo4j", type: "uses", to: "neo4j-driver"}.
If nothing is worth remembering, respond with empty arrays for both.`;
  if (!knownNames.length) return base;
  return (
    base +
    `\n\nThese entity names already exist in memory for this project - if a fact in this transcript is about ` +
    `one of them, reuse the exact existing name below instead of inventing a new one (e.g. don't create ` +
    `"plugin:foo" if "project:foo" already refers to the same thing):\n${knownNames.map((n) => `- ${n}`).join("\n")}`
  );
}

const RECORD_MEMORIES_SCHEMA = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          observations: { type: "array", items: { type: "string" } },
        },
        required: ["name", "observations"],
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          type: { type: "string" },
        },
        required: ["from", "to", "type"],
      },
    },
  },
  required: ["entities", "relations"],
};

// The detached SessionEnd worker has no attached stdout/stderr (stdio:
// "ignore"), so this file is the only way to see what it did.
function log(message) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // best-effort logging only
  }
}

function stateFilePath(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(sessionId), "utf8"));
  } catch {
    return { lastLine: 0 };
  }
}

function writeState(sessionId, state) {
  ensureStateDir();
  fs.writeFileSync(stateFilePath(sessionId), JSON.stringify(state));
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[used tool ${block.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

function readNewTranscriptText(transcriptPath, lastLine) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const newLines = lines.slice(lastLine);
  const turns = [];
  for (const line of newLines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry?.message?.role;
    const content = entry?.message?.content;
    if (!role || !content) continue;
    const text = extractText(content);
    if (text) turns.push(`${role}: ${text}`);
  }
  return { text: turns.join("\n\n"), totalLines: lines.length };
}

// Runs the extraction as a locked-down, one-shot headless `claude -p` call:
// no tools, no MCP servers, no CLAUDE.md/settings inheritance, no session
// persisted to disk - it only ever gets to return the JSON schema payload.
function runClaudeExtraction(transcriptText, systemPrompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--system-prompt",
      systemPrompt,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(RECORD_MEMORIES_SCHEMA),
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model",
      CAPTURE_MODEL,
    ];

    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude extraction timed out after ${CAPTURE_TIMEOUT_MS}ms`));
    }, CAPTURE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(transcriptText);
    child.stdin.end();
  });
}

async function extractMemories(transcriptText, knownNames) {
  const stdout = await runClaudeExtraction(transcriptText, buildExtractionSystemPrompt(knownNames));
  const result = JSON.parse(stdout);
  if (result.is_error) {
    throw new Error(`claude extraction error: ${result.result ?? "unknown"}`);
  }
  const structured = result.structured_output ?? JSON.parse(result.result ?? "{}");
  return { entities: structured.entities ?? [], relations: structured.relations ?? [] };
}

// Does the actual capture: read new transcript text, extract memories via a
// headless claude call, write them to Neo4j. Shared by the synchronous
// PreCompact path and the detached SessionEnd worker.
async function runCapture({ sessionId, transcriptPath, cwd }) {
  await verifyConnectivity();

  const state = readState(sessionId);
  const { text, totalLines } = readNewTranscriptText(transcriptPath, state.lastLine);

  if (totalLines <= state.lastLine || text.trim().length < 40) {
    return { added: 0 };
  }

  await ensureSchema();

  const project = detectProject(cwd);
  const knownNames = await listEntityNames(project);
  const memories = await extractMemories(text.slice(-MAX_CHARS), knownNames);

  let added = 0;
  for (const entity of memories.entities ?? []) {
    if (!entity.observations?.length) continue;
    await addObservations({
      entity: entity.name,
      entityType: entity.type,
      observations: entity.observations,
      sessionId,
      project,
    });
    added += entity.observations.length;
  }
  for (const relation of memories.relations ?? []) {
    if (!relation.from || !relation.to || !relation.type) continue;
    await createRelation({ from: relation.from, to: relation.to, type: relation.type, project });
  }

  writeState(sessionId, { lastLine: totalLines });
  recordCapture(project, added);
  return { added, project };
}

// SessionEnd fires while Claude Code is tearing the process down, with a
// grace window shorter than a headless `claude -p` extraction call takes -
// verified empirically ("Hook cancelled" every time it ran inline). Detach
// the real work into an independent background process (the same fix
// claude-mem's worker-daemon pattern gets for free) so the hook itself
// returns before teardown cancels it, and extraction finishes on its own
// time, decoupled from this process's lifetime.
function detachSessionEndCapture(input) {
  ensureStateDir();
  const inputFile = path.join(STATE_DIR, `${input.session_id}-${Date.now()}.sessionend.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));

  const child = spawn(process.execPath, [SCRIPT_PATH], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [INPUT_FILE_ENV]: inputFile },
  });
  child.unref();
  log(`SessionEnd: detached background capture pid=${child.pid} for session ${input.session_id}`);
}

async function runDetachedWorker(inputFile) {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  } catch (error) {
    log(`SessionEnd worker: failed to read input file ${inputFile}: ${error.message}`);
    return;
  }

  const { session_id: sessionId, transcript_path: transcriptPath, cwd } = input;
  try {
    const { added } = await runCapture({ sessionId, transcriptPath, cwd });
    log(`SessionEnd worker: captured ${added} observation(s) for session ${sessionId}`);
  } catch (error) {
    log(`SessionEnd worker: capture failed for session ${sessionId}: ${error.message}`);
  } finally {
    await closeDriver();
    try {
      fs.unlinkSync(inputFile);
    } catch {
      // best-effort cleanup
    }
  }
}

async function main() {
  const inputFile = process.env[INPUT_FILE_ENV];
  if (inputFile) {
    await runDetachedWorker(inputFile);
    return;
  }

  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const { session_id: sessionId, transcript_path: transcriptPath, cwd, hook_event_name: eventName } = input;

  if (!isConfigured() || process.env.CLAUDE_NEO4J_DISABLE_CAPTURE || !sessionId || !transcriptPath) {
    process.stdout.write("{}");
    return;
  }

  if (!fs.existsSync(transcriptPath)) {
    process.stdout.write("{}");
    return;
  }

  if (eventName === "SessionEnd") {
    try {
      detachSessionEndCapture(input);
    } catch (error) {
      log(`SessionEnd: failed to detach background capture: ${error.message}`);
    }
    process.stdout.write("{}");
    return;
  }

  try {
    const { added } = await runCapture({ sessionId, transcriptPath, cwd });

    if (eventName === "PreCompact" && added > 0) {
      process.stdout.write(
        JSON.stringify({
          systemMessage: `\u{1f9e0} claude-neo4j: captured ${added} new memory observation(s) before compaction.`,
        })
      );
    } else {
      process.stdout.write("{}");
    }
  } catch (error) {
    process.stderr.write(`claude-neo4j: capture failed: ${error.message}\n`);
    log(`${eventName ?? "capture"}: failed: ${error.message}`);
    process.stdout.write("{}");
  } finally {
    await closeDriver();
  }
}

main().catch(() => process.exit(0));
