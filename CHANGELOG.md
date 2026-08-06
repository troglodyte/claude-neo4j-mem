# Changelog

Notable changes to the `neo4j-memory` plugin, newest first.

Version numbers track `.claude-plugin/plugin.json` and `package.json`, which are
kept in step deliberately: `claude plugin update` compares that string, so a
release that doesn't move it never reaches any other project.

## 0.6.0 — 2026-08-06

- **Fixed** `searchMemory` returning nothing for an entity matched only by its
  name. The subquery that pulls query-matching observations is a correlated
  `CALL {}`, which is a join and not an optional one: an entity matched by the
  name index has no observation matching that query, so it was joined against an
  empty result and eliminated. Aggregating inside the subquery
  (`RETURN collect(obs)`) always yields one row, so the entity survives. This had
  silently defeated `escapeLuceneQuery` directly above it — that fix made the
  index match, and this block then discarded the hit, so the symptom never
  changed. Two independent causes behind one symptom; a name-only search returned
  zero rows, which `relevance.js` reads as a true miss, so past telemetry
  overstates the read-side miss rate by however many name lookups it saw.
- **Added** `subsystem` to every read path. It was input-and-write-only before:
  no tool returned it, so answering "what subsystem is this in?" meant one call
  per candidate tag and a set difference. `memory_get_entity` gains a field;
  `memory_search` and `memory_recent` now return `{text, subsystem}` objects.
  **Breaking**: those two returned bare strings before. Measured cost is +9.5%
  and +15.0% of payload characters, well inside the existing budgets — no rows
  are dropped and `BUDGETS` is unchanged.
- **Fixed** the subsystem map advertising a bucket the API rejected. The map
  renders untagged observations as `(untagged)` beside real tags and tells the
  reader to pass a tag back, but every filter compared literally, so nothing
  could ever match `o.subsystem IS NULL`. `parseSubsystemFilter` is the read-side
  counterpart to `resolveSubsystem`: three states, since "no filter" and "only
  untagged" are different questions a nullable string can't both express. It also
  normalizes like a written tag, so `Auto-Capture` selects `auto-capture` — the
  round-trip gap was wider than `(untagged)`. A regression test asserts every row
  the map renders selects a non-empty result, since the map is built by one code
  path and consumed by another and nothing checked they agreed on a vocabulary.
- **Added** three hygiene checks to `npm run usage`, all detecting the opposite
  failure to the existing fragmentation rule — that rule measures the rendered
  map in characters, so a map collapsed into one bucket is *small* and passes it
  silently. A dominant tag above 40% of tagged observations, an unclassified
  history above 30% (excluding pinned-type entities, where null is correct by
  design), and a tag named after its own project. The first two are thresholds
  calibrated against the nine projects in one database — healthy ones span
  16–36% and 0–25%, so the margin is four and five points respectively; the
  comments say so rather than letting the numbers read as principled. The third
  needs no threshold: a tag repeating the project name partitions nothing at any
  share, which is exactly what the first two miss. Found live on two projects.
- **Added** discoverability for the retag tooling, which existed only as a flag
  in a maintenance script. `npm run backfill-subsystems --retag TAG` is now named
  in the `memory-status` skill and in the `memory_add_observations` description,
  and `(untagged)` is documented on every `subsystem` parameter.

## 0.5.0 — 2026-08-03

- **Fixed** `memory_search` presenting a fragment match as an answer. The
  full-text index tokenizes on punctuation, so `zzz-nonexistent-term-qqq`
  matched the token `term`, returned one real entity, and read exactly like a
  hit — the "wrong-but-plausible search result" this project recorded a lesson
  about on 2026-07-21, still live. The score was already in the payload but
  uncalibrated: nothing said that 1.61 is noise on this index while 4.80 is a
  real match. `searchMemory` now returns `{results, relevance, topScore}` with
  `relevance` of `strong`/`weak`/`none`, plus an in-band `note` on the two bad
  cases telling the caller to say memory doesn't have this rather than
  summarizing the rows. `npm run memory -- search` prints the same warning,
  since a terminal reader has the same problem and no score to judge by. The
  calibration lives once in `src/lib/relevance.js` (`WEAK_SCORE`, measured
  against this corpus) and is shared with the telemetry miss metric so the two
  can't drift. **Breaking**: `searchMemory` returned a bare array before.
