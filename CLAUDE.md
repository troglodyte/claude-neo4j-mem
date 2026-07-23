# claude-neo4j — project notes

Claude Code plugin (`neo4j-memory`) giving Claude persistent, graph-based
memory backed by Neo4j. Architecture and usage: `README.md`. Per-release
detail: `CHANGELOG.md`. Portable cross-project guardrails: `AGENTS.md`
(symlink). This file keeps only what those three, the code, and git history
can't tell you — the traps.

## Environment

- **Local Neo4j runs on this machine** via `docker/docker-compose.yml`
  (container `claude-neo4j-memory`, bolt `7687`, http `7474`). Credentials
  live in `docker/.env` (gitignored).
- **Plugin config**: `~/.claude-neo4j/config.json`, pointed at that container
  (mode: local).
- `origin` is `git@github.com:troglodyte/claude-neo4j-mem.git`; `main` tracks
  it. Commits happen only when explicitly requested.
- **Never record a SHA or a graph size in this file.** Both went stale within
  a day every time they were written here, and a stale number stated as
  current is worse than no claim. Run `git status -sb` and `npm run usage`;
  they are always right.
- Test and smoke-test data is deleted after verification, every time.

## Use `scripts/claude-with-memory.sh` to work on this repo

A bare `claude` here loads **no memory plugin at all**, and the only symptom
is a missing `SessionStart` banner — the session otherwise looks completely
normal. Several ran that way before it was noticed.

- A **marketplace install is a snapshot copy** under `~/.claude/plugins/cache/…`,
  pinned to a git SHA. It never tracks the working tree, whether it came from
  GitHub or from a `directory` source, so local edits stay invisible to it
  until it is reinstalled.
- **`--plugin-dir` is the only live mechanism.** `plugin.json`/`.mcp.json`
  resolve `${CLAUDE_PLUGIN_ROOT}`, so pointing it at this repo runs the
  working tree. `claude-with-memory.sh` derives that path from its own
  location, which is why nothing here hardcodes a path.
- **A bad `--plugin-dir` starts a memory-less session silently.** Claude Code
  accepts `--plugin-dir /` with no error or warning. The launcher used to
  degrade to exactly that: `cd "$(dirname X)/.."` collapses to `cd /..` → `/`
  whenever the inner substitution yields nothing, and `set -euo pipefail`
  cannot catch it — the substitution swallows the inner failure and `cd /`
  then succeeds. All five `scripts/*.sh` now resolve in two steps and assert
  the resolved root contains `.claude-plugin/plugin.json`, refusing to run
  otherwise; `npm test` (`tests/launcher-path.test.sh`) fails against the old
  form.
- To check a *running* session: `tr '\0' ' ' < /proc/<pid>/cmdline` shows the
  real argv, and `pgrep -P <pid>` should list an `src/mcp/server.js` child. If
  it doesn't, the plugin never loaded. Per-session MCP logs are in
  `~/.cache/claude-cli-nodejs/<escaped-cwd>/mcp-logs-plugin-neo4j-memory-neo4j-memory/`.
- `~/.claude/settings.json` (user scope) registers the *same marketplace name*
  `claude-neo4j-local` from **GitHub** with `autoUpdate: true`, and user scope
  wins over the project-level entry — which is how a stale snapshot silently
  shadowed local work here. `.claude/settings.json` therefore just **disables**
  that installed copy for this repo, leaving the `--plugin-dir` copy as the
  only one loaded so no second MCP server registers under the same name. It
  deliberately contains no paths: a `directory` marketplace source is
  normalized to an absolute path (`./` is accepted then rewritten; `.` and
  `${CLAUDE_PROJECT_DIR}` are rejected outright), so it can never be portable.
- Verify with `claude plugin list`: inside this repo it should read
  `disabled`; outside it, `enabled`.

## Useful commands

- `scripts/claude-with-memory.sh` — launch Claude Code with this plugin loaded.
- `npm test` — `node --test` plus the guard that keeps `scripts/*.sh` from
  silently resolving the plugin directory to `/` (see above).
- `scripts/setup-local.sh` — idempotent: starts the local container if needed,
  waits for health, and (re)runs the configure wizard against it.
- `npm run configure` / `node scripts/configure.mjs --mode ... --uri ...` —
  reconfigure or switch between local/remote (e.g. Neo4j Aura) manually.
- `scripts/check-health.sh` — verifies the whole stack end to end (container
  health, config, Neo4j auth, MCP handshake); prints PASS/FAIL per check.
- `npm run usage` (or `scripts/memory-usage.sh`) — cross-project usage report:
  every project in the db with entity/observation counts, first-seen, obs in
  last 7 days, last activity, plus totals and hygiene warnings (duplicate
  project names, oversized entities, empty stubs, expensive subsystem maps).
  `--quiet` for table only.
- `npm run token-cost [-- --all]` — measures every read path against a
  per-call ceiling and exits non-zero on regression.
