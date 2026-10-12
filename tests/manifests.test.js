import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

// Every memory process starts through the launcher, invoked as `bash <launcher>`
// so a checkout or snapshot copy that lost the executable bit still runs.
test("every hook command starts its script through bash bin/memory-node --hook", () => {
  const { hooks } = read("hooks/hooks.json");
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.ok(commands.length >= 3);
  for (const command of commands) {
    assert.match(command, /^bash "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/memory-node" --hook "\$\{CLAUDE_PLUGIN_ROOT\}\/src\/hooks\/[a-z-]+\.js"$/);
  }
});

test("the MCP server starts through bash bin/memory-node", () => {
  const server = read(".mcp.json").mcpServers["neo4j-memory"];
  assert.equal(server.command, "bash");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/bin/memory-node", "${CLAUDE_PLUGIN_ROOT}/src/mcp/server.js"]);
});
