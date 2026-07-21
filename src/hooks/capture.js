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

// Capture used to read only the last 15k chars of a session. Measured against
// real transcripts that dropped 66% of extractable content (89% for the worst
// session), because PreCompact almost never fires - most sessions end without
// ever compacting, so SessionEnd's single pass was the only pass.
//
// The window is now large enough for a typical session, and longer sessions are
// covered by extracting several windows. Chunks are taken from the END of the
// transcript, so when a session exceeds the ceiling it's the oldest content
// that's dropped, not the most recent.
const CAPTURE_WINDOW_CHARS = Number(process.env.CLAUDE_NEO4J_CAPTURE_WINDOW ?? 50_000);
const MAX_CHUNKS = Number(process.env.CLAUDE_NEO4J_CAPTURE_MAX_CHUNKS ?? 3);
// PreCompact runs inline against a 100s hook timeout, so it gets one window;
// only the detached SessionEnd worker can afford to chunk.
const PRECOMPACT_MAX_CHUNKS = 1;
// A transient failure (Neo4j restarting, a timed-out extraction) shouldn't cost
// a session its memory, so failed inputs are kept for a later attempt instead
// of being deleted.
const MAX_CAPTURE_ATTEMPTS = 3;
// A pending input younger than this may still belong to a worker that's mid-run;
// only sweep ones old enough that no in-flight worker could still hold them.
const RETRY_AFTER_MS = 10 * 60 * 1000;
const STATE_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Model alias, not a raw ID: passed straight through to `claude --model`.
const CAPTURE_MODEL = process.env.CLAUDE_NEO4J_CAPTURE_MODEL ?? "haiku";
// Headless Claude Code CLI, not the Anthropic SDK: rides on the user's own
// logged-in session (OAuth/subscription), so auto-capture doesn't need a
// separate ANTHROPIC_API_KEY. Same trick claude-mem uses.
const CLAUDE_BIN = process.env.CLAUDE_NEO4J_CAPTURE_CLI ?? "claude";
// Extraction measures ~11s for a full 50k-char window, so these are outlier
// headroom rather than expected duration: observed timeouts came from
// contention, not from the size of the input. The detached worker answers to
// nobody and can wait; the inline PreCompact path must finish inside the hook's
// 100s timeout or Claude Code cancels it.
const CAPTURE_TIMEOUT_MS = Number(process.env.CLAUDE_NEO4J_CAPTURE_TIMEOUT_MS ?? 180_000);
const PRECOMPACT_TIMEOUT_MS = 80_000;

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
function runClaudeExtraction(transcriptText, systemPrompt, timeoutMs = CAPTURE_TIMEOUT_MS) {
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
      reject(new Error(`claude extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

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

async function extractMemories(transcriptText, knownNames, timeoutMs) {
  const stdout = await runClaudeExtraction(transcriptText, buildExtractionSystemPrompt(knownNames), timeoutMs);
  const result = JSON.parse(stdout);
  if (result.is_error) {
    throw new Error(`claude extraction error: ${result.result ?? "unknown"}`);
  }
  const structured = result.structured_output ?? JSON.parse(result.result ?? "{}");
  return { entities: structured.entities ?? [], relations: structured.relations ?? [] };
}

/**
 * Splits transcript text into at most maxChunks windows, keeping the most
 * recent content when the transcript exceeds what we're willing to extract.
 * Returns chunks oldest-first so extraction reads the session in order.
 */
function chunkTranscript(text, windowChars, maxChunks) {
  const chunks = [];
  for (let end = text.length; end > 0 && chunks.length < maxChunks; end -= windowChars) {
    chunks.unshift(text.slice(Math.max(0, end - windowChars), end));
  }
  const covered = chunks.reduce((sum, c) => sum + c.length, 0);
  return { chunks, covered, dropped: text.length - covered };
}

// Entities recur across chunks of the same session, so merge rather than
// issuing a separate write per chunk for the same entity.
function mergeMemories(results) {
  const entities = new Map();
  const relations = new Map();
  for (const result of results) {
    for (const entity of result.entities ?? []) {
      if (!entity?.name || !entity.observations?.length) continue;
      const existing = entities.get(entity.name);
      if (existing) existing.observations.push(...entity.observations);
      else entities.set(entity.name, { ...entity, observations: [...entity.observations] });
    }
    for (const relation of result.relations ?? []) {
      if (!relation?.from || !relation.to || !relation.type) continue;
      relations.set(`${relation.from}|${relation.type}|${relation.to}`, relation);
    }
  }
  return { entities: [...entities.values()], relations: [...relations.values()] };
}

// Does the actual capture: read new transcript text, extract memories via a
// headless claude call, write them to Neo4j. Shared by the synchronous
// PreCompact path and the detached SessionEnd worker.
async function runCapture({ sessionId, transcriptPath, cwd, maxChunks = MAX_CHUNKS, timeoutMs = CAPTURE_TIMEOUT_MS }) {
  await verifyConnectivity();

  const state = readState(sessionId);
  const { text, totalLines } = readNewTranscriptText(transcriptPath, state.lastLine);

  if (totalLines <= state.lastLine || text.trim().length < 40) {
    return { added: 0 };
  }

  await ensureSchema();

  const project = detectProject(cwd);
  const knownNames = await listEntityNames(project);
  const { chunks, covered, dropped } = chunkTranscript(text, CAPTURE_WINDOW_CHARS, maxChunks);
  if (dropped > 0) {
    log(
      `session ${sessionId}: transcript is ${text.length} chars; extracting the most recent ${covered} ` +
        `across ${chunks.length} chunk(s), dropping ${dropped} older chars ` +
        `(raise CLAUDE_NEO4J_CAPTURE_WINDOW or CLAUDE_NEO4J_CAPTURE_MAX_CHUNKS to cover more)`
    );
  }

  const extracted = [];
  for (const chunk of chunks) {
    extracted.push(await extractMemories(chunk, knownNames, timeoutMs));
  }
  const memories = mergeMemories(extracted);

  // Fetched once for the whole capture; names created along the way are added
  // so later entities still dedup against entities this same capture created.
  const seenNames = [...knownNames];
  let added = 0;
  for (const entity of memories.entities) {
    await addObservations({
      entity: entity.name,
      entityType: entity.type,
      observations: entity.observations,
      sessionId,
      project,
      existingNames: seenNames,
    });
    seenNames.push(entity.name);
    added += entity.observations.length;
  }
  for (const relation of memories.relations) {
    await createRelation({ from: relation.from, to: relation.to, type: relation.type, project });
  }

  writeState(sessionId, { lastLine: totalLines });
  recordCapture(project, added);
  return { added, project, chunks: chunks.length, dropped };
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
  const attempt = (input.captureAttempt ?? 0) + 1;
  try {
    const { added, chunks, dropped } = await runCapture({ sessionId, transcriptPath, cwd });
    log(
      `SessionEnd worker: captured ${added} observation(s) for session ${sessionId} ` +
        `(${chunks} chunk(s)${dropped ? `, ${dropped} chars dropped` : ""}${attempt > 1 ? `, attempt ${attempt}` : ""})`
    );
    removeInput(inputFile);
  } catch (error) {
    // Deleting the input here is what used to make a transient failure
    // permanent: lastLine only advances on success, so the work is still
    // retryable - but only if its input survives. Keep it for the SessionStart
    // sweep until we've genuinely given up.
    if (attempt >= MAX_CAPTURE_ATTEMPTS) {
      log(`SessionEnd worker: capture failed for session ${sessionId} after ${attempt} attempt(s), giving up: ${error.message}`);
      removeInput(inputFile);
    } else {
      log(`SessionEnd worker: capture failed for session ${sessionId} (attempt ${attempt}, will retry): ${error.message}`);
      try {
        fs.writeFileSync(inputFile, JSON.stringify({ ...input, captureAttempt: attempt }));
      } catch {
        // if we can't record the attempt, leave the file as-is; it still retries
      }
    }
  } finally {
    await closeDriver();
  }
}

function removeInput(inputFile) {
  try {
    fs.unlinkSync(inputFile);
  } catch {
    // best-effort cleanup
  }
}

/**
 * Re-launches captures whose worker died before finishing. Called from
 * SessionStart because a failed capture has no other trigger - the session it
 * belonged to is already over. Transcripts stay on disk, so a capture that
 * failed days ago still works when it eventually runs.
 *
 * Returns the number retried so the caller can tell the user memory was
 * recovered rather than silently missing.
 */
export function sweepPendingCaptures({ now = Date.now() } = {}) {
  let retried = 0;
  let files;
  try {
    files = fs.readdirSync(STATE_DIR);
  } catch {
    return 0;
  }

  for (const file of files) {
    if (!file.endsWith(".sessionend.json")) continue;
    const inputFile = path.join(STATE_DIR, file);
    try {
      // Age gate: a fresh file probably belongs to a worker still running, and
      // relaunching it would double-write the same observations.
      if (now - fs.statSync(inputFile).mtimeMs < RETRY_AFTER_MS) continue;
      const input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
      if (!fs.existsSync(input.transcript_path ?? "")) {
        log(`sweep: dropping ${file}, its transcript is gone`);
        removeInput(inputFile);
        continue;
      }
      const child = spawn(process.execPath, [SCRIPT_PATH], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [INPUT_FILE_ENV]: inputFile },
      });
      child.unref();
      log(`sweep: retrying capture for session ${input.session_id} (pid=${child.pid})`);
      retried++;
    } catch (error) {
      log(`sweep: could not retry ${file}: ${error.message}`);
    }
  }
  return retried;
}

/** Drops per-session lastLine trackers long past any use; they never expired. */
export function pruneStaleState({ now = Date.now() } = {}) {
  try {
    for (const file of fs.readdirSync(STATE_DIR)) {
      if (!file.endsWith(".json") || file.endsWith(".sessionend.json")) continue;
      const full = path.join(STATE_DIR, file);
      if (now - fs.statSync(full).mtimeMs > STATE_FILE_TTL_MS) fs.unlinkSync(full);
    }
  } catch {
    // best-effort housekeeping
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
    // Inline path, bounded by the hook's 100s timeout, so one window only.
    const { added } = await runCapture({
      sessionId,
      transcriptPath,
      cwd,
      maxChunks: PRECOMPACT_MAX_CHUNKS,
      timeoutMs: PRECOMPACT_TIMEOUT_MS,
    });

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

// session-start.js imports sweepPendingCaptures/pruneStaleState from here, so
// the hook body must only run when this file is the process entry point -
// otherwise importing it would fire a capture.
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(() => process.exit(0));
}
