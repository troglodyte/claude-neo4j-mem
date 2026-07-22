# Subsystem-tagged facts and a tiny SessionStart injection — design

Date: 2026-07-22

## Problem

The SessionStart injection dumps the 15 most recently touched entities with
three observations each. Measured against this project's own graph that is
~6.4k characters (~2.3k tokens), paid on every session, and it has two defects
that get worse as the graph grows:

- **It is ordered by recency, not by usefulness.** Whatever was captured last
  is injected, whether or not it bears on the next session. Standing
  preferences and constraints — the facts that should change behaviour without
  being asked for — compete for the same 15 slots as one-off decisions and
  usually lose.
- **It has no index.** Nothing in the injection tells the model what else is in
  memory, so `memory_search` is only ever called when the user names a topic
  explicitly. 1470 observations across four projects are effectively invisible
  unless someone asks for them by name.

The graph itself has a related problem. Entities are the only grouping, and the
largest ones are junk drawers: `plugin:neo4j-memory` holds 65 observations
spanning auto-capture, search, backup, and marketplace installs. There is no
way to ask for "what do we know about capture" — only for the whole entity, or
for a full-text match that may or may not use the right words.

Both problems have the same fix: give observations a subsystem tag, then
replace the recency dump with a compact map of those tags plus the handful of
facts that always apply.

## Approach

The injection becomes two parts, neither of which grows with the graph:

1. **Pinned facts**, verbatim — entities typed `user`, `preference`,
   `constraint`, or `convention`. These are cross-cutting by nature and are
   worthless if the model has to go looking for them.
2. **A subsystem map** — one line per tag with observation count and last-seen
   date. A table of contents, not content. It is bounded by tag cardinality
   (~10 rows) rather than by graph size, so it costs the same on a 200-
   observation project and a 20,000-observation one.

Everything else becomes lookup-only, reachable through `memory_search` with a
`subsystem` filter.

Target: **~6.4k → ~2.8k characters, ~2.3k → ~700 tokens.**

### Why observation-level tags, not entity-level

Entity-level tagging is ten times cheaper to backfill (134 entities vs 1470
observations) and would be symmetric with the existing `type` property. It was
rejected because the entities that most need slicing are precisely the ones
that span subsystems. A single tag on `plugin:neo4j-memory` would be either
wrong or meaningless, and that entity is 29% of this project's observations.

Tagging at the observation level also makes the junk drawer a non-problem
rather than something to clean up: the entity can keep collecting everything,
and reads slice it by tag.

## Data model

`Observation.subsystem` — nullable, lowercase kebab-case. New index in
`src/lib/schema.js` alongside the existing constraints:

```
CREATE INDEX observation_subsystem IF NOT EXISTS FOR (o:Observation) ON (o.subsystem)
```

Nullable is deliberate, not a migration gap. A standing preference or a fact
about the user genuinely has no subsystem, and those are the facts that get
pinned instead. Untagged observations surface in the map as `(untagged)` rather
than being hidden — an honest count of what has not been classified.

## Vocabulary control

This is the part that decides whether the map is useful. Left free-form, the
extraction model will produce `capture`, `auto-capture`, and `capture-hooks` as
three separate tags, and a map with thirty near-duplicate rows is not a map.

The fix reuses the mechanism already proven for entity names, so there is no
new machinery:

- `graph.listSubsystems(project)` returns existing tags with counts.
- `capture.js` feeds them into the extraction system prompt exactly as
  `knownNames` is fed today (`src/hooks/capture.js:62-67`), with an added
  instruction to prefer an existing tag and invent one only when none fits.
- Writes pass through `resolveCanonicalName` (`src/lib/dedup.js:39`). It is
  string-agnostic — nothing in it is specific to entity names — so it catches
  the lexical drift the prompt missed without modification.
- Fragmentation surfaces as a hygiene warning in `npm run usage`, next to the
  existing duplicate-project-name and oversized-entity warnings.

## Read paths

Two new functions in `src/lib/graph.js`.

**`getSubsystemMap(project)`** — a pure aggregate grouped by
`coalesce(o.subsystem, '(untagged)')`, returning observation count, distinct
entity count, and `max(o.createdAt)`, ordered by last-seen descending. It needs
no character budget: the result is bounded by tag cardinality, not by how much
text the graph holds.

**`getPinnedFacts(project)`** — observations belonging to entities whose `type`
is one of `user`, `preference`, `constraint`, `convention`, plus a
`name = 'user'` fallback. Newest first, through the existing `truncateText` and
`fitToBudget` helpers.

