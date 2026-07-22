# Changelog

Notable changes to the `neo4j-memory` plugin, newest first.

Version numbers track `.claude-plugin/plugin.json` and `package.json`, which are
kept in step deliberately: `claude plugin update` compares that string, so a
release that doesn't move it never reaches any other project.

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
  near-synonyms can be merged by hand.

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
