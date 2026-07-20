# claude-neo4j — project notes

Claude Code plugin (`neo4j-memory`) giving Claude persistent, graph-based
memory backed by Neo4j. Full architecture/usage docs: `README.md`. Portable
cross-project guardrails: `AGENTS.md` (symlink).

## Current status (as of 2026-07-20)

Fully built and verified end-to-end (Docker container smoke-tested, all Cypher
queries exercised, MCP server driven by a real client, both hooks run with
real stdin, `claude plugin validate` passed, plugin loaded in an actual
headless `claude -p` session with all 8 `memory_*` tools registering).

- **Local Neo4j is running** on this machine via `docker/docker-compose.yml`
  (container `claude-neo4j-memory`, bolt on `7687`, http on `7474`).
  Credentials are in `docker/.env` (gitignored).
- **Plugin is configured**: `~/.claude-neo4j/config.json` points at that local
  container (mode: local).
- **Plugin loads automatically for this repo** — registered via a local
  marketplace in `.claude/settings.json` (`extraKnownMarketplaces` pointing at
  `.claude-plugin/marketplace.json` in this repo + `enabledPlugins:
  {"neo4j-memory@claude-neo4j-local": true}`). Just run `claude` from this
  directory; `--plugin-dir` / `scripts/claude-with-memory.sh` are no longer
  required (kept around as a fallback for loading it from elsewhere).
- **The memory graph now has real dogfooded content** (as of 2026-07-20) —
  this project's own build/debug history (3 entities, 10 observations after a
  dedup pass; see below). Test/smoke-test data is deliberately deleted after
  verification each time, per the existing convention.
- **Auto-capture (`PreCompact`/`SessionEnd` hooks) no longer needs
  `ANTHROPIC_API_KEY`** (changed 2026-07-20) — `src/hooks/capture.js` now
  shells out to a locked-down, one-shot headless `claude -p` call (no tools,
  no MCP servers, no settings/CLAUDE.md inheritance, `--json-schema` for
  structured output) instead of calling the Anthropic SDK directly, mirroring
  how claude-mem avoids requiring a raw API key. It rides on the user's
  existing logged-in `claude` CLI session instead. Opt out with
  `CLAUDE_NEO4J_DISABLE_CAPTURE=1`.
- **`SessionEnd` capture runs detached, `PreCompact` stays synchronous**
  (fixed 2026-07-20) — a real `SessionEnd` firing initially got cancelled by
  Code ("Hook cancelled") because the headless extraction call is slower than
  SessionEnd's process-exit teardown window. `capture.js` now re-spawns
  itself as a detached, unref'd background process for `SessionEnd` (input
  handed off via a temp file in `~/.claude-neo4j/state/`, progress logged to
  `~/.claude-neo4j/capture.log` since stdio is ignored) and returns
  immediately; this mirrors why claude-mem runs extraction in a separate
  worker-daemon process rather than inline in the hook. Verified against a
  real `SessionEnd` firing (not just a piped-in synthetic transcript): 2
  observations captured, no cancellation.
- **Entity identity is now scoped by `(name, project)`, not `name` alone**
  (fixed 2026-07-20) — the original `entity_name_unique` constraint was
  global across every project, so two unrelated repos writing the same entity
  name (e.g. `"user"`) would silently collide: the second writer's facts got
  attached to the first project's node, and the second project couldn't see
  its own writes. Reproduced and confirmed fixed (composite constraint +
  every `MATCH`/`MERGE` in `graph.js` now keys off name+project; verified
  Neo4j Community Edition supports composite uniqueness constraints, just not
  `NODE KEY`). `getEntity`/`deleteObservations`/`deleteEntity`/`searchMemory`
  gained a `project` parameter so by-name lookups resolve deterministically
  (prefers exact-project match, falls back to a global/`project IS NULL`
  entity) instead of matching ambiguously across projects. Also fixed in the
  same pass: `getStatus`'s `observationCount` wasn't project-filtered at all
  (`entityCount` was) — it now joins through `Entity` like the count it sits
  next to. Cleaned up the graph itself: dropped one zero-observation orphan
  stub entity and consolidated 3 overlapping entities describing the same
  plugin/repo (created by different auto-capture runs inventing different
  names) into one canonical `project:claude-neo4j`, cutting 6 entities/31
  observations down to 3/10 with no loss of content.
- Nothing in this repo is committed to git yet (all untracked, by design —
  commits happen only when explicitly requested).

## Useful commands

- `scripts/claude-with-memory.sh` — launch Claude Code with this plugin loaded.
- `scripts/setup-local.sh` — idempotent: starts the local container if needed,
  waits for health, and (re)runs the configure wizard against it.
- `npm run configure` / `node scripts/configure.mjs --mode ... --uri ...` —
  reconfigure or switch between local/remote (e.g. Neo4j Aura) manually.
- `scripts/check-health.sh` — verifies the whole stack end to end (container
  health, config, Neo4j auth, MCP handshake); prints PASS/FAIL per check.
- `npm run memory -- <command>` (or `node scripts/memory-cli.mjs <command>`) —
  query/edit the graph from a terminal, outside a Claude session. Commands:
  `status`, `search`, `recent`, `get`, `add`, `relate`, `timeline`,
  `forget-obs`, `forget`. Run with no args for usage.

## Additional tooling (added 2026-07-17, inspired by claude-mem)

- **CLI** (`scripts/memory-cli.mjs`) — see above.
- **Statusline** (`scripts/statusline.mjs`) — shows `<model> · 🧠 <entities>e/<observations>o`
  in the Claude Code status line, scoped to the current project. Wired via
  `statusLine` in `.claude/settings.local.json` (gitignored, personal). Fails
  open: shows `🧠 offline` if Neo4j is unreachable, never blocks the UI
  (hard-capped at a 1.5s Neo4j lookup).
- **`timeline-report` skill** — narrative history report generated from a new
  `memory_timeline` MCP tool / `graph.getTimeline()` (chronological
  observation dump, optionally since a date). Ask "give me a timeline report"
  / "journey into this project".
- Deliberately skipped: a custom web viewer (Neo4j Browser at
  `http://localhost:7474` already does this) and a background
  daemon/transcript-watcher for continuous capture (would duplicate what the
  `PreCompact`/`SessionEnd` hooks already do now that they no longer need a
  separate API key, see below).

## Likely next steps

- Actually use it in a session or two so `memory_add_observations` /
  auto-capture populate real data, then confirm `SessionStart` injection reads
  back sensibly.
- `SessionEnd` auto-capture is verified against a real hook firing (see
  above). `PreCompact` is only verified with a synthetic transcript piped
  directly into `capture.js` — still needs a real compaction event to confirm
  its synchronous path holds up end-to-end too.
