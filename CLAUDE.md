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
- **Use `scripts/claude-with-memory.sh` to work on this repo** (corrected
  2026-07-21 — the previous claim here, that a local marketplace in
  `.claude/settings.json` made bare `claude` load this working tree, was
  wrong, and hid the fact that every session was testing stale code):
  - A **marketplace install is a snapshot copy** under
    `~/.claude/plugins/cache/…`, pinned to a git SHA. It does not track the
    working tree, whether it came from GitHub or from a `directory` source, so
    local edits are invisible to it until it's reinstalled.
  - **`--plugin-dir` is the only live mechanism.** `plugin.json`/`.mcp.json`
    resolve `${CLAUDE_PLUGIN_ROOT}`, so pointing it at this repo runs the
    working tree. `claude-with-memory.sh` derives that path from its own
    location, which is why nothing here hardcodes a path.
  - **A bad `--plugin-dir` starts a memory-less session silently** (found and
    fixed 2026-07-21). Claude Code accepts `--plugin-dir /` without any error
    or warning, so the *only* symptom is the missing `SessionStart` banner —
    the session otherwise looks completely normal, and several ran that way
    before it was noticed. The launcher was degrading to exactly that:
    `cd "$(dirname X)/.."` collapses to `cd /..` → `/` whenever the inner
    substitution yields nothing, and `set -euo pipefail` cannot catch it (the
    inner failure is swallowed by the substitution, and `cd /` then succeeds).
    All five `scripts/*.sh` now resolve in two steps and assert the resolved
    root contains `.claude-plugin/plugin.json`, refusing to run otherwise;
    `npm test` (`tests/launcher-path.test.sh`) fails against the old form.
    To check a *running* session: `tr '\0' ' ' < /proc/<pid>/cmdline` shows the
    real argv, and `pgrep -P <pid>` should list an `src/mcp/server.js` child —
    if it doesn't, the plugin never loaded. Per-session MCP logs live in
    `~/.cache/claude-cli-nodejs/<escaped-cwd>/mcp-logs-plugin-neo4j-memory-neo4j-memory/`.
  - `~/.claude/settings.json` (user scope) registers the *same marketplace
    name* `claude-neo4j-local` from **GitHub** with `autoUpdate: true`, and
    user scope wins over the project-level entry — which is how a stale
    snapshot silently shadowed local work for this repo.
  - `.claude/settings.json` therefore just **disables** that installed copy for
    this repo, so the `--plugin-dir` copy is the only one loaded and no second
    MCP server registers under the same name. It deliberately contains no
    paths: a `directory` marketplace source is normalized to an absolute path
    (`./` is accepted then rewritten; `.` and `${CLAUDE_PROJECT_DIR}` are
    rejected outright), so it can never be made portable.
  - Verify with `claude plugin list`: inside this repo it should read
    `disabled`; outside it, `enabled`.
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
- **The repo is committed and pushed** (corrected 2026-07-21 — it previously
  said nothing was committed, which stopped being true once the fixes below
  landed). `origin` is `git@github.com:troglodyte/claude-neo4j-mem.git`; as of
  2026-07-21 `main` is in sync with `origin/main` at `e2fbad5`. Commits still
  happen only when explicitly requested.

## Useful commands

- `scripts/claude-with-memory.sh` — launch Claude Code with this plugin loaded.
- `npm test` — guards `scripts/*.sh` against silently resolving the plugin
  directory to `/` (see the launcher notes above).
- `scripts/setup-local.sh` — idempotent: starts the local container if needed,
  waits for health, and (re)runs the configure wizard against it.
- `npm run configure` / `node scripts/configure.mjs --mode ... --uri ...` —
  reconfigure or switch between local/remote (e.g. Neo4j Aura) manually.
- `scripts/check-health.sh` — verifies the whole stack end to end (container
  health, config, Neo4j auth, MCP handshake); prints PASS/FAIL per check.
- `npm run usage` (or `scripts/memory-usage.sh`) — cross-project usage report:
  every project in the db with entity/observation counts, first-seen, obs in
  last 7 days, last activity, plus totals and hygiene warnings (duplicate
  project names, oversized entities, empty stubs). `--quiet` for table only.
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

## Search/recall fixes (2026-07-21)

Three bugs found while auditing the graph, all fixed and verified:

