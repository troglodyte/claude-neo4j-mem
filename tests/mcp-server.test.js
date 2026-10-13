import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SERVER = fileURLToPath(new URL("../src/mcp/server.js", import.meta.url));

// Starts the memory server in a fresh HOME and speaks MCP to it over stdio as
// Claude Code does, one JSON-RPC message per line; `work` gets a tool caller.
async function withServer(work) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-server-"));
  const store = path.join(home, "memory.sqlite");
  const child = spawn(process.execPath, [SERVER], {
    cwd: home,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, CLAUDE_NEO4J_SQLITE: store },
  });
  const waiting = new Map();
  let buffer = "";
  // A server that dies (a missing dependency, say) must fail the test with its
  // stderr, not leave every pending request waiting for a reply forever.
  let stderr = "";
  let exited = null;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("exit", (code, signal) => {
    exited = new Error(`memory server exited (${signal ?? code}) before replying:\n${stderr}`);
    for (const settle of waiting.values()) {
      settle(exited);
    }
    waiting.clear();
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let lastId = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (exited) {
        reject(exited);
        return;
      }
      lastId += 1;
      waiting.set(lastId, (reply) => (reply instanceof Error ? reject(reply) : resolve(reply)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: lastId, method, params })}\n`);
    });
  const callTool = async (name, args = {}) => {
    const reply = await request("tools/call", { name, arguments: args });
    return JSON.parse(reply.result.content[0].text);
  };
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return await work({ callTool, store });
  } finally {
    child.kill();
  }
}

test("memory_status names the SQLite store it uses", async () => {
  await withServer(async ({ callTool, store }) => {
    const status = await callTool("memory_status");
    assert.equal(status.engine, "sqlite");
    assert.equal(status.path, store);
    assert.equal(status.observationCount, 0);
  });
});

test("an observation written through the server is found by memory_search", async () => {
  await withServer(async ({ callTool }) => {
    await callTool("memory_add_observations", { entity: "decision:storage", observations: ["the quokka store is SQLite"] });
    const found = await callTool("memory_search", { query: "quokka" });
    assert.deepEqual(found.results.map((r) => r.name), ["decision:storage"]);
  });
});