- **Added** read-side telemetry and `npm run telemetry`. The write side has
  always been measurable — `npm run usage` counts what landed, `npm run
  token-cost` prices what a read would cost — but nothing recorded whether the
  memory was ever *consulted*, so "it captures well" could never be turned into
  "it helps". Every MCP tool call now appends one JSONL line to
  `~/.claude-neo4j/telemetry.jsonl` (tool, read/write, project, result size,
  hit count, duration, and the query text on lookups), and the report turns
  that into read:write ratio per project, characters served, miss rate, and the
  searches that came back empty. Writes are logged too, not just reads: a
  project that only ever writes is memory being filed and never read back,
  which is the failure mode the graph's own counts cannot show. Best-effort
  throughout — a telemetry failure can never fail a tool — opt out with
  `CLAUDE_NEO4J_DISABLE_TELEMETRY=1`, and the log rotates once at 5 MB.
- **Added** a relevance floor to the miss metric, because hit count alone
  undercounts misses. The full-text index tokenizes on hyphens, so a junk query
  like `zzz-nonexistent-term-qqq` matches the token `term` and returns one
  plausible-looking entity — a miss that reports as a hit. Entries now carry
  the top Lucene score; measured on this repo real queries score 3.3–9.3 while
  that fragment match scored 1.61, so results below 2.0 are counted as weak and
  reported separately from empty ones. The two have different fixes: nothing
  recorded, versus recorded under words nobody searches for.
- **Changed** `src/mcp/server.js` to register tools through one wrapper. All
  eleven repeated the same try/catch/serialize block, which made the response
  envelope eleven separate decisions; folding it into `registerTool` also gives
  telemetry a single chokepoint, so a tool added later is measured because it
  registered rather than because someone remembered to log it. Net 35 lines
  shorter despite gaining the telemetry.

## 0.4.2 — 2026-07-31

- **Fixed** boot-persistence advice that could not work on macOS. Three scripts
  restated the Linux answer, and `setup-local.sh`'s systemd path returns early
  on Darwin — so "run `scripts/setup-local.sh` to persist across reboots"
  (printed by `migrate-to-podman.sh`, and implied by `check-health.sh`)
  installed nothing at all there, while the real answer went unsaid: on macOS
  the container lives inside the `podman-machine-default` VM, which does not
  come back by itself, so `--restart unless-stopped` never gets to fire. The
  mapping now lives once in `scripts/lib-engine.sh`
  (`boot_persistence_kind`/`_installed`/`_hint`) and all three scripts read it.
- **Added** an optional macOS login agent, offered by `setup-local.sh` the way
  the systemd unit is on Linux: `~/Library/LaunchAgents/`
  `com.claude-neo4j.podman-machine.plist`, running `podman machine start` at
  login. At *login*, not at boot — macOS has no user-level pre-login start and
  no equivalent of `loginctl enable-linger`, and the prompt says so rather than
  implying parity. It names Podman Desktop's *Start Podman on login* as the
  no-install alternative, and prints its own uninstall command.
- **Changed** `check-health.sh` to report macOS boot persistence as a **warning**
  rather than a failure when no agent is installed. Podman Desktop's setting
  does the same job and leaves nothing the script can detect, so its absence
  means *unknown*, not *broken*, and failing the whole run on it would be a
  false alarm. Linux stays a hard failure, where absence really is conclusive.
- **Fixed** two macOS dead ends around a stopped VM, which is the state a reboot
  leaves behind. `setup-local.sh` announced "No container engine found" and
  offered to `brew install podman` over an already-installed podman; it now
  recognises installed-but-VM-down and offers `podman machine start` instead.
  `migrate-to-podman.sh` died with a bare "podman is installed but not usable"
  at exactly the point a user re-runs the migration to get memory back — it now
  carries the same hint. (Re-running the migration is still refused, correctly:
  the fix is starting the VM.)

## 0.4.1 — 2026-07-31

- **Fixed** Podman support failing outright on a stock Debian/Ubuntu host. The
  Neo4j image was named unqualified, which Docker silently expands to
  `docker.io/library/...` and Podman refuses to guess: with
  `unqualified-search-registries` commented out (the distro default) and no
  `shortnames.conf` alias for Neo4j, `setup-local.sh`, the migration's
  rehearsal and its cutover all died on *short-name did not resolve to an
  alias*. Now fully qualified, which Docker accepts unchanged. Guarded by
  `tests/image-name.test.sh` — the trap is that popular images (alpine, nginx)
  *do* ship short-name aliases, so a smoke test with one of those passes and
  hides the problem.