- `npm run backup` / `npm run restore -- --latest` — snapshot and reinstate the
  whole database via `neo4j-admin database dump`/`load`, run in a sibling
  container against the stopped container's volume (`--volumes-from`). Local
  mode only; both stop and restart the container, via a trap that fires on
  failure and Ctrl-C too. `--keep N` prunes old backups, `--info` inspects an
  archive, restore requires typing the database name unless `--force`.
  **Compression is deliberately off**: the `.dump` is already zstd-compressed,
  and xz measured 0.9% on the real graph — `--xz` exists but is near-pointless.
  Each backup gets a `.sha256` sidecar because `load --info` reads only the
  archive header and passes a truncated dump as valid (verified). Shared
  plumbing is in `scripts/lib-backup.sh`.
- `scripts/cypher.sh "<query>"` — run arbitrary Cypher. Resolves credentials
  automatically and borrows `cypher-shell` from inside the container in local
  mode, so **no install is needed**; only remote-mode hosts need the binary.
- `npm run memory -- <command>` (or `node scripts/memory-cli.mjs <command>`) —
  query/edit the graph from a terminal, outside a Claude session. Commands:
  `status`, `search`, `recent`, `get`, `add`, `relate`, `timeline`,
  `forget-obs`, `forget`. Run with no args for usage.
- `npm run backfill-subsystems` — tag pre-existing observations.
- `scripts/statusline.mjs` — shows `<model> · 🧠 <entities>e/<observations>o`,
  scoped to the current project. Wired via `statusLine` in
  `.claude/settings.local.json` (gitignored, personal), which is why it isn't
  visible in the repo. Fails open to `🧠 offline`, hard-capped at a 1.5s
  lookup, never blocks the UI.

## Design decisions and traps

- **Entity identity is `(name, project)`, never `name` alone.** A global
  unique constraint let two unrelated repos writing `"user"` collide silently:
  the second writer's facts attached to the first project's node, and the
  second project couldn't see its own writes. Every `MATCH`/`MERGE` in
  `graph.js` now keys off both, and by-name lookups prefer an exact-project
  match, falling back to a global/`project IS NULL` entity. Neo4j Community
  supports composite uniqueness constraints, just not `NODE KEY`.
- **Search queries are Lucene-escaped** (`escapeLuceneQuery` in `graph.js`).
  Entity names like `feature:capture-visibility` otherwise parse as a field
  separator plus a negation and match nothing — searching for an entity by its
  own name returned zero hits. The trade is losing wildcard support.
- **Read paths are budgeted in characters, not rows** (`src/lib/budget.js`,
  applied in `graph.js`). Observation length varies 5x by source (claude-mem
  imports average 649 chars vs 122 for native capture), so row counts don't
  predict spend. Anything trimmed says so in-band (`…[+N chars]`, or
  `{total, returned, truncated}`) so a caller never summarizes a silently
  shortened history. **Run `npm run token-cost` after changing anything that
  shapes a read payload.**
- **Subsystem tags live on the observation, not the entity.** The entities
  most in need of slicing are exactly the ones already spanning several
  subsystems — `plugin:neo4j-memory` alone covers auto-capture, search,
  backup, and marketplace installs. Tagging the entity separates none of that.
- **"No subsystem" is `null`, and there is exactly one way to say it.** A
  cross-cutting fact (a preference, a project-wide constraint) has no
  subsystem; it reaches the model through the pinned-facts block, not the
  index. Naming that state instead — `general`, `misc` — turns it into a tag,
  and a tag gets offered back to the next extraction as a preferred option.
  That happened: the backfill's JSON schema marked `subsystem` **required**,
  leaving the model no way to express "none", so its prompt named `general` as
  an escape hatch and 315 observations (20% of the graph) fell into it, 85% of
  them not cross-cutting at all but merely unclassified. Both prompts seed
  their vocabulary from `listSubsystems` with "prefer one of these", so it
  compounded — within the backfill run *and* into every later live capture.
  `resolveSubsystem` now folds any catch-all name to `null` at the single
  write-side chokepoint, so a model reaching for a junk drawer gets the null it
  meant whatever prompt it read. **If you add a field an extraction model must
  fill, check it can express the empty case** — the prompt will invent
  something if the schema won't allow silence.
- **A wrong-but-specific tag is accepted.** Reclassification is ~90% accurate
  on the tags it assigns (measured on this repo, where the content is known);
  the rest land under a plausible neighbour. That's tolerable because the
  subsystem is a navigation aid, not ground truth — `memory_search` is
  full-text across everything and the `subsystem` filter is always optional.
- **`npm run usage` measures a subsystem map in characters as
  `injection.js` renders it**, firing above 800 (live maps run 170–336, so
  roughly 30 average tags). The original `> 12 distinct tags` rule measured
  project size, not fragmentation: it flagged only the project whose 15
  subsystems each held 9+ observations, and stayed silent on the one with
  three three-observation slivers. The row names the three smallest tags,
  since those are the merge candidates. Near-synonyms (`capture` vs.
  `auto-capture`) are the usual cause — the lexical deduper can't merge them
  because they aren't lexically close.
