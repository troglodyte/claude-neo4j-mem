# claude-neo4j — project notes

Claude Code plugin (`neo4j-memory`) giving Claude persistent, graph-based
memory backed by Neo4j. Full architecture/usage docs: `README.md`. Portable
cross-project guardrails: `AGENTS.md` (symlink).

## Current status (as of 2026-07-17)

Fully built and verified end-to-end (Docker container smoke-tested, all Cypher
queries exercised, MCP server driven by a real client, both hooks run with
real stdin, `claude plugin validate` passed, plugin loaded in an actual
headless `claude -p` session with all 8 `memory_*` tools registering).

- **Local Neo4j is running** on this machine via `docker/docker-compose.yml`
  (container `claude-neo4j-memory`, bolt on `7687`, http on `7474`).
  Credentials are in `docker/.env` (gitignored).
- **Plugin is configured**: `~/.claude-neo4j/config.json` points at that local
  container (mode: local).
- **Plugin is NOT yet loaded persistently** — it only attaches when Claude
  Code is started with `--plugin-dir`. Use `scripts/claude-with-memory.sh` to
  launch that way without retyping the flag. There's no permanent
  install/marketplace registration yet.
- **The memory graph is essentially empty** — earlier smoke-test data was
  deliberately deleted after verification, so `memory_recent` / the
  `SessionStart` context injection won't have much to show until the plugin
  is actually used in real sessions.
- **Auto-capture (`PreCompact`/`SessionEnd` hooks) is untested against a real
  `ANTHROPIC_API_KEY`** — verified only that it degrades gracefully with no
  key and with an invalid key. If `ANTHROPIC_API_KEY` isn't set in the
  environment Claude Code runs in, auto-capture silently no-ops; memory then
  only grows via explicit `memory_add_observations` tool calls.
- Nothing in this repo is committed to git yet (all untracked, by design —
  commits happen only when explicitly requested).

## Useful commands

- `scripts/claude-with-memory.sh` — launch Claude Code with this plugin loaded.
- `scripts/setup-local.sh` — idempotent: starts the local container if needed,
  waits for health, and (re)runs the configure wizard against it.
- `npm run configure` / `node scripts/configure.mjs --mode ... --uri ...` —
  reconfigure or switch between local/remote (e.g. Neo4j Aura) manually.

## Likely next steps

- Actually use it in a session or two so `memory_add_observations` /
  auto-capture populate real data, then confirm `SessionStart` injection reads
  back sensibly.
- Decide whether to register the plugin for automatic loading (skip
  `--plugin-dir`) — e.g. via a local marketplace entry or `claude plugin init`
  — instead of always launching through the wrapper script.
- If auto-capture is wanted, export `ANTHROPIC_API_KEY` in the environment
  Claude Code runs in and do a real end-to-end capture test (currently only
  the failure/degradation paths are verified).
