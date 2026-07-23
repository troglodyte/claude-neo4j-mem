# Subsystem Tagging and Tiny SessionStart Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag every observation with a subsystem, then replace the SessionStart recency dump with pinned standing facts plus a compact subsystem map, cutting the per-session injection from ~6.4k to ~4.6k characters.

**Architecture:** A new nullable `subsystem` property on `Observation` nodes, populated by auto-capture going forward and by a one-off LLM backfill for the 1470 existing observations. Two new aggregate read paths in `src/lib/graph.js` (`getSubsystemMap`, `getPinnedFacts`) feed a pure render function in a new `src/lib/injection.js`, which `src/hooks/session-start.js` and `scripts/token-cost.mjs` both call so the measurement can never drift from the real thing.

**Tech Stack:** Node 18.17+ (local: v26.2.0), ESM, `neo4j-driver` 5.x against neo4j:5-community, `@modelcontextprotocol/sdk`, `zod`, `node:test` for unit tests (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-07-22-subsystem-tagging-and-tiny-injection-design.md`

## Global Constraints

- **Node's built-in test runner only.** No new dependencies — `package.json` currently has three and this feature adds none.
- **Never open a nested Neo4j session.** Fetch lookup data (`listEntityNames`, `listSubsystems`) *before* entering `withSession`, and let batch callers pass it in. Commit `b94fecd` fixed exactly this; re-introducing it costs 2x sessions and queries per write.
- **Cypher cannot match a literal `null` in a property map.** Every project-scoped `MATCH`/`MERGE` spells the comparison out as `($project IS NOT NULL AND x.project = $project) OR ($project IS NULL AND x.project IS NULL)`. Follow the surrounding code in `graph.js`.
- **Test data is deleted after verification.** DB-backed tests write under project `test:subsystem` and remove it in an `after()` hook. This is a standing convention in this repo.
- **Commits happen only when the user asks.** `CLAUDE.md` overrides the generic "commit frequently" guidance — do the `git add`/`git commit` steps only if the user has said to.
- **Bump `version` to `0.3.0` in both `.claude-plugin/plugin.json` and `package.json`** (Task 9). Without a version change, `claude plugin update` is a no-op and no other project ever loads this.
- **Character budgets live in `src/lib/budget.js`**, never inline in a query.

---

### Task 1: Subsystem normalization (pure, no database)

**Files:**
- Create: `src/lib/subsystem.js`
- Create: `tests/subsystem.test.js`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: `resolveCanonicalName` from `src/lib/dedup.js:39`
- Produces:
  - `normalizeSubsystem(value: unknown): string | null`
  - `resolveSubsystem(value: unknown, knownSubsystems?: string[]): string | null`
  - `UNTAGGED: string` — the literal `"(untagged)"`

- [ ] **Step 1: Write the failing test**

Create `tests/subsystem.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSubsystem, resolveSubsystem, UNTAGGED } from "../src/lib/subsystem.js";

test("normalizeSubsystem slugifies to lowercase kebab-case", () => {
  assert.equal(normalizeSubsystem("Auto Capture"), "auto-capture");
  assert.equal(normalizeSubsystem("  MCP_Server  "), "mcp-server");
  assert.equal(normalizeSubsystem("backup/restore"), "backup-restore");
});

test("normalizeSubsystem rejects anything that isn't a usable tag", () => {
  assert.equal(normalizeSubsystem(""), null);
  assert.equal(normalizeSubsystem("   "), null);
  assert.equal(normalizeSubsystem("---"), null);
  assert.equal(normalizeSubsystem(null), null);
  assert.equal(normalizeSubsystem(undefined), null);
  assert.equal(normalizeSubsystem(42), null);
});

test("resolveSubsystem snaps lexical drift onto an existing tag", () => {
  assert.equal(resolveSubsystem("captures", ["capture", "search"]), "capture");
  assert.equal(resolveSubsystem("Backup", ["backup"]), "backup");
  assert.equal(resolveSubsystem("capture-hooks", ["capture-hook"]), "capture-hook");
});

test("resolveSubsystem keeps a genuinely new tag", () => {
  assert.equal(resolveSubsystem("marketplace", ["capture", "search"]), "marketplace");
  assert.equal(resolveSubsystem("backup", []), "backup");
});