- **`searchMemory` returned the wrong observations.** Full-text matched
  `Observation` nodes, then collapsed to the entity and returned
  `collect(o.text)[0..5]` ordered by `createdAt DESC` — the entity's *newest*
  observations, not the ones that matched. A hit buried in a large entity's
  history was scored but never shown (searching `mbti` returned five
  observations, none mentioning MBTI). Now re-queries the index per matched
  entity for the best-scoring observations, topping up with recent ones so
  name-only matches still return context.
- **Lucene syntax in entity names silently broke search.** This plugin names
  entities `feature:capture-visibility`, but Lucene reads `:` as a field
  separator and `-` as negation, so searching for an entity by its own name
  returned nothing. Queries are now escaped (`escapeLuceneQuery` in `graph.js`);
  the trade is losing wildcard support.
- **`getEntity` was uncapped.** One entity held 711 observations / 462k chars,
  so a single `memory_get_entity` call put ~115k tokens into context. Now
  defaults to the 50 newest and always returns `observationCount`; pass
  `limit` (or `null` internally) for more.

## claude-mem migration (`scripts/migrate-from-claude-mem.mjs`)

Rewritten 2026-07-21 after both of its output defects showed up in real data:

- **Project scope is now mapped, not copied.** claude-mem scopes by bare
  directory name, this plugin by git-remote identifier, so importing under
  claude-mem's name split one repo's memory across two scopes that could never
  see each other (this happened to `prehire-insight`). Resolution order:
  `--as ID` > git remote of cwd (only when the cwd basename matches the
  claude-mem project) > bare name, and the bare-name fallback prints a warning
  with the exact fix.
- **Observations are split by claude-mem's `type`** (discovery, change,
  feature, bugfix, refactor, decision, security_note) into
  `<type>:<project>` entities, plus `session-summary:<project>`. The old
  version discarded `type` and hung everything off one entity.
- **Re-running is self-healing**: observation ids are content hashes, and
  re-attaching also deletes stale `ABOUT` edges, so a pre-split import is
  migrated in place and the emptied legacy entity is dropped.

## Token-cost budgets (2026-07-21)

Every read path was bounded by row count but never by characters, so cost was
unpredictable: `memory_timeline` returned ~60k tokens by default and up to
~300k at its old `limit: 2000` ceiling. Observation length varies 5x by
source (claude-mem imports average 649 chars vs 122 for native capture), so
row counts don't predict spend — a migrated project paid 5x at every ceiling.

`src/lib/budget.js` now holds per-path character budgets, applied in
`graph.js`. Anything trimmed says so in-band (`…[+N chars]`, or
`{total, returned, truncated}` from `getTimeline`) so a caller never
summarizes a silently-shortened history. Measured on `prehire-insight`:

| path | before | after |
| --- | --- | --- |
| `memory_timeline` (default) | ~59.7k tok | ~8.0k tok |
| `memory_timeline` (max limit) | ~300k tok | hard-capped ~10k tok |
| `memory_get_entity` (uncapped) | ~53.7k tok | ~8.4k tok |
| SessionStart injection | ~4.2k tok | ~2.3k tok |
| `memory_search` | ~5.6k tok | ~3.2k tok |

`npm run token-cost [-- --all]` measures every read path against a per-call
ceiling and exits non-zero if one regresses. Run it after changing anything
that shapes a read payload.

## Auto-capture reliability and coverage (2026-07-21)

Three problems, all found by measuring rather than reading:

- **Failed captures were unrecoverable.** The detached worker's `finally`
  deleted its input file unconditionally, including on failure — destroying the
  only artifact a retry could use, even though `lastLine` only advances on
  success (so a retry would have been correct). 3 of 21 sessions had died this
  way, visible only in `capture.log`. Failed inputs are now kept with an
  attempt counter (up to 3), `sweepPendingCaptures()` relaunches them from
  `SessionStart` — the only trigger left once a session is over — and the
  banner says when it does. Files younger than 10 minutes are skipped so an
  in-flight worker isn't double-run.
- **Capture only ever saw a session's tail.** `text.slice(-15000)` dropped 66%
  of extractable content across real captured sessions (89% for the worst), and
  `lastLine == totalLines` in every case proved PreCompact never chunked them —
  most sessions end without compacting. The window is now 50k chars with up to
  3 chunks (`CLAUDE_NEO4J_CAPTURE_WINDOW`, `CLAUDE_NEO4J_CAPTURE_MAX_CHUNKS`),
  taken from the end so overflow drops the oldest content, and what was dropped
  is logged. PreCompact stays at one window since it runs inline against a 100s
  hook timeout.