- **Auto-capture needs no `ANTHROPIC_API_KEY`.** `src/hooks/capture.js` shells
  out to a locked-down one-shot headless `claude -p` (no tools, no MCP
  servers, no settings/CLAUDE.md inheritance, `--json-schema` for structured
  output), riding the user's logged-in CLI session rather than a raw API key.
  Opt out with `CLAUDE_NEO4J_DISABLE_CAPTURE=1`; window and chunk count are
  `CLAUDE_NEO4J_CAPTURE_WINDOW` / `CLAUDE_NEO4J_CAPTURE_MAX_CHUNKS`.
- **`SessionEnd` capture runs detached; `PreCompact` stays synchronous.** A
  real `SessionEnd` firing was cancelled by Code because extraction outlives
  the process-exit teardown window, so the hook re-spawns itself detached and
  unref'd (input handed off via a temp file in `~/.claude-neo4j/state/`,
  progress logged to `~/.claude-neo4j/capture.log` since stdio is ignored) and
  returns immediately. Extraction measures ~11s for a full 50k window, so the
  timeouts are outlier headroom, not expected duration: 180s detached, 80s
  inline.
- **`capture.js` exports `sweepPendingCaptures`/`pruneStaleState` for
  `session-start.js`**, so its hook body is guarded by an entry-point check.
  Importing it must not fire a capture.
- **The claude-mem migration maps project scope, it doesn't copy it.**
  claude-mem scopes by bare directory name, this plugin by git-remote
  identifier, so importing under claude-mem's name splits one repo's memory
  across two scopes that can never see each other. Resolution order: `--as ID`
  > git remote of cwd (only when the cwd basename matches the claude-mem
  project) > bare name, and the bare-name fallback warns with the exact fix.
  Re-running is self-healing: observation ids are content hashes, and
  re-attaching deletes stale `ABOUT` edges.
- **Deliberately not built**: a custom web viewer (Neo4j Browser at
  `http://localhost:7474` already is one) and a background transcript-watcher
  daemon (the `PreCompact`/`SessionEnd` hooks already cover it).

## Marketplace snapshots drift from the working tree

The `.claude/settings.json` disable only covers **this** repo. Everywhere
else, the user-scope marketplace install is enabled and can serve a copy that
predates the working tree. Three layers drift independently, and only the
middle one auto-updates:

| layer | path | how to read its state |
| --- | --- | --- |
| GitHub `origin/main` | — | `git ls-remote origin main` |
| marketplace clone | `~/.claude/plugins/marketplaces/claude-neo4j-local` | `git -C <path> rev-parse --short HEAD` |
| **installed snapshot** | `~/.claude/plugins/cache/claude-neo4j-local/neo4j-memory/<version>/` | `gitCommitSha` in `~/.claude/plugins/installed_plugins.json` |

**Check those three rather than trusting any SHA written down.** The layers
are expected to differ transiently: the clone only catches up when autoUpdate
next runs, so right after a push `origin/main` is ahead of the clone, which is
ahead of the snapshot. That's normal. What matters is whether the *snapshot*
is missing code you depend on.

`autoUpdate: true` refreshes the *clone*; it does not re-copy the clone into
the cached install, so `installed_plugins.json` keeps its old `gitCommitSha`
and every non-this-repo session loads the old code. The snapshot is a plain
copy, not a git checkout, so `git log` inside it fails — compare it with
`diff -rq <snapshot>/src <clone>/src` instead.

The snapshot path contains the **version**, so a version bump changes it and
orphans the old directory. Glob the version component rather than hardcoding
it, or you will grep a directory nothing loads from.

**`claude plugin update` is a no-op unless the version changed** — it compares
the `version` in `.claude-plugin/plugin.json`, and there is no `--force`. So
**bump `version` on every push other projects should pick up**
(`package.json` carries the same number; keep them together). Otherwise
nothing will even prompt you that the snapshot has drifted. The fallback, for
drift within a single version:

```
claude plugin uninstall neo4j-memory@claude-neo4j-local --scope user
claude plugin install   neo4j-memory@claude-neo4j-local --scope user
```

Verify by diffing, or by grepping the snapshot for a symbol you know only
exists in the new code — **never with `claude plugin list`**, which reports
the version either way and so cannot distinguish fresh from stale.

Stale-snapshot failures are hard to read as such: when captures in other repos
timed out, the message was indistinguishable from a genuine timeout except for
the *value* (`90000ms`, the snapshot's old constant, against a HEAD that had
moved to `180_000`). **Check the numbers in the error, not just the failure.**
The project-scope record in `installed_plugins.json` also carries its own,
older `gitCommitSha` — harmless, since it shares an `installPath` with the
user-scope entry, but it will mislead anyone reading that file.

## Open

- `PreCompact` auto-capture is still only verified with a synthetic transcript
  piped into `capture.js`. `SessionEnd` is verified against a real hook
  firing; the synchronous `PreCompact` path needs a real compaction event.
