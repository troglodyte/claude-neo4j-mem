# Changelog

Notable changes to the `neo4j-memory` plugin, newest first.

Version numbers track `.claude-plugin/plugin.json` and `package.json`, which are
kept in step deliberately: `claude plugin update` compares that string, so a
release that doesn't move it never reaches any other project.

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
