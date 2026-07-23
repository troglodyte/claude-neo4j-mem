import { spawn } from "node:child_process";

// A locked-down, one-shot headless `claude -p` call: no tools, no MCP servers,
// no CLAUDE.md/settings inheritance, no session persisted to disk - it only ever
// gets to return the JSON-schema payload. Shared by auto-capture and the
// subsystem backfill so there is one copy of the spawn/timeout/parse dance
// rather than two that drift.
//
// Headless CLI rather than the Anthropic SDK: it rides on the user's own
// logged-in session, so neither caller needs a separate ANTHROPIC_API_KEY.
const CLAUDE_BIN = process.env.CLAUDE_NEO4J_CAPTURE_CLI ?? "claude";
// Model alias, not a raw ID: passed straight through to `claude --model`.
const DEFAULT_MODEL = process.env.CLAUDE_NEO4J_CAPTURE_MODEL ?? "haiku";

export function runClaudeExtraction({ input, systemPrompt, schema, timeoutMs, model = DEFAULT_MODEL }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--system-prompt",
      systemPrompt,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model",
      model,
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

    child.stdin.write(input);
    child.stdin.end();
  });
}

/** Runs an extraction and unwraps the structured output. */
export async function extractStructured(options) {
  const stdout = await runClaudeExtraction(options);
  const result = JSON.parse(stdout);
  if (result.is_error) {
    throw new Error(`claude extraction error: ${result.result ?? "unknown"}`);
  }
  return result.structured_output ?? JSON.parse(result.result ?? "{}");
}