- **Writes were DB-wasteful.** `addObservations` opened a session and then
  called `listEntityNames` *inside* it — a nested session plus a full re-scan of
  every entity name, per entity. An 8-entity capture cost 16 sessions, 24
  queries and 16 config-file reads; it now costs 9 sessions, 17 queries and 1
  read. Callers writing several entities pass `existingNames` once.

Extraction measures ~11s for a full 50k window, so timeouts are outlier
headroom, not expected duration: 180s detached, 80s inline.

Note `capture.js` exports `sweepPendingCaptures`/`pruneStaleState` for
`session-start.js`, so its hook body is guarded by an entry-point check —
importing it must not fire a capture.

## Every *other* project is running a stale snapshot (found 2026-07-21)

The `.claude/settings.json` disable only covers **this** repo. Everywhere else,
the user-scope marketplace install is enabled and serving a copy that predates
all the 2026-07-21 fixes. Three layers were out of sync, and only the middle
one auto-updates:

| layer | path | state on 2026-07-21 |
| --- | --- | --- |
| GitHub `origin/main` | — | `e2fbad5`, current |
| marketplace clone | `~/.claude/plugins/marketplaces/claude-neo4j-local` | `e2fbad5`, current |
| **installed snapshot** | `~/.claude/plugins/cache/claude-neo4j-local/neo4j-memory/0.1.0` | pinned `54b36b6`, **stale** |

`autoUpdate: true` refreshes the *clone*; it does not re-copy the clone into
the cached install, so `installed_plugins.json` keeps its old `gitCommitSha`
and every non-this-repo session loads the old code. The snapshot is a plain
copy, not a git checkout, so `git log` inside it fails — compare it with
`diff -rq <snapshot>/src <clone>/src` instead.

Symptoms, all confirmed in real sessions rather than inferred:

- Captures in other repos time out at `90000ms` — the snapshot's
  `CAPTURE_TIMEOUT_MS = 90_000`, while HEAD has been `180_000` since `b94fecd`
  (11:00). A timeout logged at 15:41 for a `feral-processes` session is what
  exposed this; a stale-code timeout is indistinguishable from a real one in
  `capture.log`, so **check the timeout value in the message, not just the
  failure**.
- The snapshot has no `src/lib/budget.js`, so other projects still pay the
  pre-budget read costs (~60k tokens for a default `memory_timeline`).
- No `sweepPendingCaptures` → their failed captures stay unrecoverable.
- No `escapeLuceneQuery` → their `<type>:<project>` entity searches return
  nothing.

**`claude plugin update` cannot fix this** (tried 2026-07-21, it reported
"already at the latest version (0.1.0)" and did nothing). It compares the
`version` in `.claude-plugin/plugin.json`, which has been `0.1.0` since the
plugin was created — so as long as the version is left alone, `update` is a
permanent no-op no matter how far the snapshot drifts. There is no `--force`.

What actually worked, at user scope:

```
claude plugin uninstall neo4j-memory@claude-neo4j-local --scope user
claude plugin install   neo4j-memory@claude-neo4j-local --scope user
```

That re-copied the clone (`gitCommitSha` went `54b36b6` → `e2fbad5`, and
`diff -rq` against the clone is now empty). Verify with
`grep CAPTURE_TIMEOUT_MS ~/.claude/plugins/cache/.../src/hooks/capture.js` —
never with `claude plugin list`, which reports `0.1.0` either way and so
cannot distinguish fresh from stale.

Two follow-ups this leaves open:

- **Bump `version` in `.claude-plugin/plugin.json` on every push** that other
  projects should pick up, otherwise the reinstall dance is the only path and
  nothing will prompt you to run it.
- The **project-scope** record in `installed_plugins.json` still reads
  `ec11886` (2026-07-17). Harmless today — it shares the now-fresh
  `installPath` with the user-scope entry, and this repo is `disabled` at both
  scopes and loads via `--plugin-dir` regardless — but it is a second stale
  `gitCommitSha` that will mislead anyone reading that file.

## Likely next steps

- Actually use it in a session or two so `memory_add_observations` /
  auto-capture populate real data, then confirm `SessionStart` injection reads
  back sensibly.
- `SessionEnd` auto-capture is verified against a real hook firing (see
  above). `PreCompact` is only verified with a synthetic transcript piped
  directly into `capture.js` — still needs a real compaction event to confirm
  its synchronous path holds up end-to-end too.
