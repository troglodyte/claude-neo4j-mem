#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ensureSchema } from "../lib/schema.js";
import { detectProject } from "../lib/project.js";
import { addObservations, createRelation } from "../lib/graph.js";
import { closeDriver, verifyConnectivity } from "../lib/neo4jClient.js";
import { isConfigured, STATE_DIR, ensureStateDir } from "../lib/config.js";

const MAX_CHARS = 15000;
const CAPTURE_MODEL = process.env.CLAUDE_NEO4J_CAPTURE_MODEL ?? "claude-haiku-4-5-20251001";

const EXTRACTION_SYSTEM_PROMPT = `You extract durable, worth-remembering facts from a slice of a coding-assistant conversation transcript.
Call record_memories exactly once with:
- entities: distinct people, projects, decisions, or preferences/conventions mentioned, each as {name, type, observations}. Use short stable names (e.g. "user", "decision:auth-approach", "preference:testing", "project:<repo>"). Only include observations that would still be useful in a future, unrelated session - skip step-by-step task narration, file paths, or anything ephemeral to this one task.
- relations: {from, to, type} triples linking entities, e.g. {from: "project:claude-neo4j", type: "uses", to: "neo4j-driver"}.
If nothing is worth remembering, call record_memories with empty arrays for both.`;

const RECORD_MEMORIES_TOOL = {
  name: "record_memories",
  description: "Record durable facts extracted from the conversation into the memory graph.",
  input_schema: {
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
  },
};

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

async function extractMemories(transcriptText) {
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: CAPTURE_MODEL,
    max_tokens: 1024,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: transcriptText }],
    tools: [RECORD_MEMORIES_TOOL],
    tool_choice: { type: "tool", name: "record_memories" },
  });
  const toolUse = response.content.find((block) => block.type === "tool_use" && block.name === "record_memories");
  return toolUse?.input ?? { entities: [], relations: [] };
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const { session_id: sessionId, transcript_path: transcriptPath, cwd, hook_event_name: eventName } = input;

  if (!isConfigured() || !process.env.ANTHROPIC_API_KEY || !sessionId || !transcriptPath) {
    process.stdout.write("{}");
    return;
  }

  if (!fs.existsSync(transcriptPath)) {
    process.stdout.write("{}");
    return;
  }

  try {
    await verifyConnectivity();

    const state = readState(sessionId);
    const { text, totalLines } = readNewTranscriptText(transcriptPath, state.lastLine);

    if (totalLines <= state.lastLine || text.trim().length < 40) {
      process.stdout.write("{}");
      return;
    }

    await ensureSchema();

    const project = detectProject(cwd);
    const memories = await extractMemories(text.slice(-MAX_CHARS));

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

    if (eventName === "PreCompact") {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreCompact",
            additionalContext:
              added > 0 ? `claude-neo4j: captured ${added} new memory observation(s) before compaction.` : "",
          },
        })
      );
    } else {
      process.stdout.write("{}");
    }
  } catch (error) {
    process.stderr.write(`claude-neo4j: capture failed: ${error.message}\n`);
    process.stdout.write("{}");
  } finally {
    await closeDriver();
  }
}

main().catch(() => process.exit(0));