- **Changed** engine resolution to follow the container before applying any
  preference. 0.4.0 preferred Podman whenever it was merely installed and
  runnable, so installing Podman on a working Docker machine — for any reason
  at all — silently pointed every script at a Podman container that didn't
  exist. Among engines that are usable, `resolve_engine` now picks whichever is
  *running* `claude-neo4j-memory`, then whichever merely *has* it; Podman still
  wins where that settles nothing, with Docker the fallback. Running state is
  the deciding signal because `migrate-to-podman.sh` keeps the stopped Docker
  container for rollback, so after a migration both engines have one by that
  name. Rollback consequently no longer needs `CLAUDE_NEO4J_ENGINE=docker` —
  `docker start` is the whole of it — and the closing message says so.
- **Fixed** a failed `PreCompact` capture being dropped with no way to retry
  it. Only `SessionEnd` left a pending input for the `SessionStart` sweep, so
  an inline failure had nothing to re-trigger it; the following `SessionEnd`
  re-covered the same range only while it still fit under the `50k × 3` chunk
  ceiling, and the sessions long enough to compact are the ones that don't.
  Pending inputs are now `*.pending.json`, written by both paths; the sweep
  still accepts the older `*.sessionend.json` name.
- **Fixed** capture timeouts rejecting with the elapsed time alone, discarding
  the killed child's stdout and stderr and making every timeout in
  `capture.log` unexplainable after the fact. The error now carries the child's
  output, and distinguishes a child that produced nothing at all.
- **Fixed** `PreCompact` logging only its failures. Successes went to stdout as
  a `systemMessage` and never to `capture.log`, leaving a failures-only record
  that made a working path look like one that had never run.
- **Changed** the detached worker's log label to name the hook the pending
  input actually came from, rather than always claiming `SessionEnd` — which
  stopped being true once `PreCompact` could queue one. A corrupt input file is
  still reported as `capture worker`, since there is no hook name to read off
  an input that failed to parse.
- **Added** `tests/capture-hook.test.js`, covering both paths through the real
  hook entry point, and `tests/extract-timeout.test.js`. The success case
  writes to Neo4j and skips itself where no container is reachable.
  `tests/engine-resolve.test.sh` gained seven cases for the resolution rule
  above, including both directions of the migrate/rollback tie so a rule that
  simply hardcoded the other engine could not pass.

## 0.4.0 — 2026-07-30

- **Added** Podman support alongside Docker. `scripts/lib-engine.sh` resolves
  the container engine, preferring Podman (daemonless, rootless, no
  licensing) and falling back to Docker; `CLAUDE_NEO4J_ENGINE` pins either.
  Existing Docker installs keep working with no action required.
- **Changed** `scripts/setup-local.sh` to create the container with a plain
  `$ENGINE run` instead of `docker compose`, and to offer a consent-gated
  Podman install when no engine is found — never a silent `sudo`, and a
  non-interactive run refuses rather than guessing. `docker/docker-compose.yml`
  is deleted; `docker/.env` keeps its path and role.
- **Added** `npm run migrate-to-podman`, a one-shot Docker→Podman graph
  migration: rehearses the restore on port 7688, verifies it against a
  content fingerprint, and fails closed on any mismatch. The rehearsal
  container is removed automatically; the old Docker container and its
  volumes are kept untouched as a rollback safety net, and the command to
  reclaim them once you're satisfied is printed at the end.
- **Added** an optional systemd user unit, offered by `setup-local.sh`, for
  rootless Podman boot persistence — rootless Podman has no daemon, so
  without it the container does not come back after a reboot.
  `check-health.sh` reports whether it's installed.

## 0.3.1 — 2026-07-23

Subsystem tagging had grown a junk drawer; this empties it and closes the hole
that produced it. Versioned rather than left unreleased because it changes
plugin runtime code (`src/lib/subsystem.js`, `src/hooks/capture.js`), and a
release that doesn't move the version never reaches another project.