Selection is by `type` rather than by name prefix because the two drift in real
data: `architecture:docker-env-to-config` is typed `decision`, and one entity is
typed `Constraint Amendment`. `type` is what the extraction model sets
deliberately; the name prefix is decoration. This will be roughly right, not
exactly right, and that is accepted.

New entries in `src/lib/budget.js`:

```js
pinnedTextChars: 300,
pinnedTotalChars: 2_000,
```

Measured headroom: the largest pinned set across the four live projects is 28
observations / ~2.2k characters (`claude-neo4j-mem`); the smallest is 11 / ~855.

## Injection format

Replaces the recency dump at `src/hooks/session-start.js:83-92`:

```
## Memory (Neo4j · github.com/troglodyte/claude-neo4j-mem)

Always applies:
- bound every read path by characters, not row count
- wants write confirmations visible in-band
- migrations run only when explicitly asked

Tagged history — memory_search(subsystem: …) to read:
  capture (34, 07-21) · search (18, 07-21) · backup (21, 07-20)
  marketplace (15, 07-21) · mcp (9, 07-18) · untagged (126)

Log durable facts with memory_add_observations; auto-capture also runs
at compaction and session end.
```

`TOOLS_BLURB` (`session-start.js:47-55`) drops from ~600 to ~200 characters by
deleting its enumeration of the ten `memory_*` tools. MCP already registers
those names with descriptions, so restating them in the injection is
duplication paid once per session for nothing. What remains is the behavioural
guidance MCP does not carry: when to write, and the caveat that `memory_prune`
must not be called destructively unless asked.

Both empty cases stay explicit — no pinned facts, or no tagged history, prints
nothing for that section rather than an empty heading.

## Making the map followable

A pointer that cannot be queried is worse than no pointer, so the map ships
with the filter it advertises. Optional `subsystem` parameter on
`searchMemory`, `getRecentContext`, and `getTimeline` in `graph.js`, exposed on
the corresponding tools in `src/mcp/server.js`.

`getRecentContext` keeps its current behaviour and remains the `memory_recent`
tool. Only the injection stops calling it.

## Write path

`addObservations` (`graph.js:64`) currently takes `observations` as an array of
strings. It accepts `string | {text, subsystem}` per element, normalising to the
object form internally, so existing callers — the MCP tool, the CLI, and
`migrate-from-claude-mem.mjs` — keep working untouched.

The extraction schema (`capture.js:70`) gains an optional `subsystem` per
observation. `memory_add_observations` in `server.js` accepts the same.

## Backfill

`scripts/backfill-subsystems.mjs`, run once as `npm run backfill-subsystems`.

- Iterates entities that have untagged observations, **largest first**, so the
  junk drawers establish the vocabulary that the smaller entities then reuse.
- One headless `claude -p` call per entity, passing the project's
  vocabulary-so-far and receiving `{id, subsystem}[]` under a JSON schema.
- Idempotent: only ever considers observations where `subsystem IS NULL`.
- Resumable: each entity's tags are written before the next call, so an
  interrupted run resumes where it stopped.
- `--dry-run` prints the assignment without writing; `--project` narrows scope.

The child-process, timeout, and structured-output plumbing is lifted out of
`capture.js:167-216` (`runClaudeExtraction`) into `src/lib/extract.js` and
imported by both, rather than duplicating a fifty-line spawn dance. `capture.js`
keeps its own prompt-building and chunking; only the spawn moves.

Expected cost: ~134 calls covering 1470 observations.

## Verification

- `scripts/token-cost.mjs:19` — lower the `SessionStart injection` ceiling from
  14_000 to 3_500 characters. The script already exits non-zero on regression,
  so this is what stops the injection creeping back up.
- Unit tests for `getSubsystemMap` (aggregate shape, `(untagged)` bucket) and
  `getPinnedFacts` (type selection, budget enforcement).
- `npm test` for the existing launcher-path guard, unaffected.
- `npm run backfill-subsystems -- --dry-run` before the real run.
- End-to-end through `scripts/claude-with-memory.sh`: confirm the SessionStart
  banner appears, read the injected context, and call
  `memory_search(subsystem: "capture")` to confirm the map's pointers resolve.
- Version bump to 0.3.0 in `.claude-plugin/plugin.json` and `package.json`
  together, per the standing rule in CLAUDE.md — without it the marketplace
  snapshot other projects load never picks this up.

## Accepted trade-offs

- **`(untagged)` may dominate the map initially**, for anything the backfill
  declined to classify. Treated as honest signal rather than hidden.
- **Pinned-fact selection is approximate**, because entity `type` is set loosely
  by the extraction model.
- **Escaped Lucene queries still cannot use wildcards** (unchanged from the
  2026-07-21 search fix); the `subsystem` filter is an exact-match property
  predicate, not a full-text one.
