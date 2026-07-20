import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CONFIG_DIR = path.join(os.homedir(), ".claude-neo4j");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const STATE_DIR = path.join(CONFIG_DIR, "state");

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolution order: env vars > ~/.claude-neo4j/config.json > local Docker defaults.
 * Env vars let per-project .mcp.json / CI overrides win without touching the shared file.
 */
export function loadConnectionConfig() {
  const fileConfig = readConfigFile() ?? {};

  const uri = process.env.NEO4J_URI ?? fileConfig.uri ?? "bolt://localhost:7687";
  const username = process.env.NEO4J_USERNAME ?? fileConfig.username ?? "neo4j";
  const password = process.env.NEO4J_PASSWORD ?? fileConfig.password ?? null;
  const database = process.env.NEO4J_DATABASE ?? fileConfig.database ?? "neo4j";
  const mode = process.env.NEO4J_MODE ?? fileConfig.mode ?? (uri.startsWith("bolt://localhost") || uri.startsWith("bolt://127.0.0.1") ? "local" : "remote");

  if (!password) {
    throw new Error(
      "No Neo4j password configured. Run `npm run configure` in the plugin directory, or set NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD (and optionally NEO4J_DATABASE)."
    );
  }

  return { uri, username, password, database, mode };
}

/**
 * Whether write-tool responses should include a human-readable confirmation
 * for the assistant to relay to the user. Muted via env var (session-scoped)
 * or the config file (persistent, `npm run memory -- mute`/`unmute`).
 */
export function shouldNotifyOnWrite() {
  if (process.env.CLAUDE_NEO4J_QUIET === "1") return false;
  const fileConfig = readConfigFile() ?? {};
  return fileConfig.notifyOnWrite !== false;
}

export function setNotifyOnWrite(enabled) {
  const fileConfig = readConfigFile() ?? {};
  writeConfigFile({ ...fileConfig, notifyOnWrite: enabled });
}

export function isConfigured() {
  try {
    loadConnectionConfig();
    return true;
  } catch {
    return false;
  }
}

export function writeConfigFile(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}