- **Fixed** a junk-drawer subsystem tag that had absorbed 315 observations —
  20% of the whole graph, and the largest tag on two of four projects. The
  cause was a contract mismatch, not a bad heuristic: `src/hooks/capture.js`
  told the model to *omit* `subsystem` for cross-cutting facts and its schema
  allowed it, while `scripts/backfill-subsystems.mjs` marked `subsystem`
  **required** and so had to name an escape hatch (`"general"`) in its prompt
  instead. The model then used that hatch for anything it couldn't classify:
  268 of the 315 (85%) sat on entities that aren't cross-cutting by any
  measure `getPinnedFacts` uses. Worse, both prompts seed their vocabulary from
  `listSubsystems` with "prefer one of these", so one bad batch taught every
  later batch — and every subsequent live capture — to reach for it too.
  - `subsystem` is now optional in the backfill schema, and both prompts say to
    omit the field rather than invent a catch-all.
  - `resolveSubsystem` folds any catch-all name (`general`, `misc`, `other`,
    …) to `null`, so "no subsystem" has one representation regardless of which
    prompt or caller produced it. New `isCatchAllTag`/`filterVocabulary` in
    `src/lib/subsystem.js`.
  - Vocabulary shown to either extraction prompt is filtered, so a junk drawer
    left in an older graph can't reinforce itself.
- **Added** `--retag TAG` to `npm run backfill-subsystems`, which reclassifies
  observations already carrying a tag. The script previously selected only
  `subsystem IS NULL`, so a bad tag could not be revisited without clearing it
  by hand first. Assignments that come back cross-cutting now clear the
  property rather than being skipped.
- **Added** a `npm run usage` warning for catch-all subsystem tags — the
  inverse of the fragmentation warning below, which measures too *many* small
  tags and so was structurally unable to see one oversized meaningless one.
- **Changed** the `npm run usage` subsystem-map warning to measure the map in
  characters, as `src/lib/injection.js` renders it, rather than counting
  distinct tags. The count rule tracked project size: it flagged only
  `prehire-insight`, whose 15 subsystems all hold 9+ observations and render
  to 336 characters, and stayed silent on the project with three
  three-observation slivers. It now fires above 800 characters (live maps run
  170–336) and names the three smallest tags as the merge candidates. Report
  only — it changes no plugin runtime code, and ships here because the fixes
  above needed a release anyway.

## 0.3.0 — 2026-07-22

Subsystem-tagged facts and a much smaller SessionStart injection.
See `docs/superpowers/specs/2026-07-22-subsystem-tagging-and-tiny-injection-design.md`.

### 2026-07-22

- **Added** `src/lib/subsystem.js` — normalizes a free-form subsystem tag to
  lowercase kebab-case and snaps near-duplicates onto tags already in use,
  reusing the entity-name deduper rather than growing a second similarity
  implementation.
- **Added** JavaScript unit tests. `npm test` now runs the existing
  `tests/launcher-path.test.sh` guard *and* `node --test`, with no new
  dependencies.
- **Added** an `Observation.subsystem` property plus a range index
  (`observation_subsystem`), and `listSubsystems`/`getSubsystemMap` reads in
  `src/lib/graph.js`. `addObservations` now accepts `{text, subsystem}` per
  observation (a plain string still works) and resolves each tag through
  `resolveSubsystem` so near-duplicates snap onto whichever tag is already in
  use for the project.
- **Added** `getPinnedFacts` — standing facts (preferences, constraints, the
  `user` entity) selected for every-session injection, budgeted by
  `pinnedTotalChars` (4,000 chars) and `pinnedTextChars` (300 chars/quote) in
  `src/lib/budget.js`, and reporting `{facts, total, returned, truncated}`
  rather than dropping overflow silently.
- **Changed** the `SessionStart` injection from a recency dump to pinned
  standing facts plus a compact subsystem index (`src/lib/injection.js`).
  Measured on `claude-neo4j-mem`: 2,672 characters / 668 tokens, down from
  ~6.4k characters / ~2.3k tokens; all four real projects now land between
  1,232 and 2,672 characters.
- **Added** a `subsystem` filter to `memory_search`, `memory_recent`, and
  `memory_timeline` (and their `graph.js` equivalents), plus a call-level
  `subsystem` on `memory_add_observations`, so the map's entries resolve back
  to a scoped read.
- **Changed** auto-capture (`PreCompact`/`SessionEnd`) to tag every
  observation it extracts with a subsystem, seeding the extraction prompt
  with the project's known tags so it reuses them instead of inventing
  near-duplicates. Lifted the shared spawn/timeout/parse logic into
  `src/lib/extract.js`, used by both auto-capture and the new backfill
  script.
- **Added** `scripts/backfill-subsystems.mjs` (`npm run backfill-subsystems`)
  to tag pre-existing observations. Idempotent (only ever selects
  `subsystem IS NULL`), resumable (writes per batch, not accumulated to the
  end), and processes entities largest-first per project so the vocabulary
  the early batches establish is what later, smaller batches reuse.