test("UNTAGGED is a value no real slug can collide with", () => {
  assert.equal(normalizeSubsystem(UNTAGGED), "untagged");
  assert.notEqual(UNTAGGED, "untagged");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/subsystem.test.js`
Expected: FAIL — `Cannot find module '.../src/lib/subsystem.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/subsystem.js`:

```js
// Subsystem tags group observations *within* an entity, so a junk-drawer entity
// like "plugin:neo4j-memory" - 65 observations spanning auto-capture, search,
// backup and marketplace installs - can be sliced by topic instead of read
// whole. Tagging at the entity level was rejected for exactly that reason: the
// entities that most need slicing are the ones that span subsystems.
//
// Tags are free-form (the extraction model picks them), so they need the same
// anti-drift treatment entity names get, or the map they feed degrades into
// "capture", "captures" and "capture-hooks" as three separate rows.
import { resolveCanonicalName } from "./dedup.js";

// Deliberately not a valid slug: normalizeSubsystem strips the parentheses, so
// no real tag can ever collide with the bucket for untagged observations.
export const UNTAGGED = "(untagged)";

/** Lowercase kebab-case, or null for anything that isn't a usable tag. */
export function normalizeSubsystem(value) {
  if (typeof value !== "string") return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

/**
 * Normalizes, then snaps onto an existing tag from the same project when it's a
 * close lexical match. Reuses the entity-name deduper rather than growing a
 * second similarity implementation to keep in step.
 *
 * This only catches lexical drift ("captures" -> "capture"). Semantic
 * convergence ("auto-capture" -> "capture") is the extraction prompt's job,
 * with `npm run usage` flagging it when both slip through.
 */
export function resolveSubsystem(value, knownSubsystems = []) {
  const slug = normalizeSubsystem(value);
  if (!slug) return null;
  return resolveCanonicalName(slug, knownSubsystems);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/subsystem.test.js`
Expected: PASS — 5 tests, 0 failures

- [ ] **Step 5: Wire the JS tests into `npm test`**

In `package.json`, change the `test` script. The shell test must keep running — it guards the `--plugin-dir /` failure mode:

```json
"test": "bash tests/launcher-path.test.sh && node --test tests/",
```

`node --test` only collects `*.test.{js,mjs,cjs}`, so it ignores `tests/launcher-path.test.sh`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: the launcher-path checks print `all checks passed`, then the node runner reports `pass 5` / `fail 0`.

---

### Task 2: Store and read the tag

**Files:**
- Modify: `src/lib/schema.js` (append to `STATEMENTS`)
- Modify: `src/lib/graph.js:64-92` (`addObservations`), plus a new `listSubsystems`
- Create: `tests/graph-subsystem.test.js`

**Interfaces:**
- Consumes: `resolveSubsystem` from Task 1
- Produces:
  - `addObservations({..., observations: Array<string | {text: string, subsystem?: string}>, existingSubsystems?: string[]})` — the string form still works unchanged
  - `listSubsystems(project: string | null): Promise<Array<{subsystem: string, observations: number}>>`, most-used first, non-null tags only

- [ ] **Step 1: Write the failing test**

Create `tests/graph-subsystem.test.js`. It hits the live local Neo4j and cleans up after itself:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureSchema } from "../src/lib/schema.js";
import { closeDriver } from "../src/lib/neo4jClient.js";
import * as graph from "../src/lib/graph.js";

const PROJECT = "test:subsystem";

before(async () => {
  await ensureSchema();
  await graph.deleteEntity("test:tagged", PROJECT);
});

after(async () => {
  await graph.deleteEntity("test:tagged", PROJECT);
  await closeDriver();
});

test("addObservations stores a per-observation subsystem", async () => {
  await graph.addObservations({
    entity: "test:tagged",
    entityType: "fact",
    project: PROJECT,
    observations: [
      { text: "capture retries failed inputs up to 3 times", subsystem: "capture" },
      { text: "backup writes a .sha256 sidecar", subsystem: "Backup" },
      "an untagged plain-string observation",
    ],
  });

  const tags = await graph.listSubsystems(PROJECT);
  const bySlug = Object.fromEntries(tags.map((t) => [t.subsystem, t.observations]));
  assert.equal(bySlug.capture, 1);
  assert.equal(bySlug.backup, 1, "'Backup' should normalize to 'backup'");
  assert.equal(tags.length, 2, "the plain string must stay untagged, not become a tag");
});

test("addObservations snaps a near-duplicate tag onto the existing one", async () => {
  await graph.addObservations({
    entity: "test:tagged",
    project: PROJECT,
    observations: [{ text: "a second capture fact", subsystem: "captures" }],
  });

  const tags = await graph.listSubsystems(PROJECT);
  const bySlug = Object.fromEntries(tags.map((t) => [t.subsystem, t.observations]));
  assert.equal(bySlug.capture, 2, "'captures' should have merged into 'capture'");
  assert.equal(bySlug.captures, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/graph-subsystem.test.js`
Expected: FAIL — `graph.listSubsystems is not a function`

- [ ] **Step 3: Add the index to the schema**

In `src/lib/schema.js`, append to the `STATEMENTS` array (after the two fulltext indexes):

```js
  // A low-cardinality label filtered as an exact-match predicate on read paths
  // that already narrow by project - a plain range index, not a fulltext one.
  "CREATE INDEX observation_subsystem IF NOT EXISTS FOR (o:Observation) ON (o.subsystem)",
```

- [ ] **Step 4: Add `listSubsystems` to `graph.js`**

Add the import at the top of `src/lib/graph.js`, next to the existing `dedup.js` import:

```js
import { resolveSubsystem } from "./subsystem.js";
```

Then add this function immediately after `listEntityNames` (currently `graph.js:38-47`):

```js
/**
 * The project's existing subsystem vocabulary, most-used first. Fed to the
 * extraction prompt and to the write path so new tags converge on the ones
 * already in use instead of fragmenting.
 */
export async function listSubsystems(project) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE ($project IS NULL OR e.project = $project OR e.project IS NULL)
         AND o.subsystem IS NOT NULL
       RETURN o.subsystem AS subsystem, count(o) AS observations
       ORDER BY observations DESC, subsystem ASC`,
      { project: project ?? null }
    );
    return result.records.map((r) => ({
      subsystem: r.get("subsystem"),
      observations: r.get("observations").toNumber(),
    }));
  });
}
```

- [ ] **Step 5: Teach `addObservations` about subsystems**

Replace `graph.js:64-72` (the signature through the `resolveCanonicalName` line). Note both lookups happen *before* `withSession` — a nested session is the exact regression `b94fecd` fixed:

```js
export async function addObservations({
  entity,
  entityType,
  observations,
  sessionId,
  project,
  existingNames,
  existingSubsystems,
}) {
  const names = existingNames ?? (await listEntityNames(project));
  const knownSubsystems = existingSubsystems ?? (await listSubsystems(project)).map((s) => s.subsystem);
  // Accepts a plain string or {text, subsystem}: the MCP tool and the CLI pass
  // strings, auto-capture and the backfill pass objects. Bounded on the way in,
  // so one runaway observation can't inflate every future read of this entity.
  const rows = observations.map((item) => {
    const { text, subsystem } = typeof item === "string" ? { text: item, subsystem: null } : item;
    return {
      id: randomUUID(),
      text: truncateText(text, BUDGETS.writeTextChars),
      subsystem: resolveSubsystem(subsystem, knownSubsystems),
    };
  });
  entity = resolveCanonicalName(entity, names);
```

Then in the same function's `CREATE` clause, add the property:

```
       CREATE (o:Observation {id: row.id, text: row.text, subsystem: row.subsystem, createdAt: datetime(), sessionId: $sessionId})
```

Delete the now-stale comment block above the old `const rows = ...` (its content is folded into the new comment) and leave the rest of the function untouched.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test tests/graph-subsystem.test.js`
Expected: PASS — 2 tests, 0 failures

- [ ] **Step 7: Verify the string form still works for existing callers**

Run: `npm run memory -- add test:tagged "a plain string write from the CLI"`
Expected: prints a confirmation with one observation id, no error.

Then clean up: `npm run memory -- forget test:tagged`

---

### Task 3: The subsystem map

**Files:**
- Modify: `src/lib/graph.js` (new `getSubsystemMap`, after `listSubsystems`)
- Modify: `tests/graph-subsystem.test.js`

**Interfaces:**
- Consumes: `UNTAGGED` from `src/lib/subsystem.js`
- Produces: `getSubsystemMap(project: string | null): Promise<Array<{subsystem: string, observations: number, entities: number, lastSeen: string}>>`, most-recent first, including an `UNTAGGED` row

- [ ] **Step 1: Write the failing test**

Append to `tests/graph-subsystem.test.js`:

```js
test("getSubsystemMap aggregates counts and buckets untagged observations", async () => {
  const map = await graph.getSubsystemMap(PROJECT);
  const byName = Object.fromEntries(map.map((row) => [row.subsystem, row]));

  assert.equal(byName.capture.observations, 2);
  assert.equal(byName.capture.entities, 1);
  assert.match(byName.capture.lastSeen, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(byName.backup.observations, 1);
  assert.equal(byName["(untagged)"].observations, 1, "untagged facts get their own row, not hidden");

  const sizes = map.map((row) => row.observations);
  assert.ok(sizes.length <= 4, "the map is bounded by tag cardinality, not by observation count");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/graph-subsystem.test.js`
Expected: FAIL — `graph.getSubsystemMap is not a function`

- [ ] **Step 3: Write the implementation**

Extend the `subsystem.js` import in `graph.js`:

```js
import { resolveSubsystem, UNTAGGED } from "./subsystem.js";
```

Add after `listSubsystems`:

```js
/**
 * A table of contents for the project's memory: one row per subsystem tag with
 * counts and recency. Deliberately an aggregate rather than a sample - its size
 * is bounded by tag cardinality, not by how much text the graph holds, so it
 * costs the same on a 200-observation project and a 20,000-observation one.
 * That is what lets the SessionStart injection stop growing with the graph.
 *
 * Untagged observations get their own row rather than being dropped: an honest
 * count of what hasn't been classified beats a tidy short list.
 */
export async function getSubsystemMap(project) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE $project IS NULL OR e.project = $project OR e.project IS NULL
       WITH coalesce(o.subsystem, $untagged) AS subsystem, o, e
       RETURN subsystem,
              count(o) AS observations,
              count(DISTINCT e) AS entities,
              toString(max(o.createdAt)) AS lastSeen
       ORDER BY lastSeen DESC`,
      { project: project ?? null, untagged: UNTAGGED }
    );
    return result.records.map((r) => ({
      subsystem: r.get("subsystem"),
      observations: r.get("observations").toNumber(),
      entities: r.get("entities").toNumber(),
      lastSeen: r.get("lastSeen"),
    }));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/graph-subsystem.test.js`
Expected: PASS — 3 tests, 0 failures

---

### Task 4: Pinned facts and their budget

**Files:**
- Modify: `src/lib/budget.js` (two new entries in `BUDGETS`)
- Modify: `src/lib/graph.js` (new `PINNED_TYPES` and `getPinnedFacts`, after `getRecentContext`)
- Create: `tests/graph-pinned.test.js`

**Interfaces:**
- Consumes: `BUDGETS`, `truncateText`, `fitToBudget` from `src/lib/budget.js`
- Produces: `getPinnedFacts({project: string | null, limit?: number}): Promise<{facts: Array<{entity: string, type: string | null, text: string}>, total: number, returned: number, truncated: boolean}>`, newest first

- [ ] **Step 1: Write the failing test**

Create `tests/graph-pinned.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ensureSchema } from "../src/lib/schema.js";
import { closeDriver } from "../src/lib/neo4jClient.js";
import { BUDGETS } from "../src/lib/budget.js";
import * as graph from "../src/lib/graph.js";

const PROJECT = "test:pinned";
const ENTITIES = ["preference:test-style", "decision:test-noise", "user", "Constraint Amendment holder"];

async function clean() {
  for (const name of ENTITIES) await graph.deleteEntity(name, PROJECT);
}

before(async () => {
  await ensureSchema();
  await clean();
  await graph.addObservations({
    entity: "preference:test-style",
    entityType: "preference",
    project: PROJECT,
    observations: ["prefers tests that assert on behaviour, not on call counts"],
  });
  await graph.addObservations({
    entity: "decision:test-noise",
    entityType: "decision",
    project: PROJECT,
    observations: ["chose vitest over jest for this one repo"],
  });
  await graph.addObservations({
    entity: "user",
    entityType: "user",
    project: PROJECT,
    observations: ["works in Europe/London"],
  });
  await graph.addObservations({
    entity: "Constraint Amendment holder",
    entityType: "Constraint Amendment",
    project: PROJECT,
    observations: ["build artifacts must stay out of git"],
  });
});

after(async () => {
  await clean();
  await closeDriver();
});

test("getPinnedFacts selects standing facts and excludes one-off decisions", async () => {
  const { facts } = await graph.getPinnedFacts({ project: PROJECT });
  const texts = facts.map((p) => p.text);

  assert.ok(texts.some((t) => t.includes("assert on behaviour")), "preference: must pin");
  assert.ok(texts.some((t) => t.includes("Europe/London")), "user must pin");
  assert.ok(texts.some((t) => t.includes("out of git")), "'Constraint Amendment' must pin by prefix");
  assert.ok(!texts.some((t) => t.includes("vitest")), "a decision: is not a standing fact");
});

test("getPinnedFacts enforces its character budget", async () => {
  const { facts } = await graph.getPinnedFacts({ project: PROJECT });
  const total = JSON.stringify(facts).length;
  assert.ok(total <= BUDGETS.pinnedTotalChars, `pinned payload was ${total} chars`);
  for (const fact of facts) {
    assert.ok(fact.text.length <= BUDGETS.pinnedTextChars + 24, "long text must be truncated in-band");
  }
});

test("getPinnedFacts reports its own truncation rather than dropping silently", async () => {
  const whole = await graph.getPinnedFacts({ project: PROJECT });
  assert.equal(whole.returned, whole.facts.length);
  assert.equal(whole.total, 3, "all three standing facts are eligible");
  assert.equal(whole.truncated, false, "nothing is dropped when the budget has room");

  // `limit` is the driver-level valve; forcing it low proves the report is
  // wired to the real counts and not hardcoded.
  const clipped = await graph.getPinnedFacts({ project: PROJECT, limit: 1 });
  assert.equal(clipped.returned, 1);
  assert.equal(clipped.total, 3, "total is the true eligible count, not the returned count");
  assert.equal(clipped.truncated, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/graph-pinned.test.js`
Expected: FAIL — `graph.getPinnedFacts is not a function`

- [ ] **Step 3: Add the budgets**

In `src/lib/budget.js`, add to the `BUDGETS` object, next to `recentTextChars`:

```js
  // Injected verbatim into every session alongside the subsystem map. Sized to
  // fit the largest real pinned set whole - 28 observations at ~138 chars each
  // is ~3.9k - because a standing preference the model never sees may as well
  // not exist. An earlier 2_000 silently dropped half the standing facts on
  // three of four live projects; the ceiling stays only as a backstop against a
  // project that accumulates far more, and getPinnedFacts reports when it bites.
  pinnedTextChars: 300,
  pinnedTotalChars: 4_000,
```

- [ ] **Step 4: Write `getPinnedFacts`**

Add to `src/lib/graph.js` immediately after `getRecentContext` (currently ends at line 234):

```js
// Entity types whose observations always apply, whatever this session is about.
// Matched by prefix against `type` rather than against the name, because the two
// drift in real data: "architecture:docker-env-to-config" is typed "decision",
// and one live entity is typed "Constraint Amendment". `type` is what the
// extraction model sets deliberately; the name prefix is decoration.
const PINNED_TYPES = ["user", "preference", "constraint", "convention"];

// Shared by the count and the fetch so the two can never disagree about what
// "pinned" means - a `total` computed from a different predicate than the rows
// would be worse than no total at all.
const PINNED_MATCH = `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE ($project IS NULL OR e.project = $project OR e.project IS NULL)
         AND (any(t IN $types WHERE toLower(coalesce(e.type, '')) STARTS WITH t) OR e.name = 'user')`;

/**
 * The standing preferences and constraints injected verbatim at SessionStart.
 * These are cross-cutting by nature and worthless if the model has to go looking
 * for them, which is why they are the one thing the injection still quotes in
 * full rather than merely indexing.
 *
 * Returns {facts, total, returned, truncated} rather than a bare array, for the
 * same reason getTimeline does: a caller that silently receives half the
 * standing facts will confidently act as though it has all of them. `limit` is a
 * driver-level safety valve set far above what the character budget will ever
 * pass, not the effective bound - the budget is.
 */
export async function getPinnedFacts({ project, limit = 100 } = {}) {
  return withSession(async (session) => {
    const params = { project: project ?? null, types: PINNED_TYPES };
    const countResult = await session.run(`${PINNED_MATCH} RETURN count(o) AS total`, params);
    const total = countResult.records[0]?.get("total")?.toNumber() ?? 0;

    const result = await session.run(
      `${PINNED_MATCH}
       WITH e, o ORDER BY o.createdAt DESC
       LIMIT $limit
       RETURN e.name AS entity, e.type AS type, o.text AS text`,
      { ...params, limit: int(limit) }
    );
    const rows = result.records.map((r) => {
      const row = r.toObject();
      return { ...row, text: truncateText(row.text, BUDGETS.pinnedTextChars) };
    });
    const { kept } = fitToBudget(rows, BUDGETS.pinnedTotalChars);
    return { facts: kept, total, returned: kept.length, truncated: kept.length < total };
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/graph-pinned.test.js`
Expected: PASS — 2 tests, 0 failures

- [ ] **Step 6: Check it against real data**

Run: `node -e 'import("./src/lib/graph.js").then(async g => { console.log(await g.getPinnedFacts({project: "github.com/troglodyte/claude-neo4j-mem"})); process.exit(0) })'`
Expected: preference/user observations only — no `decision:` or `feature:` rows.

---

### Task 5: Make the map followable — subsystem filters

**Files:**
- Modify: `src/lib/graph.js` — `searchMemory:112`, `getRecentContext:213`, `getTimeline:268`
- Modify: `src/mcp/server.js` — `memory_search:23`, `memory_add_observations:50`, `memory_recent:90`, `memory_timeline:165`
- Modify: `tests/graph-subsystem.test.js`

**Interfaces:**
- Consumes: `getSubsystemMap` and `listSubsystems` from Tasks 2-3
- Produces:
  - `searchMemory(query, limit?, project?, {subsystem?}?)`
  - `getRecentContext({project, limit?, subsystem?})`
  - `getTimeline({project, since?, limit?, subsystem?, maxTextChars?, maxTotalChars?})`
  - MCP `memory_add_observations` gains an optional call-level `subsystem: string`

- [ ] **Step 1: Write the failing test**

Append to `tests/graph-subsystem.test.js`:

```js
test("searchMemory can be narrowed to one subsystem", async () => {
  const all = await graph.searchMemory("fact", 10, PROJECT);
  assert.ok(all.length >= 1, "sanity: the unfiltered search finds the test entity");

  const captureOnly = await graph.searchMemory("fact", 10, PROJECT, { subsystem: "capture" });
  const texts = captureOnly.flatMap((r) => r.observations);
  assert.ok(texts.length > 0, "filtered search still returns the matching observations");
  assert.ok(!texts.some((t) => t.includes("sha256")), "a backup observation must not leak through");
});

test("getRecentContext can be narrowed to one subsystem", async () => {
  const rows = await graph.getRecentContext({ project: PROJECT, subsystem: "backup" });
  const texts = rows.flatMap((r) => r.observations);
  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes("sha256"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/graph-subsystem.test.js`
Expected: FAIL — the `subsystem` option is ignored, so `backup` observations leak into the capture-filtered result.

- [ ] **Step 3: Filter `searchMemory`**

Change the signature at `graph.js:112` and add the parameter to the query. `EXISTS { … }` subqueries need Neo4j 5.x, which is what the container runs:

```js
export async function searchMemory(query, limit = 10, project = null, { subsystem = null } = {}) {
```

Three edits inside its Cypher. In the opening `CALL { … }` union, the name branch must drop entities with nothing in that subsystem, and the observation branch must filter directly:

```
       CALL {
         CALL db.index.fulltext.queryNodes('entityNameFulltext', $query) YIELD node, score
         WITH node AS entity, score
         WHERE $subsystem IS NULL
            OR EXISTS { MATCH (o:Observation)-[:ABOUT]->(entity) WHERE o.subsystem = $subsystem }
         RETURN entity, score
         UNION
         CALL db.index.fulltext.queryNodes('observationTextFulltext', $query) YIELD node, score
         WHERE $subsystem IS NULL OR node.subsystem = $subsystem
         MATCH (node)-[:ABOUT]->(entity)
         RETURN entity, score
       }
```

In the per-entity "observations that actually matched" subquery, add the same predicate after the `YIELD`:

```
         CALL db.index.fulltext.queryNodes('observationTextFulltext', $query) YIELD node, score AS obsScore
         WHERE $subsystem IS NULL OR node.subsystem = $subsystem
         MATCH (node)-[:ABOUT]->(entity)
```

And in the recent top-up:

```
       OPTIONAL MATCH (o:Observation)-[:ABOUT]->(entity)
       WHERE $subsystem IS NULL OR o.subsystem = $subsystem
```

Finally add it to the parameter map:

```js
      { query: escapeLuceneQuery(query), limit: int(limit), project: project ?? null, subsystem }
```

- [ ] **Step 4: Filter `getRecentContext` and `getTimeline`**

In `getRecentContext` (`graph.js:213`), change the signature and add one predicate:

```js
export async function getRecentContext({ project, limit = 15, subsystem = null }) {
```

```
       MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE ($project IS NULL OR e.project = $project OR e.project IS NULL)
         AND ($subsystem IS NULL OR o.subsystem = $subsystem)
```

and add `subsystem` to its parameter map.

In `getTimeline` (`graph.js:268`), add `subsystem = null` to the destructured options, then add `AND ($subsystem IS NULL OR o.subsystem = $subsystem)` to **both** the count query and the rows query, and `subsystem` to both parameter maps. Missing the count query would report a `total` larger than the filter can ever return, which is exactly the silently-wrong number `getTimeline` was written to avoid.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/graph-subsystem.test.js`
Expected: PASS — 5 tests, 0 failures

- [ ] **Step 6: Expose the filter over MCP**

In `src/mcp/server.js`, `memory_search` — add to the zod shape and pass it through:

```js
  {
    query: z.string().describe("Search text"),
    limit: z.number().int().min(1).max(50).optional(),
    subsystem: z.string().optional().describe("Narrow to one subsystem tag, as listed in the SessionStart memory map"),
  },
  async ({ query, limit, subsystem }) => {
    try {
      return textResult(await graph.searchMemory(query, limit ?? 10, project, { subsystem }));
```

`memory_recent` — same treatment:

```js
  {
    limit: z.number().int().min(1).max(50).optional(),
    subsystem: z.string().optional().describe("Narrow to one subsystem tag"),
  },
  async ({ limit, subsystem }) => {
    try {
      return textResult(await graph.getRecentContext({ project, limit: limit ?? 15, subsystem }));
```

`memory_timeline` — add `subsystem: z.string().optional().describe("Narrow to one subsystem tag")` to its shape and `subsystem` to both the handler destructuring and the `graph.getTimeline({ … })` call.

`memory_add_observations` — a **call-level** tag, not per-observation. One call is about one topic, and a union type would make the tool schema harder for a model to fill in correctly than it is worth:

```js
    observations: z.array(z.string()).min(1),
    subsystem: z
      .string()
      .optional()
      .describe("Area this batch belongs to, e.g. 'auto-capture', 'search'. Reuse a tag from the SessionStart memory map when one fits; omit for cross-cutting facts like user preferences."),
  },
  async ({ entity, entityType, observations, subsystem }) => {
    try {
      const ids = await graph.addObservations({
        entity,
        entityType,
        observations: observations.map((text) => ({ text, subsystem })),
        project,
      });
```

- [ ] **Step 7: Verify the tools over a real MCP handshake**

Run: `scripts/check-health.sh`
Expected: PASS on every check, including the MCP handshake.

---

### Task 6: The new injection

**Files:**
- Create: `src/lib/injection.js`
- Create: `tests/injection.test.js`
- Modify: `src/hooks/session-start.js:47-101`
- Modify: `scripts/token-cost.mjs:19,56-61`

**Interfaces:**
- Consumes: `getPinnedFacts` (Task 4), `getSubsystemMap` (Task 3), `UNTAGGED` (Task 1)
- Produces: `renderInjection({project: string, pinned: {facts: Array<{text: string}>, total: number, returned: number, truncated: boolean}, map: Array<{subsystem: string, observations: number, lastSeen: string}>}): string`

- [ ] **Step 1: Write the failing test**

Create `tests/injection.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInjection } from "../src/lib/injection.js";

const PROJECT = "github.com/troglodyte/claude-neo4j-mem";

const PINNED = {
  facts: [
    { text: "bound every read path by characters, not row count" },
    { text: "wants write confirmations visible in-band" },
  ],
  total: 2,
  returned: 2,
  truncated: false,
};

const MAP = [
  { subsystem: "capture", observations: 34, entities: 5, lastSeen: "2026-07-21T09:00:00Z" },
  { subsystem: "backup", observations: 21, entities: 3, lastSeen: "2026-07-20T09:00:00Z" },
  { subsystem: "(untagged)", observations: 126, entities: 19, lastSeen: "2026-07-19T09:00:00Z" },
];

test("renderInjection quotes pinned facts and indexes everything else", () => {
  const out = renderInjection({ project: PROJECT, pinned: PINNED, map: MAP });

  assert.ok(out.includes(PROJECT), "names the project it is scoped to");
  assert.ok(out.includes("bound every read path by characters"), "pinned facts appear verbatim");
  assert.ok(out.includes("capture (34, 07-21)"), "each tag carries its count and short date");
  assert.ok(out.includes("(untagged) (126"), "the untagged bucket is shown, not hidden");
  assert.ok(out.includes("memory_search"), "tells the model how to follow the index");
  assert.ok(!out.includes("memory_get_entity"), "no tool enumeration - MCP already registers those");
});

test("renderInjection stays inside its budget on realistic input", () => {
  const out = renderInjection({ project: PROJECT, pinned: PINNED, map: MAP });
  assert.ok(out.length < 6_000, `injection was ${out.length} chars`);
});

test("renderInjection says so when standing facts were dropped", () => {
  const clipped = { ...PINNED, total: 9, returned: 2, truncated: true };
  const out = renderInjection({ project: PROJECT, pinned: clipped, map: MAP });
  assert.ok(out.includes("7 more"), "names how many standing facts are missing");
  assert.ok(out.includes("memory_search"), "says how to read the rest");

  const whole = renderInjection({ project: PROJECT, pinned: PINNED, map: MAP });
  assert.ok(!whole.includes("more standing fact"), "no truncation note when nothing was dropped");
});

test("renderInjection omits empty sections rather than printing empty headings", () => {
  const none = { facts: [], total: 0, returned: 0, truncated: false };
  const noPinned = renderInjection({ project: PROJECT, pinned: none, map: MAP });
  assert.ok(!noPinned.includes("Always applies"));
  assert.ok(noPinned.includes("capture (34"));

  const empty = renderInjection({ project: PROJECT, pinned: none, map: [] });
  assert.ok(!empty.includes("Always applies"));
  assert.ok(!empty.includes("Tagged history"));
  assert.ok(empty.includes(PROJECT), "still identifies the project");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/injection.test.js`
Expected: FAIL — `Cannot find module '.../src/lib/injection.js'`

- [ ] **Step 3: Write `src/lib/injection.js`**

```js
// The SessionStart injection, as a pure function so it can be tested without a
// database and measured by scripts/token-cost.mjs without a second copy of the
// formatting drifting out of step with this one.
//
// It replaced a dump of the 15 most recently touched entities with three
// observations each (~6.4k chars, ~2.3k tokens, paid every session). That
// version was ordered by recency rather than by usefulness - standing
// preferences competed for slots with one-off decisions and usually lost - and
// carried no index, so nothing told the model what else was in memory.
//
// What replaces it has two parts, neither of which grows with the graph: the
// facts that always apply, verbatim, and a table of contents for the rest.
import { UNTAGGED } from "./subsystem.js";

// MCP already registers every memory_* tool with its own description, so
// restating their names here is duplication paid once per session for nothing.
// What's left is the behaviour MCP doesn't carry: when to write, and the one
// tool that is destructive if called unprompted.
const TOOLS_BLURB =
  "Log durable facts with memory_add_observations (auto-capture also runs at compaction and " +
  "session end, so you don't need to log everything manually). Never call memory_prune with " +
  "dryRun: false unless the user explicitly asks to clean up old memories.";

// Month-day only: the year is almost always the current one, and this string is
// repeated once per tag.
const shortDate = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(5, 10) : "?");

export function renderInjection({ project, pinned, map = [] }) {
  const sections = [`## Memory (Neo4j · ${project})`];

  const facts = pinned?.facts ?? [];
  if (facts.length > 0) {
    let block = `Always applies:\n${facts.map((fact) => `- ${fact.text}`).join("\n")}`;
    // A standing preference the model never sees may as well not exist, so if
    // the budget bit, say so rather than letting a partial list read as whole.
    if (pinned.truncated) {
      block +=
        `\n- [${pinned.total - pinned.returned} more standing fact(s) not shown — ` +
        `memory_search("preference") or memory_search("constraint") to read them]`;
    }
    sections.push(block);
  }

  if (map.length > 0) {
    const hasTags = map.some((row) => row.subsystem !== UNTAGGED);
    const how = hasTags ? "memory_search(subsystem: …) to read" : "memory_search to read";
    const cells = map.map((row) => `${row.subsystem} (${row.observations}, ${shortDate(row.lastSeen)})`);
    sections.push(`Tagged history — ${how}:\n  ${cells.join(" · ")}`);
  }

  sections.push(TOOLS_BLURB);
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/injection.test.js`
Expected: PASS — 3 tests, 0 failures

- [ ] **Step 5: Wire it into the hook**

In `src/hooks/session-start.js`: delete the `TOOLS_BLURB` constant (lines 47-55) — it now lives in `injection.js`. Update the imports:

```js
import { upsertSession, getPinnedFacts, getSubsystemMap } from "../lib/graph.js";
import { renderInjection } from "../lib/injection.js";
```

`getRecentContext` and `getStatus` are no longer used here; drop them from that import. Then replace lines 81-101 (from `const recent = …` through the closing brace of the `else`) with:

```js
    const [pinned, map] = await Promise.all([getPinnedFacts({ project }), getSubsystemMap(project)]);
    const additionalContext = renderInjection({ project, pinned, map });

    let systemMessage;
    if (map.length > 0) {
      const observationCount = map.reduce((sum, row) => sum + row.observations, 0);
      const tagCount = map.filter((row) => row.subsystem !== UNTAGGED).length;
      systemMessage =
        `\u{1f9e0} Neo4j memory: ${observationCount} observation(s) across ${tagCount} ` +
        `subsystem(s) for ${project}.`;
    } else {
      systemMessage = `\u{1f9e0} Neo4j memory: connected, nothing remembered yet for ${project}.`;
      const claudeMemCount = await claudeMemMigrationHint(project, cwd);
      if (claudeMemCount) {
        systemMessage +=
          ` Found ${claudeMemCount} claude-mem record(s) for this project - run ` +
          `\`npm run migrate-claude-mem\` to import them (one-off, only when you ask for it).`;
      }
    }
```

`additionalContext` becomes a `const`, so also remove the old `let additionalContext = …` line at 83. Add `UNTAGGED` to the imports:

```js
import { UNTAGGED } from "../lib/subsystem.js";
```

The digest, `sweepPendingCaptures`, and `pruneStaleState` blocks below stay exactly as they are.

- [ ] **Step 6: Run the hook against real stdin**

Run:
```bash
echo '{"session_id":"plan-test-1","cwd":"'"$PWD"'"}' | node src/hooks/session-start.js | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.hookSpecificOutput.additionalContext);console.error("\n--- "+j.hookSpecificOutput.additionalContext.length+" chars");})'
```
Expected: the new format prints — a `## Memory (Neo4j · …)` heading, an `Always applies:` block, a `Tagged history` line that is mostly `(untagged)` until Task 8's backfill runs, and a length under 6000.

- [ ] **Step 7: Point `token-cost.mjs` at the real renderer and tighten the ceiling**

In `scripts/token-cost.mjs`, lower the ceiling at line 19:

```js
  "SessionStart injection": 6_000,
```

Add the import next to the others:

```js
import { renderInjection } from "../src/lib/injection.js";
```

Then replace the injection measurement in `measure()` (lines 56-61) — this deletes the hand-rolled copy of the format, so the measurement can no longer drift from what the hook actually emits:

```js
  const recent = await graph.getRecentContext({ project, limit: 15 });
  const [pinned, map] = await Promise.all([graph.getPinnedFacts({ project }), graph.getSubsystemMap(project)]);
  // Calls the hook's own renderer rather than restating its format, so this
  // number cannot drift from what a session actually pays.
  results.push(["SessionStart injection", renderInjection({ project, pinned, map }).length, "per session, always"]);
```

- [ ] **Step 8: Measure the saving**

Run: `npm run token-cost -- --all`
Expected: every row PASSes, and `SessionStart injection` is well under 6000 characters on all four projects — down from ~6.4k on `claude-neo4j-mem`.

---

### Task 7: Auto-capture produces subsystem tags

**Files:**
- Create: `src/lib/extract.js`
- Modify: `src/hooks/capture.js:41-52,55-99,164-226,244-260,265-317`
- Create: `tests/capture-merge.test.js`

**Interfaces:**
- Consumes: `listSubsystems` (Task 2), `addObservations`'s object form (Task 2)
- Produces:
  - `extractStructured({input, systemPrompt, schema, timeoutMs, model?}): Promise<object>`
  - `runClaudeExtraction({input, systemPrompt, schema, timeoutMs, model?}): Promise<string>` — raw stdout
  - `capture.js` exports `mergeMemories` for the test

- [ ] **Step 1: Write the failing test**

Create `tests/capture-merge.test.js`. It imports `capture.js` for a pure helper, which is safe because the hook body is already guarded by an entry-point check:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMemories } from "../src/hooks/capture.js";

test("mergeMemories keeps each observation's subsystem across chunks", () => {
  const merged = mergeMemories([
    {
      entities: [
        {
          name: "plugin:neo4j-memory",
          type: "plugin",
          observations: [{ text: "capture retries up to 3 times", subsystem: "auto-capture" }],
        },
      ],
      relations: [],
    },
    {
      entities: [
        {
          name: "plugin:neo4j-memory",
          type: "plugin",
          observations: [{ text: "backup writes a .sha256 sidecar", subsystem: "backup" }],
        },
      ],
      relations: [],
    },
  ]);

  assert.equal(merged.entities.length, 1, "the same entity across chunks merges into one write");
  const subsystems = merged.entities[0].observations.map((o) => o.subsystem);
  assert.deepEqual(subsystems, ["auto-capture", "backup"], "tags survive the merge, one per observation");
});

test("mergeMemories still drops entities with no observations", () => {
  const merged = mergeMemories([{ entities: [{ name: "empty:stub", observations: [] }], relations: [] }]);
  assert.equal(merged.entities.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/capture-merge.test.js`
Expected: FAIL — `mergeMemories` is not exported from `capture.js`.

- [ ] **Step 3: Lift the spawn plumbing into `src/lib/extract.js`**

Create `src/lib/extract.js`, moving the body of `capture.js:167-216` verbatim and parameterizing what differs:

```js
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
```

- [ ] **Step 4: Rewire `capture.js` onto the shared module**

In `src/hooks/capture.js`:

Delete `runClaudeExtraction` (lines 164-216) and the `CAPTURE_MODEL` / `CLAUDE_BIN` constants (lines 41-46) — they now live in `extract.js`. Remove `spawn` from the `node:child_process` import **only if** nothing else uses it — `detachSessionEndCapture` (line 331) still does, so keep the import.

Add:

```js
import { extractStructured } from "../lib/extract.js";
import { listSubsystems } from "../lib/graph.js";
```

(extend the existing `graph.js` import rather than adding a second one).

Replace `extractMemories` (lines 218-226) with:

```js
async function extractMemories(transcriptText, knownNames, knownSubsystems, timeoutMs) {
  const structured = await extractStructured({
    input: transcriptText,
    systemPrompt: buildExtractionSystemPrompt(knownNames, knownSubsystems),
    schema: RECORD_MEMORIES_SCHEMA,
    timeoutMs,
  });
  return { entities: structured.entities ?? [], relations: structured.relations ?? [] };
}
```

- [ ] **Step 5: Ask the extraction for subsystems**

In `RECORD_MEMORIES_SCHEMA` (line 70), change the `observations` property from an array of strings to an array of objects:

```js
          observations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                subsystem: { type: "string" },
              },
              required: ["text"],
            },
          },
```

Then replace `buildExtractionSystemPrompt` (lines 55-68):

```js
function buildExtractionSystemPrompt(knownNames, knownSubsystems = []) {
  let prompt = `You extract durable, worth-remembering facts from a slice of a coding-assistant conversation transcript.
Respond with JSON matching the given schema:
- entities: distinct people, projects, decisions, or preferences/conventions mentioned, each as {name, type, observations}. Use short stable names (e.g. "user", "decision:auth-approach", "preference:testing", "project:<repo>"). Only include observations that would still be useful in a future, unrelated session - skip step-by-step task narration, file paths, or anything ephemeral to this one task.
- each observation is {text, subsystem}. subsystem is a short lowercase kebab-case area of the codebase or product that the fact belongs to, e.g. "auto-capture", "search", "backup". One entity's observations may span several subsystems - tag each one on its own merits rather than giving them all the entity's topic. Omit subsystem entirely for cross-cutting facts such as user preferences or project-wide constraints.
- relations: {from, to, type} triples linking entities, e.g. {from: "project:claude-neo4j", type: "uses", to: "neo4j-driver"}.
If nothing is worth remembering, respond with empty arrays for both.`;
  if (knownNames.length) {
    prompt +=
      `\n\nThese entity names already exist in memory for this project - if a fact in this transcript is about ` +
      `one of them, reuse the exact existing name below instead of inventing a new one (e.g. don't create ` +
      `"plugin:foo" if "project:foo" already refers to the same thing):\n${knownNames.map((n) => `- ${n}`).join("\n")}`;
  }
  if (knownSubsystems.length) {
    prompt +=
      `\n\nThese subsystem tags are already in use for this project. Prefer one of them; only invent a new ` +
      `tag when none genuinely fits, because near-duplicate tags fragment the index these feed:\n` +
      knownSubsystems.map((s) => `- ${s}`).join("\n");
  }
  return prompt;
}
```

- [ ] **Step 6: Thread the vocabulary through `runCapture` and export `mergeMemories`**

Change `mergeMemories`'s declaration (line 244) to `export function mergeMemories(results) {` — its body needs no change, since it copies whatever the observation elements are.

In `runCapture`, fetch the vocabulary alongside the entity names (line 278) and pass it to both the extraction and the writes:

```js
  const project = detectProject(cwd);
  const knownNames = await listEntityNames(project);
  const knownSubsystems = (await listSubsystems(project)).map((s) => s.subsystem);
```

```js
  const extracted = [];
  for (const chunk of chunks) {
    extracted.push(await extractMemories(chunk, knownNames, knownSubsystems, timeoutMs));
  }
```

```js
  for (const entity of memories.entities) {
    await addObservations({
      entity: entity.name,
      entityType: entity.type,
      observations: entity.observations,
      sessionId,
      project,
      existingNames: seenNames,
      existingSubsystems: knownSubsystems,
    });
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test tests/capture-merge.test.js`
Expected: PASS — 2 tests, 0 failures

- [ ] **Step 8: Drive a real extraction end to end**

Build a synthetic transcript and run the hook, exactly as the PreCompact path does:

```bash
T="$(mktemp -d)/transcript.jsonl"
python3 - "$T" <<'PY'
import json, sys
turns = [
  ("user", "The backup script should write a .sha256 sidecar because load --info only reads the archive header."),
  ("assistant", "Agreed. I also raised the auto-capture timeout to 180s after the detached worker kept being killed at 90s."),
  ("user", "Good. And searching for entity names was broken because Lucene reads the colon as a field separator."),
]
with open(sys.argv[1], "w") as f:
    for role, text in turns:
        f.write(json.dumps({"message": {"role": role, "content": [{"type": "text", "text": text}]}}) + "\n")
PY
echo '{"session_id":"plan-test-extract","transcript_path":"'"$T"'","cwd":"'"$PWD"'","hook_event_name":"PreCompact"}' \
  | node src/hooks/capture.js
```

Expected: the hook exits 0. Then confirm tags were assigned:

```bash
bash scripts/cypher.sh "MATCH (o:Observation {sessionId:'plan-test-extract'}) RETURN o.subsystem AS subsystem, o.text AS text"
```
Expected: several rows with non-null subsystems such as `backup`, `auto-capture`, `search`.

- [ ] **Step 9: Delete the test data**

Per this repo's convention, smoke-test data does not stay in the graph:

```bash
bash scripts/cypher.sh "MATCH (o:Observation {sessionId:'plan-test-extract'}) DETACH DELETE o"
bash scripts/cypher.sh "MATCH (e:Entity) WHERE NOT (:Observation)-[:ABOUT]->(e) DETACH DELETE e"
rm -f ~/.claude-neo4j/state/plan-test-extract.json
```

---

### Task 8: Backfill the 1470 existing observations

**Files:**
- Create: `scripts/backfill-subsystems.mjs`
- Modify: `package.json` (new `backfill-subsystems` script)

**Interfaces:**
- Consumes: `extractStructured` (Task 7), `listSubsystems` (Task 2), `normalizeSubsystem`/`resolveSubsystem` (Task 1)
- Produces: a CLI — `npm run backfill-subsystems [-- --dry-run] [-- --project NAME]`

- [ ] **Step 1: Write the script**

Create `scripts/backfill-subsystems.mjs`:

```js
#!/usr/bin/env node
// One-off: assigns Observation.subsystem to observations captured before
// subsystem tagging existed. Without it the SessionStart map reads "(untagged)"
// for everything and the feature it was built for does nothing on day one.
//
// Entities are processed largest-first on purpose: the junk drawers hold the
// most observations and therefore establish the vocabulary that every smaller
// entity then reuses, which is what stops the map fragmenting.
//
// Usage:
//   node scripts/backfill-subsystems.mjs                 every project
//   node scripts/backfill-subsystems.mjs --project NAME  one project
//   node scripts/backfill-subsystems.mjs --dry-run       classify, don't write
import { withSession, closeDriver } from "../src/lib/neo4jClient.js";
import { ensureSchema } from "../src/lib/schema.js";
import { listSubsystems } from "../src/lib/graph.js";
import { extractStructured } from "../src/lib/extract.js";
import { resolveSubsystem } from "../src/lib/subsystem.js";

// One entity's observations can run to hundreds; batching keeps each prompt
// well inside a sensible input size and makes the run resumable at batch
// granularity rather than entity granularity.
const BATCH_SIZE = 40;
// Classification needs the gist, not the whole observation - the longest live
// observations run to ~4k chars and reading them in full would cost far more
// than the tag is worth.
const CLASSIFY_TEXT_CHARS = 400;
const TIMEOUT_MS = 180_000;

const SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, subsystem: { type: "string" } },
        required: ["id", "subsystem"],
      },
    },
  },
  required: ["assignments"],
};

function parseArgs(argv) {
  const flags = { project: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") flags.project = argv[++i];
    else if (argv[i] === "--dry-run") flags.dryRun = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/backfill-subsystems.mjs [--project NAME] [--dry-run]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return flags;
}

// Only ever selects untagged observations, so the script is idempotent and a
// re-run after an interruption picks up exactly what is left.
async function untaggedEntities(project) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE ($project IS NULL OR e.project = $project) AND o.subsystem IS NULL
       WITH e, collect({id: o.id, text: o.text}) AS observations
       RETURN e.name AS name, e.type AS type, e.project AS project, observations,
              size(observations) AS pending
       ORDER BY pending DESC`,
      { project: project ?? null }
    );
    return result.records.map((r) => r.toObject());
  });
}

async function writeTags(rows) {
  return withSession(async (session) => {
    const result = await session.run(
      `UNWIND $rows AS row
       MATCH (o:Observation {id: row.id})
       SET o.subsystem = row.subsystem
       RETURN count(o) AS updated`,
      { rows }
    );
    return result.records[0]?.get("updated").toNumber() ?? 0;
  });
}

function buildPrompt(entity, vocabulary) {
  let prompt = `You are labelling stored memory observations with the subsystem each one belongs to.
All of these observations are attached to the entity "${entity.name}"${entity.type ? ` (type: ${entity.type})` : ""} in project "${entity.project}".
A subsystem is a short lowercase kebab-case area of the codebase or product, e.g. "auto-capture", "search", "backup", "gui", "save-format".
Return one assignment per observation id you were given. Judge each observation on its own merits - one entity's observations routinely span several subsystems.
For a fact that is genuinely cross-cutting (a user preference, a project-wide constraint), use the subsystem "general".`;
  if (vocabulary.length) {
    prompt +=
      `\n\nThese tags are already in use for this project. Prefer one of them; invent a new tag only when ` +
      `none genuinely fits:\n${vocabulary.map((s) => `- ${s}`).join("\n")}`;
  }
  return prompt;
}

async function main() {
  const { project, dryRun } = parseArgs(process.argv.slice(2));
  await ensureSchema();

  const entities = await untaggedEntities(project);
  if (!entities.length) {
    console.log("Nothing to do - every observation already has a subsystem.");
    return;
  }

  const pending = entities.reduce((sum, e) => sum + e.pending, 0);
  console.log(`${entities.length} entities, ${pending} untagged observations${dryRun ? " (dry run)" : ""}\n`);

  // Vocabulary accumulates per project across the run, so an entity processed
  // late converges on the tags the big entities established early.
  const vocabularies = new Map();
  let tagged = 0;

  for (const entity of entities) {
    if (!vocabularies.has(entity.project)) {
      vocabularies.set(entity.project, (await listSubsystems(entity.project)).map((s) => s.subsystem));
    }
    const vocabulary = vocabularies.get(entity.project);

    for (let start = 0; start < entity.observations.length; start += BATCH_SIZE) {
      const batch = entity.observations.slice(start, start + BATCH_SIZE);
      const input = batch
        .map((o) => `${o.id}\n${o.text.slice(0, CLASSIFY_TEXT_CHARS)}`)
        .join("\n\n---\n\n");

      let assignments;
      try {
        const structured = await extractStructured({
          input,
          systemPrompt: buildPrompt(entity, vocabulary),
          schema: SCHEMA,
          timeoutMs: TIMEOUT_MS,
        });
        assignments = structured.assignments ?? [];
      } catch (error) {
        console.error(`  ! ${entity.name}: ${error.message} - skipping this batch, re-run to retry`);
        continue;
      }

      const known = new Set(batch.map((o) => o.id));
      const rows = [];
      for (const assignment of assignments) {
        if (!known.has(assignment.id)) continue; // ignore hallucinated ids
        const slug = resolveSubsystem(assignment.subsystem, vocabulary);
        if (!slug) continue;
        if (!vocabulary.includes(slug)) vocabulary.push(slug);
        rows.push({ id: assignment.id, subsystem: slug });
      }

      const counts = rows.reduce((acc, r) => ({ ...acc, [r.subsystem]: (acc[r.subsystem] ?? 0) + 1 }), {});
      const summary = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s} ${n}`)
        .join(", ");
      console.log(`  ${entity.name} [${batch.length}] → ${summary || "(nothing assigned)"}`);

      // Written per batch, not at the end, so an interrupted run keeps its work.
      if (!dryRun && rows.length) tagged += await writeTags(rows);
    }
  }

  console.log(`\n${dryRun ? "Would tag" : "Tagged"} ${dryRun ? pending : tagged} observation(s).`);
}

main()
  .catch((error) => {
    console.error(`backfill-subsystems: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(closeDriver);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, next to `migrate-claude-mem`:

```json
    "backfill-subsystems": "node scripts/backfill-subsystems.mjs",
```

- [ ] **Step 3: Dry-run one project**

Run: `npm run backfill-subsystems -- --project github.com/troglodyte/claude-neo4j-mem --dry-run`
Expected: entities listed largest-first (`plugin:neo4j-memory` first, ~65 pending), each showing a tag breakdown, and a closing "Would tag N observation(s)". Nothing is written.

- [ ] **Step 4: Confirm the dry run wrote nothing**

Run: `bash scripts/cypher.sh "MATCH (o:Observation) WHERE o.subsystem IS NOT NULL RETURN count(o) AS tagged"`
Expected: `0` (or only whatever Task 7's real extraction left behind, if that data was kept).

---

### Task 9: Ship it

**Files:**
- Modify: `scripts/memory-usage.sh` (new hygiene warning, after the empty-stub block ending at line ~126)
- Modify: `.claude-plugin/plugin.json`, `package.json` (version → `0.3.0`)
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1-8
- Produces: a tagged graph and a released 0.3.0

- [ ] **Step 1: Add the fragmentation warning**

In `scripts/memory-usage.sh`, after the `ORPHANS` block and before `if [ -n "$WARNINGS" ]`:

```sh
# Too many subsystem tags means the map they feed has stopped being a map. The
# usual cause is near-synonyms ("capture" and "auto-capture") that the lexical
# deduper can't merge because they aren't lexically close.
TAGS="$(run_query "
MATCH (o:Observation)-[:ABOUT]->(e:Entity) WHERE o.subsystem IS NOT NULL
WITH e.project AS project, count(DISTINCT o.subsystem) AS tags
WHERE tags > 12
RETURN '  ' + coalesce(project,'no project') + ': ' + toString(tags) + ' distinct subsystems' AS row
ORDER BY tags DESC;")"
if [ -n "$TAGS" ]; then
  WARNINGS="${WARNINGS}Projects with a fragmented subsystem map (merge near-synonyms):
${TAGS}

"
fi
```

- [ ] **Step 2: Run the real backfill**

Run: `npm run backfill-subsystems`
Expected: ~134 entities processed, a per-entity tag breakdown, and a closing count near 1470. Errors on individual batches are non-fatal — the script says to re-run.

- [ ] **Step 3: Re-run to confirm idempotence**

Run: `npm run backfill-subsystems`
Expected: either `Nothing to do - every observation already has a subsystem.` or a small residue from batches that errored the first time. Running it twice must never re-tag anything already tagged.

- [ ] **Step 4: Check the resulting map is not fragmented**

Run: `npm run usage`
Expected: the projects table, and **no** "fragmented subsystem map" warning. If one appears, merge the near-synonyms it names:

```bash
bash scripts/cypher.sh "MATCH (o:Observation) WHERE o.subsystem = 'auto-capture' SET o.subsystem = 'capture'"
```

- [ ] **Step 5: Measure the saving for real**

Run: `npm run token-cost -- --all`
Expected: every row PASSes. `SessionStart injection` should land near ~4.6k characters on `claude-neo4j-mem`, against the pre-change ~6.4k.

- [ ] **Step 6: Run the whole suite**

Run: `npm test && scripts/check-health.sh`
Expected: `all checks passed` from the launcher guard, `pass`/`fail 0` from the node runner, and PASS on every health check.

- [ ] **Step 7: Verify end to end in a real session**

Run: `scripts/claude-with-memory.sh`

Expected, inside that session:
- the SessionStart banner reads `🧠 Neo4j memory: N observation(s) across M subsystem(s) for …`
- ask "what does the memory map say?" — the injected `Tagged history` line comes back with real tags, not `(untagged)`
- ask it to call `memory_search` with `subsystem: "capture"` — results come back scoped to that tag, proving the map's pointers resolve

- [ ] **Step 8: Bump the version**

Set `"version": "0.3.0"` in **both** `.claude-plugin/plugin.json` and `package.json`. `claude plugin update` compares that string and is a no-op without it, so every other project would keep loading the 0.2.0 snapshot indefinitely.

- [ ] **Step 9: Update the docs**

In `CHANGELOG.md`, retitle the `## Unreleased — 0.3.0` heading to
`## 0.3.0 — 2026-07-22` and confirm its entries cover the whole feature: the
`subsystem` property and its index, the new injection shape, the `subsystem`
filter on the read tools, `npm run backfill-subsystems`, and the fragmented-map
warning in `npm run usage`. The controller appends an entry per task as the plan
runs, so this step is a completeness check rather than a from-scratch write.

In `README.md`, document the `subsystem` parameter on `memory_search` / `memory_recent` / `memory_timeline` and on `memory_add_observations`, and add `npm run backfill-subsystems` to the commands list.

In `CLAUDE.md`, add a section recording what changed and why — the injection shape, why tags live on observations rather than entities, and that `npm run usage` now warns on a fragmented map. Update the "Token-cost budgets" table's SessionStart row from `~2.3k tok` to the measured new figure.

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
| --- | --- |
| Data model (`Observation.subsystem`, index) | 2 |
| Vocabulary control (`listSubsystems`, prompt, `resolveCanonicalName`, usage warning) | 1, 2, 7, 9 |
| `getSubsystemMap` | 3 |
| `getPinnedFacts` + budgets | 4 |
| Injection format + shrunken `TOOLS_BLURB` | 6 |
| Making the map followable (filters + MCP) | 5 |
| Write path accepts both shapes | 2, 5 |
| Backfill script + `extract.js` lift | 7, 8 |
| Verification (token-cost ceiling, tests, e2e, version bump) | 6, 9 |

**Placeholder scan:** none — every code step carries complete code, every command carries expected output.

**Type consistency:** `getSubsystemMap` returns `{subsystem, observations, entities, lastSeen}` in Task 3 and is consumed with exactly those field names in Tasks 6 and 9. `getPinnedFacts` returns `{entity, type, text}` in Task 4 and Task 6 reads `.text`. `listSubsystems` returns `{subsystem, observations}` objects, and every caller maps to `.subsystem` before passing a `string[]` to `resolveSubsystem`. `UNTAGGED` is defined once in Task 1 and imported by Tasks 3 and 6.