- **Added** an `npm run usage` hygiene warning for a fragmented subsystem map
  (a project with more than 12 distinct tags), naming the projects so
  near-synonyms can be merged by hand. Superseded — see Unreleased.

## 0.2.0 — 2026-07-21

- **Added** backup/restore for the local memory graph (`npm run backup`,
  `npm run restore -- --latest`), via `neo4j-admin database dump`/`load` run in
  a sibling container against the stopped container's volume. Each backup gets a
  `.sha256` sidecar, because `load --info` reads only the archive header and
  accepts a truncated dump as valid. Compression is off by default: the `.dump`
  is already zstd-compressed and xz measured 0.9% on the real graph.
- **Fixed** every `scripts/*.sh` silently resolving the plugin directory to `/`.
  `cd "$(dirname X)/.."` collapses to `cd /..` → `/` when the inner substitution
  yields nothing, and `set -euo pipefail` cannot catch it. Claude Code accepts
  `--plugin-dir /` without any error, so the only symptom was a missing
  SessionStart banner — several sessions ran with no memory before it was
  noticed. All scripts now resolve in two steps and assert the resolved root
  contains `.claude-plugin/plugin.json`. Guarded by `tests/launcher-path.test.sh`.
- **Fixed** local development loading a stale marketplace snapshot instead of the
  working tree. `--plugin-dir` is the only live mechanism; a marketplace install
  is a copy pinned to a git SHA. `.claude/settings.json` now disables the
  installed copy for this repo so only the working tree loads.
- **Fixed** `searchMemory` returning the wrong observations — it matched
  `Observation` nodes, then collapsed to the entity and returned its *newest*
  observations rather than the ones that matched, so a hit buried in a large
  entity's history was scored but never shown.
- **Fixed** Lucene syntax in entity names silently breaking search. This plugin
  names entities `feature:capture-visibility`, but Lucene reads `:` as a field
  separator and `-` as negation. Queries are now escaped; the trade is losing
  wildcard support.
- **Fixed** `getEntity` being uncapped — one entity held 711 observations /
  462k chars, so a single call put ~115k tokens into context. Defaults to the 50
  newest and always reports `observationCount`.
- **Added** per-path character budgets (`src/lib/budget.js`). Every read path was
  bounded by row count but never by characters, and observation length varies 5x
  by source, so row counts didn't predict cost. `memory_timeline` went from
  ~60k tokens by default to ~8k. Anything trimmed says so in-band.
  `npm run token-cost` fails if a path regresses.
- **Fixed** failed auto-captures being unrecoverable — the detached worker
  deleted its input file even on failure, destroying the only artifact a retry
  could use. 3 of 21 sessions had died this way. Failed inputs are now kept with
  an attempt counter and relaunched from `SessionStart`.
- **Fixed** auto-capture only ever seeing a session's tail. The 15k-char window
  dropped 66% of extractable content across real sessions; it is now 50k with up
  to 3 chunks.
- **Fixed** `addObservations` opening a nested session and re-scanning every
  entity name per entity. An 8-entity capture cost 16 sessions and 24 queries;
  it now costs 9 and 17.
- **Changed** claude-mem migration to map project scope rather than copy it, and
  to split observations by claude-mem's `type` instead of hanging everything off
  one entity. Re-running is self-healing.
- **Added** `scripts/cypher.sh`, `npm run usage`, and project listing in
  `memory_status`.

## 0.1.0 — 2026-07-20

- **Added** entity dedup, recency-ranked search, `memory_prune`, the capture
  digest, and project listing.
- **Fixed** entity identity being global across every project. The original
  `entity_name_unique` constraint meant two unrelated repos writing the same
  entity name (e.g. `user`) silently collided — the second writer's facts
  attached to the first project's node. Identity is now `(name, project)`.
- **Changed** auto-capture to shell out to a locked-down headless `claude -p`
  call instead of the Anthropic SDK, so it no longer needs `ANTHROPIC_API_KEY`
  and rides on the user's existing logged-in session.
- **Fixed** `SessionEnd` capture being cancelled by Claude Code's teardown — the
  extraction call is slower than the process-exit window. It now re-spawns
  itself detached and returns immediately. `PreCompact` stays synchronous.
- **Added** the Docker setup helpers and the local container workflow.

## 2026-07-17

- Initial commit: MCP server, `SessionStart`/`PreCompact`/`SessionEnd` hooks,
  Neo4j schema, and the `memory_*` tool surface.
