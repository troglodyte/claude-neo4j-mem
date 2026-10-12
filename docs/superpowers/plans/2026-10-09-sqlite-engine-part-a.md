# SQLite Engine, Part A: The Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `graph.js` stores and searches memory in SQLite instead of Neo4j, keeping its 16 functions and their signatures. Search results say which way each relation points, session start collapses repeated standing facts, and `npm run memory -- dupes` lists likely repeats for review.

**Architecture:** The engine is built as `sqliteGraph.js` beside today's `graph.js`, in three tasks, each with its own tests. Supporting units sit underneath it:

- `memoryStore.js`: the connection
- `segment.js`: Lucene-style word splitting
- `search.js`: ranking
- `similarity.js`: word overlap
- schema version 2 in `sqliteDb.js`: the full-text tables

Task 10 then replaces `graph.js` with it. It points the four existing `graph-*` test files at temporary stores, so the tests written against Neo4j now prove the SQLite engine. It also rewires every caller from the Neo4j lifecycle (`ensureSchema`, `verifyConnectivity`, `closeDriver`) to the store's.

**Not a release on its own.** Until Part B's first-start migration exists, the engine opens an empty `~/.claude-neo4j/memory.sqlite`. Do not tag, release or install the plugin from this branch before Part B lands.

**Tech Stack:** Node ESM, `node:sqlite` with FTS5, `Intl.Segmenter`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-09-sqlite-engine-design.md`. Part A only: launcher, first-start migration, catch-up, script ports and docs are Part B.

## Global Constraints

- Node 22.13 or later (or 23.4+, or 24+), where `node:sqlite` needs no flag. No new npm dependencies.
- **No test may reach the live Neo4j.** Until Task 10 lands, the four `graph-*.test.js` files and `capture-hook.test.js`'s success test write to whatever `~/.claude-neo4j/config.json` points at. So:
  - Every `node --test` command in this plan runs with `HOME` set to a fresh temporary directory, where no config exists.
  - Whole-suite runs leave `graph-*` out until Task 10.
  - Never run `npm test` before Task 10.

  While this plan was being verified, tests pointed at `graph.js` ran against the Neo4j engine and wrote 688 observations into the live graph. The two whole-suite commands:

  ```bash
  HOME="$(mktemp -d)" node --test $(ls tests/*.test.js | grep -v '/graph-')
  HOME="$(mktemp -d)" node --test tests/*.test.js
  ```

  The first is for before Task 10, the second from Task 10 on.
- ESM; builtins use the `node:` prefix. Source files in `src/lib/` are camelCase; tests are kebab-case `tests/*.test.js`.
- **Braces.** After every Edit or Write of a `.js`/`.mjs` file, the jht-skills hook flags any line in the whole file that is a one-line `if`, `for`, `while` or `else` body, even inside a template string. Task 0 braces the existing files this plan edits. Brace every body you write.
- The complexity hook warns above 10 per function. Keep new functions small; it is advisory.
- `graph.js` keeps every exported name and signature. `findRepeatedFacts` is the only addition.
- Storage follows the spec: version-2 full-text DDL exactly as written there, global entities stored as `project = ''` and returned as `null`, timestamps as integer milliseconds and returned as `new Date(ms).toISOString()`.
- Thresholds, exact:
  - `REPEAT_COLLAPSE_OVERLAP = 0.8`
  - `REPEAT_REVIEW_OVERLAP = 0.3`
  - parity gates: top-1 agreement ≥ 0.95, relevance-label agreement ≥ 0.95, the same empty queries on both
- Commits follow the jht-skills commit skill: `type(scope): Capitalised subject`, plus a `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.

## Review Focus

1. **Several processes open a brand-new store at once.** On a first session, the session-start hook and the memory server start together. All should succeed, with one schema. Two races were found and reproduced while verifying this plan:
   - SQLite's switch to WAL ignores the busy timeout.
   - The version read and the emptiness read see different snapshots.

   Test: Task 4, "processes opening a brand-new store at the same moment all succeed".
2. **Two processes write at once**, such as a capture hook and the memory server. Both writes should land, because the busy timeout makes one wait. Test: Task 5, "two processes writing at the same moment both land".
3. **A query containing FTS5 syntax** (`AND`, `OR`, `NEAR`, quotes, `*`, `name:`). It should be searched as plain words, never cause a syntax error. Test: Task 9, "FTS5 syntax in a query is searched as plain words".
4. **A query with no searchable words** (`"-- !!"`). It should give an empty result with relevance `none`, not an error. Test: Task 9, "a query with no words finds nothing and says so".
5. **An observation with emoji or an unpaired surrogate** (left by `truncateText`). It should be stored (the surrogate as U+FFFD) and be findable by its other words. Test: Task 5, "text with emoji or a broken character is stored and found by its words".

---

## File Structure

| file | responsibility |
| --- | --- |
| `src/lib/similarity.js` | `wordSet`, `wordOverlap`: the Jaccard rule the repeat thresholds were measured with. |
| `src/lib/segment.js` | `segmentWords`, `indexText`, `matchQuery`: UAX #29 words for the index and FTS5 queries. |
| `src/lib/sqliteDb.js` | Schema version 2 (full-text tables), the 1→2 upgrade, `syncFullText`; safe concurrent first opens. |
| `src/lib/config.js` | `memoryDbPath()`. |
| `src/lib/memoryStore.js` | `getDb`, `closeDb`, `storeStatus`, `inTransaction`. |
| `src/lib/sqliteGraph.js` → `graph.js` | The engine: the 16 functions plus `findRepeatedFacts`. Renamed onto `graph.js` in Task 10. |
| `src/lib/search.js` | `searchRows`: ranking, matched and newest observations, relations with direction, matched-word count. |
| `src/lib/relevance.js` | `queryWords`, matched-word relevance, the weak note; `WEAK_SCORE` kept for legacy telemetry. |
| `src/lib/fallback.js` | Cross-project fallback judged by word coverage only. |
| `src/lib/telemetry.js` | Logs each search's relevance label and judges weak reads by it. |
| `src/lib/dupesReport.js` | `formatDupes`: likely repeats as text for `memory -- dupes`. |
| `src/lib/searchParity.js` | `parityReport`, `passesGates`. |
| `scripts/search-parity.mjs` | Replays logged searches through Lucene-era Neo4j search and the SQLite engine. |
| `tests/helpers/tempStore.js` | `useTempStore()`. |

All paths are relative to `plugins/jht-skills/` in the worktree `~/code/jht-skills/.claude/worktrees/memory-sqlite-engine` (branch `feat/memory-sqlite-engine`).

## Before you start

- [ ] **Check the baseline**

```bash
cd ~/code/jht-skills/.claude/worktrees/memory-sqlite-engine/plugins/jht-skills
node --version
ls node_modules/neo4j-driver/package.json
HOME="$(mktemp -d)" node --test $(ls tests/*.test.js | grep -v '/graph-') 2>&1 | grep -E '^# (tests|pass|fail|skipped) '
```

Expected:

- Node `v22.13.0` or later.
- `neo4j-driver` present.
- `# tests 188`, `# pass 182`, `# fail 0`, `# skipped 6`. The skips are the 5 gated migration-rehearsal tests and `capture-hook`'s success test, which has no Neo4j to reach under a temporary `HOME`.

`engine-resolve.test.sh` has one failure that predates this branch and is out of scope.

---

### Task 0: Brace the files this plan edits

Style only, so later diffs carry logic only and the brace hook stays quiet on them.

**Files:**
- Modify:
  - `src/lib/config.js`
  - `src/lib/telemetry.js`
  - `src/hooks/session-start.js`
  - `src/hooks/capture.js`
  - `scripts/memory-cli.mjs`
  - `scripts/token-cost.mjs`
  - `tests/graph-pinned.test.js`
  - `tests/capture-hook.test.js`

These eight hold 54 brace-less lines between them. Every other file this plan edits has none.

**Interfaces:** none.

- [ ] **Step 1: Save the bracing script outside the repo**

```bash
BRACE_DIR="$(mktemp -d)"
cat > "$BRACE_DIR/brace.mjs" <<'EOF'
// Braces one-line if/for/while/else bodies in place, so the jht-skills brace
// hook passes: `if (x) y;` becomes a three-line block, and the `else if` /
// `else` lines that follow one join it as `} else if (…) {` / `} else {`.
// Style only; behaviour is unchanged.   node brace.mjs FILE...
import fs from "node:fs";

// Index of the parenthesis closing the one at `start`, skipping string contents; -1 if none.
function closingParen(line, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

const STATEMENT = /^[^{\s].*;\s*(\/\/.*)?$/;

// `[} ][else ]if|for|while (…) rest` split into its parts, or null.
function parseLine(line) {
  const m = line.match(/^(\s*)(\}\s*)?(else\s+)?(?:(if|for|while)\s*\(|(\{|[^\s{]))/);
  if (!m || (!m[3] && !m[4])) {
    return null;
  }
  const indent = m[1];
  const lead = `${m[2] ? "} " : ""}${m[3] ? "else " : ""}`;
  if (!m[4]) {
    return { indent, closes: Boolean(m[2]), isElse: true, head: lead.trim(), rest: line.slice(m[0].length - 1).trim() };
  }
  const open = line.indexOf("(", m[1].length + (m[2]?.length ?? 0) + (m[3]?.length ?? 0));
  const close = closingParen(line, open);
  if (close < 0) {
    return null;
  }
  const head = `${lead}${m[4]} ${line.slice(open, close + 1)}`;
  return { indent, closes: Boolean(m[2]), isElse: Boolean(m[3]), head, rest: line.slice(close + 1).trim() };
}

for (const file of process.argv.slice(2)) {
  const out = [];
  let joinable = false; // the last line out is a `}` this script wrote
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const p = parseLine(line);
    const braceless = p && STATEMENT.test(p.rest);
    const joins = p && p.isElse && !p.closes && joinable;
    if (!braceless && !(joins && p.rest.startsWith("{"))) {
      out.push(line);
      joinable = false;
      continue;
    }
    const indent = joins ? out.pop().match(/^\s*/)[0] : p.indent;
    const head = joins ? `} ${p.head}` : p.head;
    if (braceless) {
      out.push(`${indent}${head} {`, `${indent}  ${p.rest}`, `${indent}}`);
      joinable = true;
    } else {
      out.push(`${indent}${head} ${p.rest}`);
      joinable = false;
    }
  }
  fs.writeFileSync(file, out.join("\n"));
}
EOF
echo "$BRACE_DIR"
```

- [ ] **Step 2: Brace the eight files and check them**

```bash
FILES="src/lib/config.js src/lib/telemetry.js src/hooks/session-start.js src/hooks/capture.js scripts/memory-cli.mjs scripts/token-cost.mjs tests/graph-pinned.test.js tests/capture-hook.test.js"
node "$BRACE_DIR/brace.mjs" $FILES
for f in $FILES; do node --check "$f"; done
grep -nE '^[[:space:]]*(if|for|while)[[:space:]]*\(.*\)[[:space:]]*[^{[:space:]].*;[[:space:]]*(//.*)?$' $FILES
grep -nE '(^|[}[:space:]])else[[:space:]]+[^{[:space:]]' $FILES | grep -vE 'else[[:space:]]+if|:[0-9]+:[[:space:]]*//'
git --no-pager diff --no-ext-diff --no-color --stat
```

Expected:

- `node --check` prints nothing.
- Both `grep`s print nothing.
- The diff stat shows the eight files. Read the diff once: every change is a body moving inside braces, and the two `if … else` pairs (`capture.js` `mergeMemories`, `memory-cli.mjs` `get`) read `} else {`.

- [ ] **Step 3: Run the suite to confirm nothing changed**

Run: `HOME="$(mktemp -d)" node --test $(ls tests/*.test.js | grep -v '/graph-') 2>&1 | grep -E '^# (tests|pass|fail|skipped) '`
Expected: the baseline again, `# tests 188`, `# pass 182`, `# fail 0`, `# skipped 6`.

- [ ] **Step 4: Commit**

```bash
git add $FILES
git commit -m "style(memory): Brace one-line if/else bodies in the files this plan edits" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Word overlap

**Files:**
- Create: `src/lib/similarity.js`
- Test: `tests/similarity.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `wordSet(text): Set<string>`, `wordOverlap(a: string, b: string): number` (0 to 1).

- [ ] **Step 1: Write the failing tests**

`tests/similarity.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { wordOverlap, wordSet } from "../src/lib/similarity.js";

test("identical texts overlap completely", () => {
  assert.equal(wordOverlap("Email: someone@example.com", "Email: someone@example.com"), 1);
});

test("texts with no shared words do not overlap", () => {
  assert.equal(wordOverlap("prefers pnpm", "deploys on fridays"), 0);
});

test("overlap is shared words over all distinct words", () => {
  // {prefers, pnpm, over, npm} and {prefers, pnpm, over, yarn}: 3 shared of 5.
  assert.equal(wordOverlap("prefers pnpm over npm", "prefers pnpm over yarn"), 0.6);
});

test("case and punctuation are ignored, and words under three characters do not count", () => {
  assert.deepEqual([...wordSet("Use `pnpm`, NOT npm -- ok?")], ["use", "pnpm", "not", "npm"]);
  assert.equal(wordOverlap("a b c", "a b c"), 0, "no countable words means no overlap");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/similarity.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/similarity.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/similarity.js`:

```js
// Word overlap between two texts: the Jaccard index of their sets of lowercase
// ASCII words of three or more characters. The repeat thresholds that use it
// were measured with exactly this rule on 693 real standing facts (engine spec,
// "Fix 2"), so changing the word rule means measuring them again.
export function wordSet(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((word) => word.length > 2));
}

export function wordOverlap(a, b) {
  const left = wordSet(a);
  const right = wordSet(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `HOME="$(mktemp -d)" node --test tests/similarity.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/similarity.js tests/similarity.test.js
git commit -m "feat(memory): Add word overlap for repeated facts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Word segmentation

**Files:**
- Create: `src/lib/segment.js`
- Test: `tests/segment.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `segmentWords(text): string[]`, `indexText(text): string`, `matchQuery(query): string | null` (an FTS5 MATCH expression).

- [ ] **Step 1: Write the failing tests**

`tests/segment.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentWords, indexText, matchQuery } from "../src/lib/segment.js";

test("inner colons, dots and underscores keep a word whole; hyphens split", () => {
  assert.deepEqual(segmentWords("feature:capture-visibility"), ["feature:capture", "visibility"]);
  assert.deepEqual(segmentWords("tool:cypher.sh"), ["tool:cypher.sh"]);
  assert.deepEqual(segmentWords("snake_case_name"), ["snake_case_name"]);
  assert.deepEqual(segmentWords("AS-64"), ["as", "64"]);
});

test("words are lowercased, and punctuation and emoji are dropped", () => {
  assert.deepEqual(segmentWords("Deploy 🚀 DONE!"), ["deploy", "done"]);
});

test("indexText joins the words with single spaces", () => {
  assert.equal(indexText("  The   capture hook, again "), "the capture hook again");
});

// Lucene counts a repeated query word twice; so does FTS5 when it is ORed twice.
test("matchQuery quotes every word and ORs them, repeats included", () => {
  assert.equal(matchQuery("capture Capture hook"), '"capture" OR "capture" OR "hook"');
  assert.equal(matchQuery("feature:capture-visibility"), '"feature:capture" OR "visibility"');
});

test("a query with no words has no match expression", () => {
  assert.equal(matchQuery("-- ?? !!"), null);
  assert.equal(matchQuery(""), null);
});

test("FTS5 operators in a query become quoted words", () => {
  assert.equal(matchQuery('AND "hi" NEAR'), '"and" OR "hi" OR "near"');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/segment.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/segment.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/segment.js`:

```js
// Text split the way Neo4j's full-text index (Lucene's standard analyzer) did:
// UAX #29 word boundaries, lowercased. A word keeps its inner ':', '.', '_' and
// apostrophes ("feature:capture", "cypher.sh", "snake_case", "don't"); hyphens
// and spaces split. Measured against Neo4j on 214 logged searches: the same top
// result on 196 of 200.
const segmenter = new Intl.Segmenter("en", { granularity: "word" });

export function segmentWords(text) {
  return [...segmenter.segment(String(text ?? "").toLowerCase())]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
}

/** What a full-text row stores: the segmented words joined by single spaces. */
export function indexText(text) {
  return segmentWords(text).join(" ");
}

/**
 * An FTS5 MATCH expression for any of the query's words, each quoted so FTS5
 * reads none of it as syntax; null when the query has no words. A repeated word
 * is kept, so it weighs double in bm25 as it did in Lucene: dropping repeats
 * cost three top results in the parity replay.
 */
export function matchQuery(query) {
  const words = segmentWords(query);
  if (words.length === 0) {
    return null;
  }
  return words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR ");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `HOME="$(mktemp -d)" node --test tests/segment.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/segment.js tests/segment.test.js
git commit -m "feat(memory): Split text into words the way Lucene did" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Full-text tables (schema version 2)

**Files:**
- Modify: `src/lib/sqliteDb.js`
- Modify: `src/lib/migrate/writeSqlite.js` (`writeGraph` fills the full-text rows)
- Test: `tests/sqlite-db.test.js`, `tests/migrate-write.test.js`

**Interfaces:**
- Consumes: `indexText` (Task 2).
- Produces:
  - `SCHEMA_VERSION = 2`
  - `syncFullText(db): { entities: number, observations: number }`
  - `openMemoryDb` upgrades version 1 to 2 on writable opens, and accepts 1 or 2 read-only.
  - `integrityReport(db).ok` accepts version 1 or 2.

- [ ] **Step 1: Write the failing tests**

In `tests/sqlite-db.test.js`:

- Add `syncFullText` to the import from `../src/lib/sqliteDb.js`.
- Replace the first test (`"a new file gets the schema, version 1 and mode 0600"`) with the two below. Full-text tables add `sqlite_master` rows of their own, so the table list leaves them out.

```js
test("a new file gets the schema, the current version and mode 0600", () => {
  const file = tempFile();
  const db = openMemoryDb(file);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["entities", "migrations", "observations", "relations", "sessions"]);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  db.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test("a new file has full-text tables for entity names and observation text", () => {
  const db = openMemoryDb(tempFile());
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE name IN ('entity_name_fts', 'observation_text_fts') ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(names, ["entity_name_fts", "observation_text_fts"]);
  db.close();
});
```

Append to `tests/sqlite-db.test.js`:

```js
// What the migration's version-1 file looks like: base tables, no full-text tables.
function versionOneFile() {
  const file = tempFile();
  const db = openMemoryDb(file);
  db.exec(`
    INSERT INTO entities (id, name, project, created_at) VALUES (1, 'feature:capture-visibility', 'p', 1);
    INSERT INTO observations (id, entity_id, text, created_at) VALUES ('o1', 1, 'the capture hook runs at session end', 1);
    DROP TABLE entity_name_fts;
    DROP TABLE observation_text_fts;
    PRAGMA user_version = 1;
  `);
  db.close();
  return file;
}

const matches = (db, table, word) =>
  db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(`"${word}"`).length;

test("a version-1 file is upgraded to version 2 with its full-text rows filled", () => {
  const db = openMemoryDb(versionOneFile());
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(matches(db, "entity_name_fts", "feature:capture"), 1);
  assert.equal(matches(db, "observation_text_fts", "hook"), 1);
  db.close();
});

test("a read-only open accepts a version-1 file and leaves it alone", () => {
  const file = versionOneFile();
  const db = openMemoryDb(file, { readOnly: true });
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(integrityReport(db).ok, true);
  db.close();
});

test("syncFullText indexes rows written without it and forgets deleted ones", () => {
  const db = openMemoryDb(tempFile());
  db.exec(`
    INSERT INTO entities (id, name, project, created_at) VALUES (1, 'decision:pnpm', 'p', 1);
    INSERT INTO observations (id, entity_id, text, created_at) VALUES ('o1', 1, 'prefers pnpm', 1);
  `);
  assert.deepEqual(syncFullText(db), { entities: 1, observations: 1 });
  assert.equal(matches(db, "observation_text_fts", "pnpm"), 1);
  db.exec("DELETE FROM observations WHERE id = 'o1'");
  syncFullText(db);
  assert.equal(matches(db, "observation_text_fts", "pnpm"), 0);
  db.close();
});
```

Append to `tests/migrate-write.test.js`:

```js
test("a written graph is searchable by word", () => {
  const db = freshDb();
  writeGraph(db, fixtureRecords());
  const hits = db
    .prepare("SELECT o.id FROM observation_text_fts JOIN observations o ON o.rowid = observation_text_fts.rowid WHERE observation_text_fts MATCH ?")
    .all('"pnpm"')
    .map((row) => row.id);
  assert.deepEqual(hits, ["obs-5"]);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-db.test.js tests/migrate-write.test.js`
Expected: FAIL.

- `sqlite-db.test.js` does not load: `syncFullText` is not exported (a SyntaxError).
- `migrate-write.test.js`'s new test fails: there is no `observation_text_fts`.

- [ ] **Step 3: Write the implementation**

In `src/lib/sqliteDb.js`:

1. Add `import { indexText } from "./segment.js";` below the `node:sqlite` import.
2. Replace `export const SCHEMA_VERSION = 1;` and the two comment lines above it with:

```js
// The SQLite memory store's schema. Version 1 is the migration's
// (2026-10-09-sqlite-migration-design.md); version 2 adds the full-text tables
// (2026-10-09-sqlite-engine-design.md). Writable opens upgrade 1 to 2;
// read-only opens accept either.
export const SCHEMA_VERSION = 2;
const READABLE_VERSIONS = [1, 2];
```

3. After the `SCHEMA_SQL` template literal, add:

```js
// Rows hold the text pre-segmented by segment.js and joined with spaces; the
// token characters are the in-word punctuation UAX #29 keeps, so each segmented
// word reaches the index as exactly one token.
const FULL_TEXT_SQL = `
CREATE VIRTUAL TABLE entity_name_fts USING fts5(words, tokenize = "unicode61 tokenchars ':._'',·'");
CREATE VIRTUAL TABLE observation_text_fts USING fts5(words, tokenize = "unicode61 tokenchars ':._'',·'");
`;
```

4. In `openMemoryDb`, replace the lines from `db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");` up to the `} catch (error) {` that closes the `try` with:

```js
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const version = userVersion(db);
    if (version === 0) {
      if (readOnly || !isEmpty(db)) {
        throw new Error(`${file} is not a memory database; refusing to use it`);
      }
      db.exec("PRAGMA journal_mode = WAL;");
      createSchema(db);
    } else if (!READABLE_VERSIONS.includes(version)) {
      throw new Error(`${file} has schema version ${version}; this code expects ${SCHEMA_VERSION}`);
    } else if (!readOnly) {
      db.exec("PRAGMA journal_mode = WAL;");
      if (version < SCHEMA_VERSION) {
        upgradeSchema(db);
      }
    }
```

5. Replace `createSchema` (with its comment) by these three functions:

```js
// BEGIN IMMEDIATE takes the write lock before the version is read again, so
// two processes opening the same new file cannot both create the schema.
function createSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (userVersion(db) === 0) {
      db.exec(`${SCHEMA_SQL} ${FULL_TEXT_SQL} PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Version 1 (what the migration wrote) to 2: add the full-text tables and fill them.
function upgradeSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (userVersion(db) === 1) {
      db.exec(FULL_TEXT_SQL);
      syncFullText(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Makes the full-text rows match the base tables: indexes entities and
 * observations that have no full-text row, and drops full-text rows whose base
 * row is gone. The engine maintains them per write; this covers bulk writers
 * (the migration) and the version upgrade. Call inside a transaction.
 */
export function syncFullText(db) {
  const entities = db.prepare("SELECT id, name FROM entities WHERE id NOT IN (SELECT rowid FROM entity_name_fts)").all();
  const addEntity = db.prepare("INSERT INTO entity_name_fts (rowid, words) VALUES (?, ?)");
  for (const row of entities) {
    addEntity.run(row.id, indexText(row.name));
  }
  const observations = db
    .prepare("SELECT rowid AS rid, text FROM observations WHERE rowid NOT IN (SELECT rowid FROM observation_text_fts)")
    .all();
  const addObservation = db.prepare("INSERT INTO observation_text_fts (rowid, words) VALUES (?, ?)");
  for (const row of observations) {
    addObservation.run(row.rid, indexText(row.text));
  }
  db.exec("DELETE FROM entity_name_fts WHERE rowid NOT IN (SELECT id FROM entities)");
  db.exec("DELETE FROM observation_text_fts WHERE rowid NOT IN (SELECT rowid FROM observations)");
  return { entities: entities.length, observations: observations.length };
}
```

6. In `integrityReport`, change `userVersion === SCHEMA_VERSION` to `READABLE_VERSIONS.includes(userVersion)`.

In `src/lib/migrate/writeSqlite.js`:

- Add `import { syncFullText } from "../sqliteDb.js";` below the existing import.
- In `writeGraph`, insert `syncFullText(db);` on the line before `db.exec("COMMIT");`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-db.test.js tests/migrate-*.test.js 2>&1 | grep -E '^# (tests|pass|fail|skipped) |^not ok'`
Expected: `# fail 0` and `# skipped 5` (the gated rehearsal tests). sqlite-db now has 14 tests and migrate-write 11.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sqliteDb.js src/lib/migrate/writeSqlite.js tests/sqlite-db.test.js tests/migrate-write.test.js
git commit -m "feat(memory): Add full-text tables as schema version 2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Opening the store

**Files:**
- Modify: `src/lib/config.js` (add `memoryDbPath`)
- Modify: `src/lib/sqliteDb.js` (safe concurrent first opens)
- Create: `src/lib/memoryStore.js`
- Test: `tests/memory-store.test.js`

**Interfaces:**
- Consumes: `openMemoryDb`, `SCHEMA_VERSION` (Task 3).
- Produces:
  - `memoryDbPath(): string` (from `config.js`)
  - `getDb(): DatabaseSync`, `closeDb(): void`
  - `storeStatus(): { ready: true, path } | { ready: false, path, reason }`
  - `inTransaction(db, work): result`

- [ ] **Step 1: Write the failing tests**

`tests/memory-store.test.js`:

```js
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getDb, closeDb, storeStatus, inTransaction } from "../src/lib/memoryStore.js";
import { memoryDbPath } from "../src/lib/config.js";
import { SCHEMA_VERSION } from "../src/lib/sqliteDb.js";

const STORE = fileURLToPath(new URL("../src/lib/memoryStore.js", import.meta.url));
const tempPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-")), "memory.sqlite");

afterEach(() => {
  closeDb();
  delete process.env.CLAUDE_NEO4J_SQLITE;
});

test("CLAUDE_NEO4J_SQLITE names the store", () => {
  const file = tempPath();
  process.env.CLAUDE_NEO4J_SQLITE = file;
  assert.equal(memoryDbPath(), file);
});

test("getDb opens the store once and reuses the connection", () => {
  process.env.CLAUDE_NEO4J_SQLITE = tempPath();
  const first = getDb();
  assert.equal(getDb(), first);
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
});

test("a different path opens a different store and closes the old one", () => {
  process.env.CLAUDE_NEO4J_SQLITE = tempPath();
  const first = getDb();
  process.env.CLAUDE_NEO4J_SQLITE = tempPath();
  assert.notEqual(getDb(), first);
  assert.throws(() => first.prepare("SELECT 1"), /not open/i);
});

test("storeStatus says why a store cannot be opened instead of throwing", () => {
  process.env.CLAUDE_NEO4J_SQLITE = "/dev/null/memory.sqlite";
  const status = storeStatus();
  assert.equal(status.ready, false);
  assert.equal(status.path, "/dev/null/memory.sqlite");
  assert.match(status.reason, /EEXIST|ENOTDIR|not a directory/i);
});

test("storeStatus reports a usable store as ready", () => {
  process.env.CLAUDE_NEO4J_SQLITE = tempPath();
  assert.deepEqual(storeStatus(), { ready: true, path: process.env.CLAUDE_NEO4J_SQLITE });
});

test("inTransaction commits on success and rolls back on error", () => {
  process.env.CLAUDE_NEO4J_SQLITE = tempPath();
  const db = getDb();
  inTransaction(db, () => db.exec("INSERT INTO sessions (id, started_at) VALUES ('kept', 1)"));
  assert.throws(
    () =>
      inTransaction(db, () => {
        db.exec("INSERT INTO sessions (id, started_at) VALUES ('dropped', 1)");
        throw new Error("boom");
      }),
    /boom/
  );
  assert.deepEqual(db.prepare("SELECT id FROM sessions").all().map((row) => row.id), ["kept"]);
});

// Opens the store at `file` from a separate process at time `at` (epoch ms).
function openAt(file, at) {
  return new Promise((resolve) => {
    const script = `import { getDb } from ${JSON.stringify(STORE)}; while (Date.now() < ${at}) {} getDb();`;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
      env: { ...process.env, CLAUDE_NEO4J_SQLITE: file },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

// On a first session the session-start hook and the memory server start
// together. Each round's processes spin until the same instant before opening,
// because otherwise start-up jitter hides the collision; even then a round
// collides only some of the time, hence eight rounds.
test("processes opening a brand-new store at the same moment all succeed", async () => {
  for (let round = 0; round < 8; round++) {
    const file = tempPath();
    const at = Date.now() + 250;
    const results = await Promise.all(Array.from({ length: 6 }, () => openAt(file, at)));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }
    process.env.CLAUDE_NEO4J_SQLITE = file;
    assert.equal(getDb().prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/memory-store.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/memoryStore.js`.

- [ ] **Step 3: Write the store**

In `src/lib/config.js`, add after `ensureStateDir`:

```js
/**
 * Where the SQLite memory store lives: CLAUDE_NEO4J_SQLITE, then config.json's
 * sqlitePath, then ~/.claude-neo4j/memory.sqlite.
 */
export function memoryDbPath() {
  return process.env.CLAUDE_NEO4J_SQLITE ?? readConfigFile()?.sqlitePath ?? path.join(CONFIG_DIR, "memory.sqlite");
}
```

`src/lib/memoryStore.js`:

```js
import { openMemoryDb } from "./sqliteDb.js";
import { memoryDbPath } from "./config.js";

// One connection per process, opened on first use. Hooks and the memory server
// are separate processes, so concurrent writers meet in SQLite's WAL and busy
// timeout, not here. A changed path (tests) opens the new store.
let open = null;

export function getDb() {
  const file = memoryDbPath();
  if (open?.file !== file) {
    closeDb();
    open = { file, db: openMemoryDb(file) };
  }
  return open.db;
}

export function closeDb() {
  if (open) {
    open.db.close();
    open = null;
  }
}

/** Whether memory can be used right now and, if not, why. Never throws. */
export function storeStatus() {
  try {
    getDb();
    return { ready: true, path: open.file };
  } catch (error) {
    return { ready: false, path: memoryDbPath(), reason: error.message };
  }
}

/** Runs `work` in one write transaction (BEGIN IMMEDIATE), rolling back on any error. */
export function inTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
```

- [ ] **Step 4: Run the tests to see the race**

Run: `HOME="$(mktemp -d)" node --test tests/memory-store.test.js 2>&1 | grep -E '^# (pass|fail)|^not ok|EEXIST|database is locked|not a memory database' | head`
Expected: 6 pass, 1 fail: "processes opening a brand-new store at the same moment all succeed". It fails with one of:

- `EEXIST`: two processes both create the file.
- `database is locked`: SQLite's switch to WAL takes its lock without the busy timeout.
- `is not a memory database`: one process reads version 0, another commits the schema, and the first then sees tables.

Each of the three, alone, failed this test in 4 of 4 runs while the plan was verified.

- [ ] **Step 5: Make concurrent first opens safe**

In `src/lib/sqliteDb.js`:

1. Below `const READABLE_VERSIONS = [1, 2];`, add:

```js
const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;
```

2. Replace the whole `openMemoryDb` function (keep its doc comment) with:

```js
export function openMemoryDb(file, { readOnly = false } = {}) {
  if (!readOnly && !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      fs.closeSync(fs.openSync(file, "wx", 0o600));
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    const version = userVersion(db);
    if (version === 0) {
      // Tables but no version is someone else's database. Read the version again
      // before deciding: a store another process finished creating after the
      // first read has its version by now.
      if (readOnly || (!isEmpty(db) && userVersion(db) === 0)) {
        throw new Error(`${file} is not a memory database; refusing to use it`);
      }
      useWal(db);
      createSchema(db);
    } else if (!READABLE_VERSIONS.includes(version)) {
      throw new Error(`${file} has schema version ${version}; this code expects ${SCHEMA_VERSION}`);
    } else if (!readOnly) {
      useWal(db);
      if (version < SCHEMA_VERSION) {
        upgradeSchema(db);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
  if (!readOnly) {
    fs.chmodSync(file, 0o600);
  }
  return db;
}
```

3. Add above `function userVersion(db)`:

```js
// Switching to WAL takes an exclusive lock without waiting on busy_timeout, so
// two processes opening a brand-new store at once (the session-start hook and
// the memory server, on a first session) collide here. Retry for as long as
// the busy timeout would have waited.
function useWal(db) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; ; waited += 20) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (error) {
      if ((error.errcode & 0xff) !== SQLITE_BUSY || waited >= BUSY_TIMEOUT_MS) {
        throw error;
      }
      Atomics.wait(pause, 0, 0, 20);
    }
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `HOME="$(mktemp -d)" node --test tests/memory-store.test.js tests/sqlite-db.test.js tests/migrate-*.test.js 2>&1 | grep -E '^# (tests|pass|fail|skipped) |^not ok'`
Expected: `# fail 0` and `# skipped 5`. memory-store has 7 tests; its race test takes about 2 seconds.

- [ ] **Step 7: Commit**

```bash
git add src/lib/config.js src/lib/sqliteDb.js src/lib/memoryStore.js tests/memory-store.test.js
git commit -m "feat(memory): Open the SQLite memory store safely from several processes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Engine writes and counts

**Files:**
- Create: `src/lib/sqliteGraph.js`
- Create: `tests/helpers/tempStore.js`
- Test: `tests/sqlite-graph-write.test.js`

**Interfaces:**
- Consumes:
  - `getDb`, `inTransaction` (Task 4)
  - `indexText` (Task 2)
  - `wordOverlap` (Task 1)
  - existing `resolveCanonicalName` (`dedup.js`), `resolveSubsystem`, `parseSubsystemFilter`, `UNTAGGED` (`subsystem.js`), `BUDGETS`, `truncateText`, `fitToBudget` (`budget.js`)
- Produces, with the same signatures as today's `graph.js`:
  - `listEntityNames(project): Promise<string[]>`
  - `listSubsystems(project): Promise<{ subsystem, observations }[]>`
  - `getSubsystemMap(project): Promise<{ subsystem, observations, entities, lastSeen }[]>`
  - `upsertSession({ id, cwd, project })`
  - `addObservations({ entity, entityType, observations, sessionId, project, existingNames, existingSubsystems }): Promise<string[]>`
  - `createRelation({ from, to, type, project })`
  - `getStatus({ project }): Promise<{ entityCount, observationCount }>`
  - `listProjects(): Promise<{ project, entityCount, observationCount, lastActivity }[]>`
  - Test helper: `useTempStore(): string`

- [ ] **Step 1: Write the test helper and the failing tests**

`tests/helpers/tempStore.js`:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb } from "../../src/lib/memoryStore.js";

/** Points this test process's memory store at a fresh, empty file. */
export function useTempStore() {
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-")), "memory.sqlite");
  process.env.CLAUDE_NEO4J_SQLITE = file;
  return file;
}
```

`tests/sqlite-graph-write.test.js`:

```js
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { useTempStore } from "./helpers/tempStore.js";
import { closeDb, getDb } from "../src/lib/memoryStore.js";
import * as graph from "../src/lib/sqliteGraph.js";

const P = "github.com/acme/app";
const ENGINE = fileURLToPath(new URL("../src/lib/sqliteGraph.js", import.meta.url));
const rows = (sql, ...params) => getDb().prepare(sql).all(...params);

beforeEach(() => {
  useTempStore();
});

after(() => {
  closeDb();
});

test("an observation batch shares one timestamp and keeps its order", async () => {
  await graph.addObservations({ entity: "decision:storage", entityType: "decision", project: P, observations: ["first", "second", "third"] });
  const stored = rows("SELECT text, created_at FROM observations ORDER BY rowid");
  assert.deepEqual(stored.map((row) => row.text), ["first", "second", "third"]);
  assert.equal(new Set(stored.map((row) => row.created_at)).size, 1);
});

test("addObservations returns the new ids and accepts plain strings and tagged objects", async () => {
  const ids = await graph.addObservations({ entity: "fact:x", project: P, observations: ["plain", { text: "tagged", subsystem: "capture" }] });
  assert.equal(ids.length, 2);
  const stored = rows("SELECT id, text, subsystem FROM observations ORDER BY rowid");
  assert.deepEqual(stored.map((row) => [row.id, row.text, row.subsystem]), [
    [ids[0], "plain", null],
    [ids[1], "tagged", "capture"],
  ]);
});

test("a global entity is visible from every project, a project entity only from its own", async () => {
  await graph.addObservations({ entity: "user", entityType: "person", project: null, observations: ["global fact"] });
  await graph.addObservations({ entity: "decision:mine", project: P, observations: ["mine"] });
  assert.deepEqual((await graph.listEntityNames(P)).sort(), ["decision:mine", "user"]);
  assert.deepEqual(await graph.listEntityNames("github.com/acme/other"), ["user"]);
  assert.deepEqual(rows("SELECT project FROM entities WHERE name = 'user'").map((row) => row.project), [""]);
});

test("an existing entity keeps its type unless a new one is given, and is marked updated", async () => {
  await graph.addObservations({ entity: "decision:typed", entityType: "decision", project: P, observations: ["one"] });
  const [created] = rows("SELECT type, updated_at FROM entities");
  assert.equal(created.type, "decision");
  assert.equal(created.updated_at, null);
  await graph.addObservations({ entity: "decision:typed", project: P, observations: ["two"] });
  const [kept] = rows("SELECT type, updated_at FROM entities");
  assert.equal(kept.type, "decision");
  assert.equal(typeof kept.updated_at, "number");
  await graph.addObservations({ entity: "decision:typed", entityType: "preference", project: P, observations: ["three"] });
  assert.equal(rows("SELECT type FROM entities")[0].type, "preference");
});

test("a near-identical name snaps onto the existing entity", async () => {
  await graph.addObservations({ entity: "decision:storage-layout", project: P, observations: ["one"] });
  await graph.addObservations({ entity: "decision:storage-layouts", project: P, observations: ["two"] });
  assert.deepEqual(rows("SELECT name FROM entities").map((row) => row.name), ["decision:storage-layout"]);
});

test("names and observations are searchable by word as soon as they are written", async () => {
  await graph.addObservations({ entity: "feature:capture-visibility", project: P, observations: ["prefers pnpm"] });
  assert.equal(rows("SELECT rowid FROM entity_name_fts WHERE entity_name_fts MATCH ?", '"feature:capture"').length, 1);
  assert.equal(rows("SELECT rowid FROM observation_text_fts WHERE observation_text_fts MATCH ?", '"pnpm"').length, 1);
});

test("text with emoji or a broken character is stored and found by its words", async () => {
  await graph.addObservations({ entity: "fact:odd", project: P, observations: ["deploy 🚀 done \uD83D"] });
  assert.equal(rows("SELECT text FROM observations")[0].text, "deploy 🚀 done �");
  assert.equal(rows("SELECT rowid FROM observation_text_fts WHERE observation_text_fts MATCH ?", '"deploy"').length, 1);
});

test("createRelation creates missing ends and never duplicates an edge", async () => {
  await graph.createRelation({ from: "decision:a", to: "ticket:B-1", type: "implements", project: P });
  await graph.createRelation({ from: "decision:a", to: "ticket:B-1", type: "implements", project: P });
  assert.deepEqual(rows("SELECT name FROM entities ORDER BY name").map((row) => row.name), ["decision:a", "ticket:B-1"]);
  assert.equal(rows("SELECT * FROM relations").length, 1);
});

test("upsertSession records a session once", async () => {
  await graph.upsertSession({ id: "s1", cwd: "/repo", project: P });
  const [first] = rows("SELECT started_at FROM sessions");
  await graph.upsertSession({ id: "s1", cwd: "/elsewhere", project: P });
  const stored = rows("SELECT cwd, started_at FROM sessions");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].cwd, "/repo");
  assert.equal(stored[0].started_at, first.started_at);
});

test("listSubsystems and getSubsystemMap count tags, with an untagged bucket and ISO dates", async () => {
  await graph.addObservations({
    entity: "fact:t",
    project: P,
    observations: [{ text: "a", subsystem: "capture" }, { text: "b", subsystem: "capture" }, "c"],
  });
  assert.deepEqual(await graph.listSubsystems(P), [{ subsystem: "capture", observations: 2 }]);
  const byName = Object.fromEntries((await graph.getSubsystemMap(P)).map((row) => [row.subsystem, row]));
  assert.equal(byName.capture.observations, 2);
  assert.equal(byName.capture.entities, 1);
  assert.equal(byName["(untagged)"].observations, 1);
  assert.match(byName.capture.lastSeen, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("getStatus counts within scope and listProjects skips the global scope", async () => {
  await graph.addObservations({ entity: "user", project: null, observations: ["g"] });
  await graph.addObservations({ entity: "decision:mine", project: P, observations: ["x", "y"] });
  assert.deepEqual(await graph.getStatus({ project: P }), { entityCount: 2, observationCount: 3 });
  const projects = await graph.listProjects();
  assert.deepEqual(projects.map((p) => [p.project, p.entityCount, p.observationCount]), [[P, 1, 2]]);
  assert.match(projects[0].lastActivity, /Z$/);
});

// A capture hook and the memory server are separate processes writing the same
// file. Both start writing at the same instant, or the child's start-up time
// lets the parent finish before the child begins and nothing overlaps.
test("two processes writing at the same moment both land", async () => {
  const file = process.env.CLAUDE_NEO4J_SQLITE;
  getDb();
  const at = Date.now() + 400;
  const script = `import * as g from ${JSON.stringify(ENGINE)};
    while (Date.now() < ${at}) {}
    for (let i = 0; i < 300; i++) {
      await g.addObservations({ entity: "fact:child", project: "p", observations: ["child " + i] });
    }`;
  const writer = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    env: { ...process.env, CLAUDE_NEO4J_SQLITE: file },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  writer.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => writer.on("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, at - Date.now()));
  for (let i = 0; i < 300; i++) {
    await graph.addObservations({ entity: "fact:parent", project: "p", observations: [`parent ${i}`] });
  }
  assert.equal(await exited, 0, stderr);
  assert.equal(rows("SELECT count(*) AS n FROM observations")[0].n, 600);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-graph-write.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/sqliteGraph.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/sqliteGraph.js`:

```js
import { randomUUID } from "node:crypto";
import { getDb, inTransaction } from "./memoryStore.js";
import { indexText } from "./segment.js";
import { resolveCanonicalName } from "./dedup.js";
import { resolveSubsystem, parseSubsystemFilter, UNTAGGED } from "./subsystem.js";
import { BUDGETS, truncateText, fitToBudget } from "./budget.js";
import { wordOverlap } from "./similarity.js";

// The SQLite engine: the same exported functions as the Neo4j engine it
// replaces, over the schema in sqliteDb.js.
// Spec: docs/superpowers/specs/2026-10-09-sqlite-engine-design.md.

// A read for a project sees that project's entities and the global ones
// (stored as project ''); a read with no project sees everything. Binds :project.
const IN_SCOPE = "(:project IS NULL OR e.project = :project OR e.project = '')";

// The subsystem filter's three states (see parseSubsystemFilter): both
// conjuncts are always present and one is always trivially true. Binds
// :subsystem and :untaggedOnly (1 or 0: SQLite has no booleans).
const SUBSYSTEM_FILTER = "(:subsystem IS NULL OR o.subsystem = :subsystem) AND (:untaggedOnly = 0 OR o.subsystem IS NULL)";

const filterParams = (subsystem) => {
  const filter = parseSubsystemFilter(subsystem);
  return { subsystem: filter.subsystem, untaggedOnly: filter.untaggedOnly ? 1 : 0 };
};

// Callers name a global entity with a null project; storage uses ''...
const storedProject = (project) => project ?? "";
// ...and reads hand null back for it, as the Neo4j engine did.
const shownProject = (project) => (project === "" ? null : project);
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export async function listEntityNames(project) {
  return getDb()
    .prepare(`SELECT e.name AS name FROM entities e WHERE ${IN_SCOPE}`)
    .all({ project: project ?? null })
    .map((row) => row.name);
}

/**
 * The project's existing subsystem vocabulary, most-used first. Fed to the
 * extraction prompt and to the write path so new tags converge on the ones
 * already in use instead of fragmenting.
 */
export async function listSubsystems(project) {
  return getDb()
    .prepare(
      `SELECT o.subsystem AS subsystem, count(*) AS observations
       FROM observations o JOIN entities e ON e.id = o.entity_id
       WHERE ${IN_SCOPE} AND o.subsystem IS NOT NULL
       GROUP BY o.subsystem
       ORDER BY observations DESC, subsystem ASC`
    )
    .all({ project: project ?? null })
    .map((row) => ({ subsystem: row.subsystem, observations: row.observations }));
}

/**
 * A table of contents for the project's memory: one row per subsystem tag with
 * counts and recency, untagged observations in their own row. Bounded by tag
 * cardinality, so the SessionStart injection does not grow with the store.
 */
export async function getSubsystemMap(project) {
  return getDb()
    .prepare(
      `SELECT coalesce(o.subsystem, :untagged) AS subsystem, count(*) AS observations,
              count(DISTINCT o.entity_id) AS entities, max(o.created_at) AS lastSeen
       FROM observations o JOIN entities e ON e.id = o.entity_id
       WHERE ${IN_SCOPE}
       GROUP BY coalesce(o.subsystem, :untagged)
       ORDER BY lastSeen DESC`
    )
    .all({ project: project ?? null, untagged: UNTAGGED })
    .map((row) => ({ subsystem: row.subsystem, observations: row.observations, entities: row.entities, lastSeen: iso(row.lastSeen) }));
}

export async function upsertSession({ id, cwd, project }) {
  getDb()
    .prepare("INSERT INTO sessions (id, cwd, project, started_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
    .run(id, cwd ?? null, project ?? null, Date.now());
}

// Creates the entity, or bumps an existing one; returns its id. An existing
// entity keeps its type unless a new one is given.
function upsertEntity(db, name, type, project, now) {
  const scope = storedProject(project);
  const existing = db.prepare("SELECT id FROM entities WHERE name = ? AND project = ?").get(name, scope);
  if (existing) {
    db.prepare("UPDATE entities SET type = coalesce(?, type), updated_at = ? WHERE id = ?").run(type ?? null, now, existing.id);
    return existing.id;
  }
  const { lastInsertRowid } = db
    .prepare("INSERT INTO entities (name, project, type, created_at) VALUES (?, ?, ?, ?)")
    .run(name, scope, type ?? null, now);
  db.prepare("INSERT INTO entity_name_fts (rowid, words) VALUES (?, ?)").run(lastInsertRowid, indexText(name));
  return Number(lastInsertRowid);
}

// `existingNames`/`existingSubsystems` let a caller writing several entities in
// a row fetch these lists once instead of per call. One call's whole batch
// shares one created_at; rowid keeps the batch's order.
export async function addObservations({ entity, entityType, observations, sessionId, project, existingNames, existingSubsystems }) {
  const names = existingNames ?? (await listEntityNames(project));
  const knownSubsystems = existingSubsystems ?? (await listSubsystems(project)).map((s) => s.subsystem);
  // A plain string or {text, subsystem}; bounded on the way in, so one runaway
  // observation can't inflate every future read of this entity.
  const rows = observations.map((item) => {
    const { text, subsystem } = typeof item === "string" ? { text: item, subsystem: null } : item;
    return { id: randomUUID(), text: truncateText(text, BUDGETS.writeTextChars), subsystem: resolveSubsystem(subsystem, knownSubsystems) };
  });
  const name = resolveCanonicalName(entity, names);
  const db = getDb();
  const now = Date.now();
  inTransaction(db, () => {
    const entityId = upsertEntity(db, name, entityType, project, now);
    const insert = db.prepare("INSERT INTO observations (id, entity_id, text, subsystem, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const index = db.prepare("INSERT INTO observation_text_fts (rowid, words) VALUES (?, ?)");
    for (const row of rows) {
      const { lastInsertRowid } = insert.run(row.id, entityId, row.text, row.subsystem, sessionId ?? null, now);
      index.run(lastInsertRowid, indexText(row.text));
    }
  });
  return rows.map((row) => row.id);
}

export async function createRelation({ from, to, type, project }) {
  const names = await listEntityNames(project);
  const fromName = resolveCanonicalName(from, names);
  const toName = resolveCanonicalName(to, names);
  const db = getDb();
  const now = Date.now();
  inTransaction(db, () => {
    const fromId = upsertEntity(db, fromName, null, project, now);
    const toId = upsertEntity(db, toName, null, project, now);
    db.prepare(
      "INSERT INTO relations (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (from_id, to_id, type) DO NOTHING"
    ).run(fromId, toId, type, now);
  });
}

export async function getStatus({ project }) {
  const db = getDb();
  const params = { project: project ?? null };
  const { entityCount } = db.prepare(`SELECT count(*) AS entityCount FROM entities e WHERE ${IN_SCOPE}`).get(params);
  const { observationCount } = db
    .prepare(`SELECT count(*) AS observationCount FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${IN_SCOPE}`)
    .get(params);
  return { entityCount, observationCount };
}

export async function listProjects() {
  return getDb()
    .prepare(
      `SELECT e.project AS project, count(DISTINCT e.id) AS entityCount, count(o.rowid) AS observationCount,
              max(o.created_at) AS lastActivity
       FROM entities e LEFT JOIN observations o ON o.entity_id = e.id
       WHERE e.project != ''
       GROUP BY e.project
       ORDER BY lastActivity DESC`
    )
    .all()
    .map((row) => ({
      project: row.project,
      entityCount: row.entityCount,
      observationCount: row.observationCount,
      lastActivity: iso(row.lastActivity),
    }));
}
```

`SUBSYSTEM_FILTER`, `filterParams`, `shownProject`, `fitToBudget` and `wordOverlap` are used from Task 6 on. They are declared here so later tasks only add functions.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-graph-write.test.js`
Expected: PASS, 12 tests. With the busy timeout set to 0, the last test fails with `database is locked`; that is how it was checked.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sqliteGraph.js tests/helpers/tempStore.js tests/sqlite-graph-write.test.js
git commit -m "feat(memory): Write memories and count them in SQLite" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Engine reads, deletes and prune

**Files:**
- Modify: `src/lib/sqliteGraph.js` (append)
- Test: `tests/sqlite-graph-read.test.js`

**Interfaces:**
- Consumes: Task 5's helpers in `sqliteGraph.js` (`IN_SCOPE`, `SUBSYSTEM_FILTER`, `filterParams`, `shownProject`, `iso`).
- Produces, with today's signatures:
  - `getEntity(name, project = null, { limit = 50 }): Promise<{ name, type, project, observations[{ id, text, subsystem, createdAt }], observationCount, outgoing[{ type, entity }], incoming[{ type, entity }] } | null>`
  - `getRecentContext({ project, limit = 15, subsystem = null }): Promise<{ name, type, observations[{ text, subsystem }] }[]>`
  - `getTimeline({ project, since, limit = 100, subsystem = null, maxTextChars, maxTotalChars }): Promise<{ events, total, returned, truncated }>`
  - `deleteObservations(entity, observationIds, project = null): Promise<number>`
  - `deleteEntity(entity, project = null)`
  - `pruneObservations({ project, olderThanDays = 180, keepPerEntity = 3, dryRun = false }): Promise<{ pruned, sample }>`

- [ ] **Step 1: Write the failing tests**

`tests/sqlite-graph-read.test.js`:

```js
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { closeDb, getDb } from "../src/lib/memoryStore.js";
import * as graph from "../src/lib/sqliteGraph.js";

const P = "github.com/acme/app";
const DAY = 86_400_000;
const rows = (sql, ...params) => getDb().prepare(sql).all(...params);
const setTime = (text, ms) => getDb().prepare("UPDATE observations SET created_at = ? WHERE text = ?").run(ms, text);

beforeEach(() => {
  useTempStore();
});

after(() => {
  closeDb();
});

test("getEntity lists newest first, breaking same-millisecond ties by insertion", async () => {
  await graph.addObservations({ entity: "decision:x", project: P, observations: ["first", "second", "third"] });
  const entity = await graph.getEntity("decision:x", P);
  assert.deepEqual(entity.observations.map((o) => o.text), ["third", "second", "first"]);
  assert.equal(entity.observationCount, 3);
  assert.match(entity.observations[0].createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("getEntity windows by limit but reports the true count", async () => {
  await graph.addObservations({ entity: "decision:x", project: P, observations: ["a", "b", "c"] });
  const windowed = await graph.getEntity("decision:x", P, { limit: 2 });
  assert.equal(windowed.observations.length, 2);
  assert.equal(windowed.observationCount, 3);
  assert.equal((await graph.getEntity("decision:x", P, { limit: null })).observations.length, 3);
});

test("getEntity separates outgoing from incoming relations", async () => {
  await graph.createRelation({ from: "alpha", to: "bravo", type: "uses", project: P });
  await graph.createRelation({ from: "charlie", to: "alpha", type: "blocks", project: P });
  const alpha = await graph.getEntity("alpha", P);
  assert.deepEqual(alpha.outgoing, [{ type: "uses", entity: "bravo" }]);
  assert.deepEqual(alpha.incoming, [{ type: "blocks", entity: "charlie" }]);
});

test("getEntity prefers this project's entity over a global one, and returns null for an unknown name", async () => {
  await graph.addObservations({ entity: "user", project: null, observations: ["global"] });
  await graph.addObservations({ entity: "user", project: P, observations: ["local"] });
  assert.equal((await graph.getEntity("user", P)).observations[0].text, "local");
  assert.equal((await graph.getEntity("user", "github.com/acme/other")).project, null);
  assert.equal(await graph.getEntity("nobody", P), null);
});

test("getRecentContext orders entities by their newest observation and keeps three each", async () => {
  await graph.addObservations({ entity: "decision:old", project: P, observations: ["o1", "o2", "o3", "o4"] });
  await graph.addObservations({ entity: "decision:new", project: P, observations: ["n1"] });
  setTime("n1", Date.now() + 1000);
  const recent = await graph.getRecentContext({ project: P });
  assert.deepEqual(recent.map((r) => r.name), ["decision:new", "decision:old"]);
  assert.deepEqual(recent[1].observations.map((o) => o.text), ["o4", "o3", "o2"]);
});

test("getTimeline runs oldest first, honours since, and reports truncation", async () => {
  await graph.addObservations({ entity: "decision:t", project: P, observations: ["early", "middle", "late"] });
  const now = Date.now();
  setTime("early", now - 3 * DAY);
  setTime("middle", now - 2 * DAY);
  setTime("late", now - DAY);
  const all = await graph.getTimeline({ project: P });
  assert.deepEqual(all.events.map((e) => e.text), ["early", "middle", "late"]);
  const since = await graph.getTimeline({ project: P, since: new Date(now - 2 * DAY - 1000).toISOString() });
  assert.deepEqual(since.events.map((e) => e.text), ["middle", "late"]);
  const clipped = await graph.getTimeline({ project: P, limit: 1 });
  assert.deepEqual([clipped.total, clipped.returned, clipped.truncated], [3, 1, true]);
});

test("getTimeline rejects a since that is not a date", async () => {
  await assert.rejects(() => graph.getTimeline({ project: P, since: "around lunchtime" }), /not a date/);
});

test("deleteObservations removes only the named entity's observations, and their search rows", async () => {
  const [keep, drop] = await graph.addObservations({ entity: "decision:d", project: P, observations: ["keep pnpm", "drop yarn"] });
  const [foreign] = await graph.addObservations({ entity: "decision:other", project: P, observations: ["other yarn"] });
  assert.equal(await graph.deleteObservations("decision:d", [drop, foreign], P), 1);
  assert.deepEqual(rows("SELECT id FROM observations ORDER BY rowid").map((r) => r.id), [keep, foreign]);
  assert.equal(rows("SELECT rowid FROM observation_text_fts WHERE observation_text_fts MATCH ?", '"yarn"').length, 1);
});

test("deleteEntity removes its observations, relations and search rows", async () => {
  await graph.addObservations({ entity: "decision:gone", project: P, observations: ["vanishing pnpm"] });
  await graph.createRelation({ from: "decision:gone", to: "decision:stays", type: "uses", project: P });
  await graph.deleteEntity("decision:gone", P);
  assert.deepEqual(rows("SELECT name FROM entities").map((r) => r.name), ["decision:stays"]);
  assert.equal(rows("SELECT count(*) AS n FROM observations")[0].n, 0);
  assert.equal(rows("SELECT count(*) AS n FROM relations")[0].n, 0);
  assert.equal(rows("SELECT rowid FROM entity_name_fts WHERE entity_name_fts MATCH ?", '"decision:gone"').length, 0);
  assert.equal(rows("SELECT rowid FROM observation_text_fts WHERE observation_text_fts MATCH ?", '"vanishing"').length, 0);
});

test("pruneObservations keeps each entity's newest old observations, and a dry run deletes nothing", async () => {
  await graph.addObservations({ entity: "decision:p", project: P, observations: ["p1", "p2", "p3", "p4", "p5", "fresh"] });
  const old = Date.now() - 200 * DAY;
  ["p1", "p2", "p3", "p4", "p5"].forEach((text, i) => setTime(text, old + i));
  const dry = await graph.pruneObservations({ project: P, dryRun: true });
  assert.equal(dry.pruned, 2);
  assert.deepEqual(dry.sample.map((s) => s.text).sort(), ["p1", "p2"]);
  assert.equal(rows("SELECT count(*) AS n FROM observations")[0].n, 6);
  const real = await graph.pruneObservations({ project: P });
  assert.equal(real.pruned, 2);
  assert.deepEqual(rows("SELECT text FROM observations ORDER BY text").map((r) => r.text), ["fresh", "p3", "p4", "p5"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-graph-read.test.js`
Expected: FAIL, 10 tests. `graph.getEntity is not a function`, and likewise for the others.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/sqliteGraph.js`:

```js
// Prefers the entity in this project, then a global one of the same name, so
// get and delete always agree on which same-named entity they mean.
function resolveEntity(db, name, project) {
  return db
    .prepare(
      `SELECT e.id AS id, e.name AS name, e.type AS type, e.project AS project
       FROM entities e WHERE e.name = :name AND ${IN_SCOPE}
       ORDER BY CASE WHEN e.project = :project THEN 0 ELSE 1 END, e.id
       LIMIT 1`
    )
    .get({ name, project: project ?? null });
}

const asRelation = (row) => ({ type: row.type, entity: row.entity });

// Observations are capped because an entity's history is unbounded; the full
// count is always reported, and `limit: null` still returns everything.
export async function getEntity(name, project = null, { limit = 50 } = {}) {
  const db = getDb();
  const entity = resolveEntity(db, name, project);
  if (!entity) {
    return null;
  }
  const all = db
    .prepare("SELECT id, text, subsystem, created_at FROM observations WHERE entity_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(entity.id);
  const shown = (limit === null ? all : all.slice(0, limit)).map((o) => ({
    id: o.id,
    text: truncateText(o.text, BUDGETS.entityTextChars),
    subsystem: o.subsystem,
    createdAt: iso(o.created_at),
  }));
  const outgoing = db
    .prepare("SELECT r.type AS type, b.name AS entity FROM relations r JOIN entities b ON b.id = r.to_id WHERE r.from_id = ? ORDER BY r.type, b.name")
    .all(entity.id)
    .map(asRelation);
  const incoming = db
    .prepare("SELECT r.type AS type, a.name AS entity FROM relations r JOIN entities a ON a.id = r.from_id WHERE r.to_id = ? ORDER BY r.type, a.name")
    .all(entity.id)
    .map(asRelation);
  return {
    name: entity.name,
    type: entity.type,
    project: shownProject(entity.project),
    observations: fitToBudget(shown, BUDGETS.entityTotalChars).kept,
    observationCount: all.length,
    outgoing,
    incoming,
  };
}

export async function getRecentContext({ project, limit = 15, subsystem = null }) {
  const db = getDb();
  const filter = filterParams(subsystem);
  const entities = db
    .prepare(
      `SELECT e.id AS id, e.name AS name, e.type AS type, max(o.created_at) AS lastSeen
       FROM observations o JOIN entities e ON e.id = o.entity_id
       WHERE ${IN_SCOPE} AND ${SUBSYSTEM_FILTER}
       GROUP BY e.id
       ORDER BY lastSeen DESC, e.id DESC
       LIMIT :limit`
    )
    .all({ project: project ?? null, ...filter, limit });
  const newest = db.prepare(
    `SELECT o.text AS text, o.subsystem AS subsystem FROM observations o
     WHERE o.entity_id = :id AND ${SUBSYSTEM_FILTER}
     ORDER BY o.created_at DESC, o.rowid DESC LIMIT 3`
  );
  const rows = entities.map((entity) => ({
    name: entity.name,
    type: entity.type,
    observations: newest
      .all({ id: entity.id, ...filter })
      .map((o) => ({ text: truncateText(o.text, BUDGETS.recentTextChars), subsystem: o.subsystem })),
  }));
  return fitToBudget(rows, BUDGETS.recentTotalChars).kept;
}

// Returns {events, total, returned, truncated}: callers summarize the result,
// and summarizing a silently trimmed history gives a confidently incomplete one.
export async function getTimeline({
  project,
  since,
  limit = 100,
  subsystem = null,
  maxTextChars = BUDGETS.timelineTextChars,
  maxTotalChars = BUDGETS.timelineTotalChars,
} = {}) {
  const sinceMs = since === null || since === undefined ? null : Date.parse(since);
  if (Number.isNaN(sinceMs)) {
    throw new Error(`since is not a date: ${since}`);
  }
  const db = getDb();
  const params = { project: project ?? null, since: sinceMs, ...filterParams(subsystem) };
  const where = `${IN_SCOPE} AND (:since IS NULL OR o.created_at >= :since) AND ${SUBSYSTEM_FILTER}`;
  const { total } = db
    .prepare(`SELECT count(*) AS total FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${where}`)
    .get(params);
  const events = db
    .prepare(
      `SELECT e.name AS entity, e.type AS type, o.text AS text, o.created_at AS createdAt
       FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${where}
       ORDER BY o.created_at ASC, o.rowid ASC LIMIT :limit`
    )
    .all({ ...params, limit })
    .map((row) => ({ entity: row.entity, type: row.type, text: truncateText(row.text, maxTextChars), createdAt: iso(row.createdAt) }));
  const { kept } = fitToBudget(events, maxTotalChars);
  return { events: kept, total, returned: kept.length, truncated: kept.length < total };
}

// Deletes observations by rowid together with their full-text rows.
function removeObservationRows(db, rowids) {
  const dropText = db.prepare("DELETE FROM observation_text_fts WHERE rowid = ?");
  const drop = db.prepare("DELETE FROM observations WHERE rowid = ?");
  for (const rowid of rowids) {
    dropText.run(rowid);
    drop.run(rowid);
  }
}

export async function deleteObservations(entity, observationIds, project = null) {
  const db = getDb();
  const target = resolveEntity(db, entity, project);
  if (!target || observationIds.length === 0) {
    return 0;
  }
  const marks = observationIds.map(() => "?").join(", ");
  return inTransaction(db, () => {
    const doomed = db
      .prepare(`SELECT rowid AS rid FROM observations WHERE entity_id = ? AND id IN (${marks})`)
      .all(target.id, ...observationIds);
    removeObservationRows(db, doomed.map((row) => row.rid));
    return doomed.length;
  });
}

// Its relations go with it through ON DELETE CASCADE.
export async function deleteEntity(entity, project = null) {
  const db = getDb();
  const target = resolveEntity(db, entity, project);
  if (!target) {
    return;
  }
  inTransaction(db, () => {
    const rowids = db.prepare("SELECT rowid AS rid FROM observations WHERE entity_id = ?").all(target.id).map((row) => row.rid);
    removeObservationRows(db, rowids);
    db.prepare("DELETE FROM entity_name_fts WHERE rowid = ?").run(target.id);
    db.prepare("DELETE FROM entities WHERE id = ?").run(target.id);
  });
}

// Deletes observations older than `olderThanDays`, keeping each entity's
// newest `keepPerEntity` of those old ones, so an entity is never wiped down to
// nothing just because nobody touched it in a while.
export async function pruneObservations({ project, olderThanDays = 180, keepPerEntity = 3, dryRun = false }) {
  const db = getDb();
  const stale = db
    .prepare(
      `WITH old AS (
         SELECT o.rowid AS rid, o.id AS id, o.text AS text,
                row_number() OVER (PARTITION BY o.entity_id ORDER BY o.created_at DESC, o.rowid DESC) AS position
         FROM observations o JOIN entities e ON e.id = o.entity_id
         WHERE ${IN_SCOPE} AND o.created_at < :cutoff
       )
       SELECT rid, id, text FROM old WHERE position > :keep ORDER BY rid`
    )
    .all({ project: project ?? null, cutoff: Date.now() - olderThanDays * 86_400_000, keep: keepPerEntity });
  if (!dryRun) {
    inTransaction(db, () => removeObservationRows(db, stale.map((row) => row.rid)));
  }
  return { pruned: stale.length, sample: stale.slice(0, 20).map((row) => ({ id: row.id, text: row.text })) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-graph-read.test.js tests/sqlite-graph-write.test.js`
Expected: PASS, 10 + 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sqliteGraph.js tests/sqlite-graph-read.test.js
git commit -m "feat(memory): Read, delete and prune memories in SQLite" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Standing facts: collapse and review

**Files:**
- Modify: `src/lib/sqliteGraph.js` (append)
- Modify: `src/lib/injection.js` (the hidden count leaves out collapsed repeats)
- Test: `tests/sqlite-graph-pinned.test.js`, `tests/injection.test.js`

**Interfaces:**
- Consumes: `wordOverlap` (Task 1), Task 5's helpers.
- Produces:
  - `REPEAT_COLLAPSE_OVERLAP = 0.8`, `REPEAT_REVIEW_OVERLAP = 0.3`
  - `getPinnedFacts({ project, limit = 100 }): Promise<{ facts[{ entity, type, text }], total, collapsed, returned, truncated }>`
  - `findRepeatedFacts({ project = null, min = 0.3 }): Promise<{ similarity, newer, older }[]>`, where `newer` and `older` are `{ entity, project, id, createdAt, text }`

- [ ] **Step 1: Write the failing tests**

`tests/sqlite-graph-pinned.test.js`:

```js
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { closeDb } from "../src/lib/memoryStore.js";
import * as graph from "../src/lib/sqliteGraph.js";

const P = "github.com/acme/app";
// Word overlaps: F2 vs F1 = 8/9 (0.89, a repeat); F3 vs F1 = 7/9 (0.78, kept);
// F3 vs F2 = 7/10 (0.70, kept).
const F1 = "alpha bravo charlie delta echo foxtrot golf hotel";
const F2 = "alpha bravo charlie delta echo foxtrot golf hotel india";
const F3 = "alpha bravo charlie delta echo foxtrot golf kilo";

async function addFact(text, project = P) {
  await graph.addObservations({ entity: "preference:style", entityType: "preference", project, observations: [text] });
}

beforeEach(async () => {
  useTempStore();
  await addFact(F1);
  await addFact(F3);
  await addFact(F2);
  await graph.addObservations({ entity: "decision:noise", entityType: "decision", project: P, observations: ["not a standing fact"] });
});

after(() => {
  closeDb();
});

test("repeats at overlap 0.8 or more collapse to the newest, and are counted", async () => {
  const pinned = await graph.getPinnedFacts({ project: P });
  assert.deepEqual(pinned.facts.map((f) => f.text), [F2, F3]);
  assert.equal(pinned.collapsed, 1);
  assert.equal(pinned.total, 3);
});

test("collapsed repeats are not reported as truncation", async () => {
  const pinned = await graph.getPinnedFacts({ project: P });
  assert.equal(pinned.returned, 2);
  assert.equal(pinned.truncated, false);
});

test("findRepeatedFacts lists likely repeats most similar first, with the ids to delete", async () => {
  const pairs = await graph.findRepeatedFacts({ project: P });
  assert.deepEqual(
    pairs.map((p) => [p.newer.text, p.older.text, Number(p.similarity.toFixed(2))]),
    [
      [F2, F1, 0.89],
      [F3, F1, 0.78],
      [F2, F3, 0.7],
    ]
  );
  assert.match(pairs[0].older.id, /^[0-9a-f-]{36}$/);
  assert.equal(pairs[0].older.entity, "preference:style");
});

test("findRepeatedFacts honours min", async () => {
  assert.equal((await graph.findRepeatedFacts({ project: P, min: 0.75 })).length, 2);
});

test("findRepeatedFacts with no project pairs facts only within one scope", async () => {
  await addFact(F1, "github.com/acme/other");
  const pairs = await graph.findRepeatedFacts({ min: 0.95 });
  assert.equal(pairs.length, 0, "the same text in two projects is not a repeat any session sees");
});
```

Append to `tests/injection.test.js`:

```js
test("the hidden-facts note leaves out repeats that were collapsed on purpose", () => {
  const clipped = { ...PINNED, total: 9, collapsed: 2, returned: 2, truncated: true };
  const out = renderInjection({ project: PROJECT, pinned: clipped, map: MAP });
  assert.ok(out.includes("5 more"), "9 eligible, 2 collapsed, 2 shown: 5 were cut for space");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-graph-pinned.test.js tests/injection.test.js`
Expected: FAIL, 6 tests. `graph.getPinnedFacts is not a function`, and the injection note says "7 more".

- [ ] **Step 3: Write the implementation**

Append to `src/lib/sqliteGraph.js`:

```js
// Entity types whose observations always apply, matched by prefix against
// `type` (one live entity is typed "Constraint Amendment"), plus the entity
// named "user".
const PINNED_TYPES = ["user", "preference", "constraint", "convention"];
const PINNED_WHERE = `${IN_SCOPE} AND (${PINNED_TYPES.map((type) => `lower(coalesce(e.type, '')) LIKE '${type}%'`).join(" OR ")} OR e.name = 'user')`;

// Measured on 693 standing facts (engine spec, "Fix 2"): every pair at 0.8 or
// more was a repeat, and the next pair down (0.73) was two different tickets.
// Reworded repeats score as low as 0.33, below pairs that genuinely differ, so
// they are only listed for review (0.3), never collapsed.
export const REPEAT_COLLAPSE_OVERLAP = 0.8;
export const REPEAT_REVIEW_OVERLAP = 0.3;

// Rows arrive newest first, so the newest of each group of repeats is kept.
function collapseRepeats(rows) {
  const facts = [];
  let collapsed = 0;
  for (const row of rows) {
    if (facts.some((kept) => wordOverlap(kept.text, row.text) >= REPEAT_COLLAPSE_OVERLAP)) {
      collapsed += 1;
    } else {
      facts.push(row);
    }
  }
  return { facts, collapsed };
}

/**
 * The standing facts injected verbatim at SessionStart, repeats collapsed.
 * `total` counts every eligible fact, `collapsed` the repeats hidden on purpose,
 * and `truncated` says whether the budget or `limit` cut any of the rest.
 */
export async function getPinnedFacts({ project, limit = 100 } = {}) {
  const db = getDb();
  const params = { project: project ?? null };
  const { total } = db
    .prepare(`SELECT count(*) AS total FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${PINNED_WHERE}`)
    .get(params);
  const rows = db
    .prepare(
      `SELECT e.name AS entity, e.type AS type, o.text AS text
       FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${PINNED_WHERE}
       ORDER BY o.created_at DESC, o.rowid DESC LIMIT :limit`
    )
    .all({ ...params, limit });
  const { facts, collapsed } = collapseRepeats(rows);
  const shown = facts.map((row) => ({ entity: row.entity, type: row.type, text: truncateText(row.text, BUDGETS.pinnedTextChars) }));
  const { kept } = fitToBudget(shown, BUDGETS.pinnedTotalChars);
  return { facts: kept, total, collapsed, returned: kept.length, truncated: kept.length < total - collapsed };
}

const shownFact = (row) => ({ entity: row.entity, project: shownProject(row.project), id: row.id, createdAt: iso(row.createdAt), text: row.text });

/**
 * Standing facts that are likely repeats of each other, most similar first,
 * for a person to merge or delete. With no project, only facts from the same
 * scope are paired: a fact repeated across projects is never seen twice.
 */
export async function findRepeatedFacts({ project = null, min = REPEAT_REVIEW_OVERLAP } = {}) {
  const facts = getDb()
    .prepare(
      `SELECT e.name AS entity, e.project AS project, o.id AS id, o.text AS text, o.created_at AS createdAt
       FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${PINNED_WHERE}
       ORDER BY o.created_at DESC, o.rowid DESC`
    )
    .all({ project: project ?? null });
  const pairs = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const sameScope = project !== null || facts[i].project === facts[j].project;
      const similarity = sameScope ? wordOverlap(facts[i].text, facts[j].text) : 0;
      if (sameScope && similarity >= min) {
        pairs.push({ similarity, newer: shownFact(facts[i]), older: shownFact(facts[j]) });
      }
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}
```

In `src/lib/injection.js`, replace:

```js
        `\n- [${pinned.total - pinned.returned} more standing fact(s) not shown — ` +
```

with:

```js
        `\n- [${pinned.total - (pinned.collapsed ?? 0) - pinned.returned} more standing fact(s) not shown — ` +
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-graph-pinned.test.js tests/injection.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sqliteGraph.js src/lib/injection.js tests/sqlite-graph-pinned.test.js tests/injection.test.js
git commit -m "feat(memory): Collapse repeated standing facts and list likely repeats" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Relevance by matched words

**Files:**
- Modify (rewrite): `src/lib/relevance.js`
- Modify (rewrite): `src/lib/fallback.js`
- Modify: `src/lib/telemetry.js`
- Test: `tests/relevance.test.js` (rewrite), `tests/fallback.test.js`, `tests/telemetry.test.js`

**Why this changes:** the spec's "Search" section has the measurements. No FTS5 score cut-off separates strong from weak matches. Counting the query's words that the best entity holds does:

- It agrees with Lucene's labels on 208 of 214 logged searches.
- It labels both junk probes weak.
- Five of the six disagreements are Lucene's own fragment matches.

The fallback's score floors go for the same reason, and its coverage check stays.

Until Task 10 swaps the engine, the Neo4j `graph.js` still calls `classifyRelevance` without a query. Its rows carry no word counts, so its results read `unscored`. Nothing tests that interim state, and Task 10 removes it.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `queryWords(text): Set<string>`
  - `classifyRelevance(rows, query): "none" | "weak" | "strong" | "unscored"`. It reads `rows[0].matchedQueryWords`.
  - `describeRelevance(relevance): string | null`
  - `WEAK_SCORE` (legacy telemetry only)
  - `otherProjectResults(rows, currentProject, query)` (coverage only; `MULTI_WORD_MIN_SCORE` removed)
  - Telemetry entries gain `relevance`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `tests/relevance.test.js` with:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { topScore, classifyRelevance, describeRelevance, queryWords } from "../src/lib/relevance.js";

describe("topScore", () => {
  test("takes the best score present, ignoring unscored rows", () => {
    assert.equal(topScore([{ score: 1.2 }, { score: 4.8 }, { score: 0.3 }]), 4.8);
    assert.equal(topScore([{ score: 2 }, { name: "no score" }]), 2);
  });

  test("returns null when there is nothing to score", () => {
    assert.equal(topScore([]), null);
    assert.equal(topScore([{ name: "a" }]), null, "unscored is not zero-scored");
    assert.equal(topScore(null), null);
    assert.equal(topScore({ results: [] }), null);
  });

  test("reads through a results envelope", () => {
    assert.equal(topScore({ results: [{ score: 3.1 }] }), 3.1);
  });
});

describe("queryWords", () => {
  test("lowercase words longer than two characters", () => {
    assert.deepEqual([...queryWords("Fix the JUMP-1463 bug, ok?")], ["fix", "the", "jump", "1463", "bug"]);
  });
});

describe("classifyRelevance", () => {
  test("no rows is a miss, not a weak match", () => {
    assert.equal(classifyRelevance([], "anything at all"), "none");
  });

  test("a multi-word query whose best result holds only one of its words is weak", () => {
    assert.equal(classifyRelevance([{ matchedQueryWords: 1 }], "zzz-nonexistent-term-qqq"), "weak");
  });

  test("two matched words make a multi-word result strong, however long the query", () => {
    assert.equal(classifyRelevance([{ matchedQueryWords: 2 }], "rust crate tests passing modules runner"), "strong");
  });

  test("a single-word query is strong as soon as it matched", () => {
    assert.equal(classifyRelevance([{ matchedQueryWords: 1 }], "podman"), "strong");
  });

  test("only the best result decides", () => {
    assert.equal(classifyRelevance([{ matchedQueryWords: 1 }, { matchedQueryWords: 3 }], "alpha bravo charlie"), "weak");
  });

  test("rows that carry no match count are reported as unscored rather than guessed at", () => {
    assert.equal(classifyRelevance([{ name: "a" }], "alpha bravo"), "unscored");
  });

  test("reads through a results envelope", () => {
    assert.equal(classifyRelevance({ results: [{ matchedQueryWords: 2 }] }, "alpha bravo"), "strong");
  });
});

describe("describeRelevance", () => {
  test("explains a weak result in-band so a caller cannot mistake it for an answer", () => {
    const note = describeRelevance("weak");
    assert.match(note, /weak/i);
    assert.match(note, /only one of your query's words/);
    assert.match(note, /may not|might not|likely/i);
  });

  test("says nothing when the result stands on its own", () => {
    assert.equal(describeRelevance("strong"), null);
    assert.equal(describeRelevance("unscored"), null);
  });

  test("explains an empty result too", () => {
    assert.match(describeRelevance("none"), /no match/i);
  });
});
```

In `tests/fallback.test.js`:

1. Change the import line to:

```js
import { fallbackEnabled, shouldFallBack, otherProjectResults, coversQuery, MAX_OTHER_PROJECT_RESULTS } from "../src/lib/fallback.js";
```

2. In `"returns null when nothing from another project is a strong match"`, replace `row("other", "weak", 1.2)` with:

```js
row("other", "weak", 1.2, { observations: [{ text: "an unrelated note", subsystem: null }] })
```

3. Replace the three tests that start `"a multi-word query needs a higher score than the weak floor…"`, `"a single-word query only needs the weak floor…"` and `"drops results below the weak floor even when a stronger one is present"` with:

```js
  test("a match that holds enough of the query's words is kept whatever its score", () => {
    assert.equal(otherProjectResults([row("other", "e", 0.5)], "mine", Q).results.length, 1);
  });

  test("a single-word query needs only that word", () => {
    const one = row("other", "e", 0.5, { observations: [{ text: "a rustacean note", subsystem: null }, { text: "rust here", subsystem: null }] });
    assert.equal(otherProjectResults([one], "mine", "rust").results.length, 1);
  });

  test("every covering match is kept, in rank order, up to the cap", () => {
    const out = otherProjectResults([row("other", "good", 6), row("other", "lower", 1.1)], "mine", Q);
    assert.deepEqual(out.results.map((r) => r.name), ["good", "lower"]);
  });
```

In `tests/telemetry.test.js`:

- Inside the `describe` that holds `"records the top relevance score so weak matches stay distinguishable"`, add:

```js
  test("records the relevance label a search came back with", () => {
    recordToolCall({
      tool: "memory_search",
      project: "p",
      args: { query: "x" },
      value: { results: [{ name: "a", score: 9 }], relevance: "weak", topScore: 9 },
      chars: 100,
      ok: true,
    });
    const [e] = readTelemetry(logFile);
    assert.equal(e.relevance, "weak");
  });
```

- Inside the `describe` that holds `"counts a hit that only matched a fragment as a weak read, not a success"`, add the test below. Each entry's label and score disagree on purpose, so only the label rule flags the right query.

```js
  test("a search logged with a label is judged by the label, not by its score", () => {
    const labelled = [
      ...entries,
      { at: "2026-08-02T12:00:00.000Z", tool: "memory_search", kind: "read", project: "a", hits: 3, topScore: 14.2, relevance: "weak", chars: 300, ok: true, query: "zzz-nonexistent-term-qqq" },
      { at: "2026-08-02T12:01:00.000Z", tool: "memory_search", kind: "read", project: "a", hits: 2, topScore: 0.4, relevance: "strong", chars: 300, ok: true, query: "podman" },
    ];
    const s = summarize(labelled);
    assert.equal(s.totals.weakReads, 1);
    assert.deepEqual(s.missedQueries.filter((q) => q.weak).map((q) => q.query), ["zzz-nonexistent-term-qqq"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/relevance.test.js tests/fallback.test.js tests/telemetry.test.js`
Expected: FAIL.

- `relevance.test.js`: a SyntaxError, because `queryWords` is not exported.
- `fallback.test.js`: the three new `otherProjectResults` tests fail on the score floors.
- `telemetry.test.js`: the two new tests fail. The old score rule flags `podman` (0.4) instead of the labelled query.

- [ ] **Step 3: Write the implementation**

Replace the whole of `src/lib/relevance.js` with:

```js
/**
 * How much to trust a search result, in-band, so a caller can say "memory
 * doesn't have that" instead of summarizing noise. Two unrelated callers need
 * the same judgement: graph.searchMemory, to annotate what it returns, and the
 * cross-project fallback, to decide what counts as an answer elsewhere.
 *
 * The SQLite engine judges by words, not scores. A result is weak when the
 * query has two or more words and its best entity holds only one of them
 * anywhere in its name or observations: a fragment match, like
 * "zzz-nonexistent-term-qqq" finding "term". Measured on 214 logged searches
 * (2026-10-09), this agrees with the Lucene-era labels on 208. Five of the six
 * disagreements were Lucene calling a lone word "strong" just above its floor
 * ("JUMP-1463" matching only "jump"); the sixth was a Lucene "weak" whose best
 * result held 8 of its 9 words. bm25 scores cannot make the call: strong
 * matches scored from 3.47 and the weak one up to 10.84.
 */

/** Lowercase words longer than two characters: the unit relevance and the fallback count. */
export function queryWords(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
  );
}

// The Lucene-era score floor. Only telemetry logged by the Neo4j engine, which
// carries a score but no label, is still judged by it.
export const WEAK_SCORE = 2.0;

const rowsOf = (value) => (Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : []);

/** Best score in a result set, or null if nothing carries one. */
export function topScore(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : null;
  if (!rows || rows.length === 0) {
    return null;
  }
  const scores = rows.map((row) => row?.score).filter((s) => typeof s === "number");
  return scores.length ? Math.max(...scores) : null;
}

/**
 * "none" | "weak" | "strong" | "unscored". Rows are ranked best first and carry
 * `matchedQueryWords`: how many of the query's words the entity holds.
 */
export function classifyRelevance(value, query) {
  const rows = rowsOf(value);
  if (rows.length === 0) {
    return "none";
  }
  const matched = rows[0].matchedQueryWords;
  if (typeof matched !== "number") {
    return "unscored";
  }
  return queryWords(query).size >= 2 && matched <= 1 ? "weak" : "strong";
}

/**
 * The in-band explanation, or null when the result speaks for itself. Only weak
 * and empty results get a note; annotating good ones too would train a reader
 * to skip the field.
 */
export function describeRelevance(relevance) {
  if (relevance === "none") {
    return "No match in memory for this query.";
  }
  if (relevance !== "weak") {
    return null;
  }
  return (
    "Weak match: the best result holds only one of your query's words, so it likely matched a fragment " +
    "rather than the meaning, and memory may not hold what was asked for. " +
    "Say so rather than summarizing these rows as the answer."
  );
}
```

Replace the whole of `src/lib/fallback.js` with:

```js
import { queryWords } from "./relevance.js";

// A search is scoped to the current project so unrelated repos don't leak into
// each other. That scoping also hides real answers: replayed over every logged
// search that came back weak or empty, all of them had a strong match in another
// project's namespace (a sub-project under another name, a worktree recorded as
// its own project, a question asked from the wrong repo). So when, and only
// when, the scoped search misses, look wider, and keep the wider results apart,
// labelled, so they are never mistaken for facts about this repo.
//
// What counts as an answer elsewhere is how much of the query a match shows:
// measured 2026-10-07, real rescues covered 50-100% of the query's words and
// junk 25-33%. The Lucene-era score floors that also guarded this are gone: the
// SQLite engine's bm25 scores are on another scale, and strong and weak matches
// overlap in it.

export const MAX_OTHER_PROJECT_RESULTS = 3;
const OBSERVATIONS_PER_RESULT = 2;

const FALLBACK_ENV = "CLAUDE_NEO4J_SEARCH_FALLBACK";

/** On unless CLAUDE_NEO4J_SEARCH_FALLBACK is `off` or `0`. */
export function fallbackEnabled(env = process.env) {
  const raw = env[FALLBACK_ENV]?.trim().toLowerCase();
  return raw !== "off" && raw !== "0";
}

/** Only a project-scoped search that came back none or weak is worth widening. */
export function shouldFallBack({ project, relevance, env = process.env }) {
  return project !== null && (relevance === "none" || relevance === "weak") && fallbackEnabled(env);
}

/**
 * Does what the reader would see of the entity (its name and first two
 * observations, the best matches) contain enough of the query's words to be an
 * answer rather than a fragment match? At least half of them, and never fewer
 * than two once the query has two or more.
 */
export function coversQuery(query, row) {
  const wanted = queryWords(query);
  if (wanted.size === 0) {
    return false;
  }
  const shown = row.observations.slice(0, OBSERVATIONS_PER_RESULT);
  const have = queryWords(`${row.name} ${shown.map((o) => o.text).join(" ")}`);
  const matched = [...wanted].filter((w) => have.has(w)).length;
  return matched >= Math.max(Math.ceil(wanted.size / 2), Math.min(wanted.size, 2));
}

/**
 * Compact, labelled matches from projects other than `currentProject`, or null.
 * `rows` come from an unscoped search and carry `project`. Global entities
 * (project '' or null) were already visible to the scoped search.
 */
export function otherProjectResults(rows, currentProject, query) {
  const strong = rows
    .filter((r) => r.project && r.project !== currentProject)
    .filter((r) => coversQuery(query, r))
    .slice(0, MAX_OTHER_PROJECT_RESULTS)
    .map((r) => ({
      project: r.project,
      name: r.name,
      type: r.type,
      score: r.score,
      observations: r.observations.slice(0, OBSERVATIONS_PER_RESULT),
      relationCount: r.relations?.length ?? 0,
    }));
  if (strong.length === 0) {
    return null;
  }
  return {
    note:
      "Nothing strong in this project's memory. These matches come from OTHER projects: " +
      "context that may help, not facts about this repo. Say which project they came from, " +
      "and call memory_get_entity only for entities in this project.",
    results: strong,
  };
}
```

In `src/lib/telemetry.js` (braced in Task 0):

- In `recordToolCall`, inside the `if (ok) {` block, after the lines that set `entry.topScore`, add:

```js
    if (typeof value?.relevance === "string") {
      entry.relevance = value.relevance;
    }
```

- In `summarize`, replace the line `const weak = !empty && typeof entry.topScore === "number" && entry.topScore < WEAK_SCORE;` with:

```js
      // A labelled entry was judged by the engine that served it; only Neo4j-era
      // entries, which carry a score but no label, fall back to the score floor.
      const weak =
        !empty &&
        (typeof entry.relevance === "string"
          ? entry.relevance === "weak"
          : typeof entry.topScore === "number" && entry.topScore < WEAK_SCORE);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `HOME="$(mktemp -d)" node --test tests/relevance.test.js tests/fallback.test.js tests/telemetry.test.js`
Expected: PASS, 55 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/relevance.js src/lib/fallback.js src/lib/telemetry.js tests/relevance.test.js tests/fallback.test.js tests/telemetry.test.js
git commit -m "feat(memory): Judge search relevance by the query words a result holds" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Search

**Files:**
- Create: `src/lib/search.js`
- Modify: `src/lib/sqliteGraph.js` (imports, plus `searchMemory`)
- Test: `tests/sqlite-graph-search.test.js`

**Interfaces:**
- Consumes:
  - `matchQuery` (Task 2)
  - `queryWords`, `classifyRelevance`, `topScore`, `describeRelevance` (Task 8)
  - `shouldFallBack`, `otherProjectResults` (Task 8)
  - existing `capRelations`, `resolveRelationCap` (`relations.js`)
- Produces:
  - `searchRows(db, { query, limit, project, filter, now = Date.now() })`. It returns rows `{ name, type, project, score, observations[{ text, subsystem }], relations[{ type, entity, direction }], matchedQueryWords }`, best first.
  - `searchMemory(query, limit = 10, project = null, { subsystem = null })`. It returns `{ results, relevance, topScore, note?, otherProjects? }`. Result rows hold exactly `name, type, score, observations, relations, relationCount`.

- [ ] **Step 1: Write the failing tests**

`tests/sqlite-graph-search.test.js`:

```js
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { useTempStore } from "./helpers/tempStore.js";
import { closeDb, getDb } from "../src/lib/memoryStore.js";
import * as graph from "../src/lib/sqliteGraph.js";

const P = "github.com/acme/app";
const DAY = 86_400_000;
const setTimeOf = (text, ms) => getDb().prepare("UPDATE observations SET created_at = ? WHERE text = ?").run(ms, text);
const names = (found) => found.results.map((r) => r.name);

beforeEach(() => {
  useTempStore();
});

after(() => {
  closeDb();
});

test("an entity matched only by its name is returned with its observations", async () => {
  await graph.addObservations({ entity: "decision:zzqx-storage-layout", project: P, observations: ["volumes are chosen by engine"] });
  const found = await graph.searchMemory("decision:zzqx-storage-layout", 10, P);
  assert.deepEqual(names(found), ["decision:zzqx-storage-layout"]);
  assert.equal(found.results[0].observations[0].text, "volumes are chosen by engine");
  assert.equal(found.relevance, "strong");
});

test("result rows keep the engine's original shape", async () => {
  await graph.addObservations({ entity: "decision:shape", project: P, observations: ["shape probe"] });
  const found = await graph.searchMemory("shape probe", 10, P);
  assert.deepEqual(Object.keys(found.results[0]).sort(), ["name", "observations", "relationCount", "relations", "score", "type"]);
});

test("best-matching observations come first, topped up with the newest, five at most", async () => {
  await graph.addObservations({
    entity: "decision:mixed",
    project: P,
    observations: ["zebrafinch one", "plain two", "plain three", "zebrafinch four", "plain five", "plain six", "plain seven"],
  });
  const [result] = (await graph.searchMemory("zebrafinch", 10, P)).results;
  assert.equal(result.observations.length, 5);
  assert.ok(result.observations.slice(0, 2).every((o) => o.text.startsWith("zebrafinch")));
  assert.deepEqual(result.observations.slice(2).map((o) => o.text), ["plain seven", "plain six", "plain five"]);
});

test("a project search sees its own and global entities but not other projects'", async () => {
  await graph.addObservations({ entity: "decision:here", project: P, observations: ["quokka here"] });
  await graph.addObservations({ entity: "user", project: null, observations: ["quokka global"] });
  await graph.addObservations({ entity: "decision:there", project: "github.com/acme/other", observations: ["quokka there"] });
  assert.deepEqual(names(await graph.searchMemory("quokka", 10, P)).sort(), ["decision:here", "user"]);
});

test("an old match decays below an equally good fresh one", async () => {
  await graph.addObservations({ entity: "decision:old", project: P, observations: ["wombat note"] });
  await graph.addObservations({ entity: "decision:new", project: P, observations: ["wombat memo"] });
  setTimeOf("wombat note", Date.now() - 300 * DAY);
  assert.deepEqual(names(await graph.searchMemory("wombat", 10, P)), ["decision:new", "decision:old"]);
});

test("relations in a result say which way they point", async () => {
  await graph.createRelation({ from: "decision:alpha", to: "decision:bravo", type: "uses", project: P });
  await graph.createRelation({ from: "decision:charlie", to: "decision:alpha", type: "blocks", project: P });
  await graph.createRelation({ from: "decision:alpha", to: "decision:alpha", type: "see-also", project: P });
  const found = await graph.searchMemory("decision:alpha", 10, P);
  const alpha = found.results.find((r) => r.name === "decision:alpha");
  assert.deepEqual(alpha.relations, [
    { type: "blocks", entity: "decision:charlie", direction: "in" },
    { type: "see-also", entity: "decision:alpha", direction: "self" },
    { type: "uses", entity: "decision:bravo", direction: "out" },
  ]);
});

test("a multi-word query whose best result holds one of its words is weak, with a note", async () => {
  await graph.addObservations({ entity: "decision:hook", project: P, observations: ["the capture hook runs at session end"] });
  const found = await graph.searchMemory("zzz-nonexistent-capture-qqq", 10, P);
  assert.equal(found.relevance, "weak");
  assert.match(found.note, /only one of your query's words/);
});

test("a subsystem filter narrows the matched observations", async () => {
  await graph.addObservations({
    entity: "fact:tagged",
    project: P,
    observations: [
      { text: "lemur capture fact", subsystem: "capture" },
      { text: "lemur backup fact", subsystem: "backup" },
    ],
  });
  const found = await graph.searchMemory("lemur", 10, P, { subsystem: "capture" });
  assert.deepEqual(found.results[0].observations.map((o) => o.text), ["lemur capture fact"]);
});

test("FTS5 syntax in a query is searched as plain words", async () => {
  await graph.addObservations({ entity: "decision:near", project: P, observations: ["near the value"] });
  const found = await graph.searchMemory('AND OR NOT NEAR "x" name:value* (a)', 10, P);
  assert.ok(Array.isArray(found.results));
});

test("a query with no words finds nothing and says so", async () => {
  await graph.addObservations({ entity: "decision:any", project: P, observations: ["anything"] });
  const found = await graph.searchMemory("-- !!", 10, P);
  assert.deepEqual(found.results, []);
  assert.equal(found.relevance, "none");
});

test("a miss here surfaces another project's covering match, labelled", async () => {
  await graph.addObservations({
    entity: "decision:elsewhere",
    project: "github.com/acme/other",
    observations: ["the quuxplorf handshake needs a zebrafinch retry", "second", "third"],
  });
  const found = await graph.searchMemory("quuxplorf zebrafinch", 10, P);
  assert.equal(found.results.length, 0);
  assert.equal(found.otherProjects.results[0].project, "github.com/acme/other");
  assert.equal(found.otherProjects.results[0].observations.length, 2);
});

// Full-text rows are keyed by the observations table's implicit rowid. SQLite
// keeps an indexed table's rowids through VACUUM (checked on 3.51); this pins
// that, because the day it stops, search returns the wrong observations.
test("search still finds the right observations after VACUUM", async () => {
  const [gone] = await graph.addObservations({ entity: "decision:vacuum", project: P, observations: ["first doomed note"] });
  await graph.addObservations({ entity: "decision:vacuum", project: P, observations: ["second ocelot note", "third plain note"] });
  await graph.deleteObservations("decision:vacuum", [gone], P);
  getDb().exec("VACUUM");
  const [result] = (await graph.searchMemory("ocelot", 10, P)).results;
  assert.equal(result.observations[0].text, "second ocelot note");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-graph-search.test.js`
Expected: FAIL, 12 tests. `graph.searchMemory is not a function`.

- [ ] **Step 3: Write the implementation**

`src/lib/search.js`:

```js
import { matchQuery } from "./segment.js";
import { BUDGETS, truncateText } from "./budget.js";
import { queryWords } from "./relevance.js";

// Ranks entities for a query as the Neo4j engine did:
// - the best bm25 match across entity names and observation text (negated,
//   since FTS5 ranks lower as better);
// - scoped to the project plus global entities;
// - decayed by the age of the entity's newest observation: 1 / (1 + days / 30).
// Then each entity gets its best-matching observations topped up with its
// newest, its relations with their direction, and how many of the query's
// words it holds (relevance.js decides "weak" from that).

const DAY_MS = 86_400_000;
const OBSERVATIONS_PER_RESULT = 5;
const SUBSYSTEM_FILTER = "(:subsystem IS NULL OR o.subsystem = :subsystem) AND (:untaggedOnly = 0 OR o.subsystem IS NULL)";

const RANK_SQL = `
  WITH hits(entity_id, score) AS (
    SELECT e.id, -bm25(entity_name_fts)
    FROM entity_name_fts JOIN entities e ON e.id = entity_name_fts.rowid
    WHERE entity_name_fts MATCH :match
      AND ((:subsystem IS NULL AND :untaggedOnly = 0)
           OR EXISTS (SELECT 1 FROM observations o WHERE o.entity_id = e.id AND ${SUBSYSTEM_FILTER}))
    UNION ALL
    SELECT o.entity_id, -bm25(observation_text_fts)
    FROM observation_text_fts JOIN observations o ON o.rowid = observation_text_fts.rowid
    WHERE observation_text_fts MATCH :match AND ${SUBSYSTEM_FILTER}
  )
  SELECT e.id AS id, e.name AS name, e.type AS type, e.project AS project, max(h.score) AS score,
         (SELECT max(created_at) FROM observations WHERE entity_id = e.id) AS lastSeen
  FROM hits h JOIN entities e ON e.id = h.entity_id
  WHERE (:project IS NULL OR e.project = :project OR e.project = '')
  GROUP BY e.id`;

const MATCHED_SQL = `
  SELECT o.text AS text, o.subsystem AS subsystem
  FROM observation_text_fts JOIN observations o ON o.rowid = observation_text_fts.rowid
  WHERE observation_text_fts MATCH :match AND o.entity_id = :id AND ${SUBSYSTEM_FILTER}
  ORDER BY bm25(observation_text_fts), o.rowid
  LIMIT ${OBSERVATIONS_PER_RESULT}`;

const NEWEST_SQL = `
  SELECT o.text AS text, o.subsystem AS subsystem FROM observations o
  WHERE o.entity_id = :id AND ${SUBSYSTEM_FILTER}
  ORDER BY o.created_at DESC, o.rowid DESC
  LIMIT ${OBSERVATIONS_PER_RESULT * 2}`;

const RELATIONS_SQL = `
  SELECT r.type AS type, other.name AS entity,
         CASE WHEN r.from_id = :id AND r.to_id = :id THEN 'self'
              WHEN r.from_id = :id THEN 'out' ELSE 'in' END AS direction
  FROM relations r
  JOIN entities other ON other.id = CASE WHEN r.from_id = :id THEN r.to_id ELSE r.from_id END
  WHERE r.from_id = :id OR r.to_id = :id
  ORDER BY r.type, other.name`;

const decayed = (score, lastSeen, now) =>
  lastSeen === null ? score : score / (1 + Math.floor((now - lastSeen) / DAY_MS) / 30);

export function searchRows(db, { query, limit, project, filter, now = Date.now() }) {
  const match = matchQuery(query);
  if (match === null) {
    return [];
  }
  const subsystem = { subsystem: filter.subsystem, untaggedOnly: filter.untaggedOnly ? 1 : 0 };
  const ranked = db
    .prepare(RANK_SQL)
    .all({ match, project: project ?? null, ...subsystem })
    .map((row) => ({ ...row, rankScore: decayed(row.score, row.lastSeen, now) }))
    .sort((a, b) => b.rankScore - a.rankScore || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit);
  const wanted = queryWords(query);
  return ranked.map((row) => describeEntity(db, row, { match, subsystem, wanted }));
}

function describeEntity(db, row, { match, subsystem, wanted }) {
  const matched = db.prepare(MATCHED_SQL).all({ match, id: row.id, ...subsystem });
  const matchedTexts = new Set(matched.map((o) => o.text));
  const newest = db.prepare(NEWEST_SQL).all({ id: row.id, ...subsystem }).filter((o) => !matchedTexts.has(o.text));
  const observations = [...matched, ...newest]
    .slice(0, OBSERVATIONS_PER_RESULT)
    .map((o) => ({ text: truncateText(o.text, BUDGETS.searchTextChars), subsystem: o.subsystem }));
  const relations = db
    .prepare(RELATIONS_SQL)
    .all({ id: row.id })
    .map((r) => ({ type: r.type, entity: r.entity, direction: r.direction }));
  return {
    name: row.name,
    type: row.type,
    project: row.project,
    score: row.rankScore,
    observations,
    relations,
    matchedQueryWords: countHeldWords(db, row, wanted),
  };
}

// How many of the query's words the entity holds anywhere: its name or any observation.
function countHeldWords(db, row, wanted) {
  const { text } = db.prepare("SELECT group_concat(text, ' ') AS text FROM observations WHERE entity_id = ?").get(row.id);
  const held = queryWords(`${row.name} ${text ?? ""}`);
  return [...wanted].filter((word) => held.has(word)).length;
}
```

In `src/lib/sqliteGraph.js`, add these imports below the existing ones:

```js
import { classifyRelevance, topScore, describeRelevance } from "./relevance.js";
import { capRelations, resolveRelationCap } from "./relations.js";
import { shouldFallBack, otherProjectResults } from "./fallback.js";
import { searchRows } from "./search.js";
```

Append to `src/lib/sqliteGraph.js`:

```js
const withoutProject = ({ project, ...row }) => row;
const withoutMatchCount = ({ matchedQueryWords, ...row }) => row;

function buildSearchEnvelope(rows, query) {
  // Capped before budgeting, so the budget sees the real payload size.
  const capped = capRelations(rows.map(withoutProject), query, resolveRelationCap());
  const kept = fitToBudget(capped, BUDGETS.searchTotalChars).kept;
  const relevance = classifyRelevance(kept, query);
  const results = kept.map(withoutMatchCount);
  const score = topScore(results);
  const envelope = { results, relevance, topScore: score };
  const note = describeRelevance(relevance);
  if (note) {
    envelope.note = note;
  }
  return envelope;
}

export async function searchMemory(query, limit = 10, project = null, { subsystem = null } = {}) {
  const filter = parseSubsystemFilter(subsystem);
  const db = getDb();
  const envelope = buildSearchEnvelope(searchRows(db, { query, limit, project, filter }), query);
  if (!shouldFallBack({ project, relevance: envelope.relevance })) {
    return envelope;
  }
  const other = otherProjectResults(searchRows(db, { query, limit, project: null, filter }), project, query);
  return other ? { ...envelope, otherProjects: other } : envelope;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `HOME="$(mktemp -d)" node --test tests/sqlite-graph-*.test.js`
Expected: PASS, 39 tests (12 search, 12 write, 10 read, 5 pinned).

- [ ] **Step 5: Commit**

```bash
git add src/lib/search.js src/lib/sqliteGraph.js tests/sqlite-graph-search.test.js
git commit -m "feat(memory): Search memory with SQLite full-text and show relation direction" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Switch graph.js to SQLite

**Files:**
- Replace: `src/lib/graph.js` with `src/lib/sqliteGraph.js`
- Modify:
  - `src/mcp/server.js`
  - `src/hooks/session-start.js`
  - `src/hooks/capture.js`
  - `src/lib/injection.js`
  - `scripts/memory-cli.mjs`
  - `scripts/statusline.mjs`
  - `scripts/token-cost.mjs`
- Create (tests): `tests/session-start-hook.test.js`, `tests/mcp-server.test.js`
- Modify (tests): `tests/capture-hook.test.js`, the four `graph-*.test.js`, every `sqlite-graph-*.test.js`

**Interfaces:**
- Consumes: everything above. Exported names from `graph.js` are unchanged.
- Produces:
  - `graph.js` is the SQLite engine.
  - No caller imports `schema.js` or `neo4jClient.js` except the migration reader and the legacy scripts.
  - `memory_status` returns `{ engine: "sqlite", path, project, entityCount, observationCount }`.
  - Session start says `Memory: …` instead of `Neo4j memory: …`.

**Order matters.** Do not point the `graph-*` or `sqlite-graph-*` tests at `graph.js` until Step 3 has made `graph.js` the SQLite engine. Before then they run against Neo4j: the `sqlite-graph-*` tests have no cleanup and write into the live graph, and the `graph-*` tests no longer close the driver and hang.

- [ ] **Step 1: Write the failing tests for the entry points**

`tests/session-start-hook.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SESSION_START = fileURLToPath(new URL("../src/hooks/session-start.js", import.meta.url));

// Runs the hook as Claude Code does: JSON in on stdin, JSON out on stdout. HOME
// is a fresh directory, so no real config, store or capture state is touched.
function runSessionStart(env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-start-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SESSION_START], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, HOME: home, CLAUDE_NEO4J_SQLITE: path.join(home, "memory.sqlite"), ...env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", () => resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ session_id: "session-start-test", cwd: home }));
  });
}

test("a first session opens an empty store and says nothing is remembered yet", async () => {
  const out = await runSessionStart();
  assert.match(out.systemMessage, /Memory: nothing remembered yet/);
  assert.match(out.hookSpecificOutput.additionalContext, /^## Memory \(/);
});

test("a store that cannot be opened is reported, not fatal", async () => {
  const out = await runSessionStart({ CLAUDE_NEO4J_SQLITE: "/dev/null/memory.sqlite" });
  assert.match(out.systemMessage, /Memory: unavailable/);
});
```

`tests/mcp-server.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SERVER = fileURLToPath(new URL("../src/mcp/server.js", import.meta.url));

// Starts the memory server in a fresh HOME and speaks MCP to it over stdio as
// Claude Code does, one JSON-RPC message per line; `work` gets a tool caller.
async function withServer(work) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-server-"));
  const store = path.join(home, "memory.sqlite");
  const child = spawn(process.execPath, [SERVER], {
    cwd: home,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, HOME: home, CLAUDE_NEO4J_SQLITE: store },
  });
  const waiting = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let lastId = 0;
  const request = (method, params) =>
    new Promise((resolve) => {
      lastId += 1;
      waiting.set(lastId, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: lastId, method, params })}\n`);
    });
  const callTool = async (name, args = {}) => {
    const reply = await request("tools/call", { name, arguments: args });
    return JSON.parse(reply.result.content[0].text);
  };
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return await work({ callTool, store });
  } finally {
    child.kill();
  }
}

test("memory_status names the SQLite store it uses", async () => {
  await withServer(async ({ callTool, store }) => {
    const status = await callTool("memory_status");
    assert.equal(status.engine, "sqlite");
    assert.equal(status.path, store);
    assert.equal(status.observationCount, 0);
  });
});

test("an observation written through the server is found by memory_search", async () => {
  await withServer(async ({ callTool }) => {
    await callTool("memory_add_observations", { entity: "decision:storage", observations: ["the quokka store is SQLite"] });
    const found = await callTool("memory_search", { query: "quokka" });
    assert.deepEqual(found.results.map((r) => r.name), ["decision:storage"]);
  });
});
```

In `tests/capture-hook.test.js`:

1. Replace the `UNREACHABLE` block and its two-line comment with:

```js
// A store path that cannot be created (/dev/null is a file): the store check
// fails before any extraction or write, which is exactly the transient failure
// the log has to explain.
const UNAVAILABLE = {
  CLAUDE_NEO4J_SQLITE: "/dev/null/memory.sqlite",
};
```

2. Rename every remaining `UNREACHABLE` to `UNAVAILABLE`: the `runHook` default and two spawn envs.
3. Replace everything from the line `// --- the success path` through the end of the `"a successful PreCompact records what it captured"` test (its closing `);`) with the block below. It covers `realCredentials`, `neo4jReachable`, `NEO4J_UP` and the old test.

```js
// --- the success path -------------------------------------------------------
// The model is faked (a fixed structured payload) but everything downstream of
// it is real: chunking, the store writes and the log line under test. The
// store sits in the sandbox HOME, so nothing outside it is touched.
test("a successful PreCompact records what it captured", async () => {
  const box = sandbox();
  const sessionId = "1f6c9a02-dead-4beef-9999-000000000003";
  const entity = "test:precompact-success-logging";

  // Stands in for `claude -p`: same JSON envelope extractStructured unwraps.
  const fake = path.join(box.home, "fake-claude");
  fs.writeFileSync(
    fake,
    "#!/usr/bin/env bash\ncat >/dev/null\n" +
      `cat <<'JSON'\n${JSON.stringify({
        structured_output: {
          entities: [{ name: entity, type: "test", observations: [{ text: "throwaway fixture from capture-hook.test.js" }] }],
          relations: [],
        },
      })}\nJSON\n`
  );
  fs.chmodSync(fake, 0o755);

  const { stdout } = await runHook(
    {
      hook_event_name: "PreCompact",
      session_id: sessionId,
      transcript_path: box.transcript,
      cwd: box.home,
    },
    box,
    { CLAUDE_NEO4J_SQLITE: path.join(box.home, ".claude-neo4j", "memory.sqlite"), CLAUDE_NEO4J_CAPTURE_CLI: fake }
  );

  // Guards the test against passing vacuously: the systemMessage is only
  // emitted once observations were actually written, so if this holds, the
  // run really did reach the success branch and any missing log line is the
  // defect rather than an early return.
  assert.match(stdout, /captured 1 new memory observation/, "the capture itself must have succeeded for the log assertion to mean anything");

  const log = fs.existsSync(box.logFile) ? fs.readFileSync(box.logFile, "utf8") : "";
  assert.match(log, /PreCompact: captured 1 observation\(s\)/, "a success that leaves no trace is why this path looked unverified for weeks");
  assert.match(log, new RegExp(sessionId), "the success line must name its session too");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/session-start-hook.test.js tests/mcp-server.test.js tests/capture-hook.test.js 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'`

Only these three files, nothing else (see "Order matters"). Expected: 9 tests, 2 pass, 7 fail:

- the four new session-start and server tests;
- the capture success test;
- "a failed PreCompact names the session it lost" and "… queues itself for the SessionStart sweep". The old hook skips capture entirely when Neo4j isn't configured, so it logs nothing.

- [ ] **Step 3: Swap the engine, re-point the tests, rewire the callers**

First the engine and the tests that exercise it:

```bash
git mv -f src/lib/sqliteGraph.js src/lib/graph.js
sed -i '' 's#../src/lib/sqliteGraph.js#../src/lib/graph.js#' tests/sqlite-graph-*.test.js
for f in graph-search graph-pinned graph-fallback graph-subsystem; do
  sed -i '' \
    -e 's#import { ensureSchema } from "../src/lib/schema.js";#import { useTempStore } from "./helpers/tempStore.js";#' \
    -e 's#import { closeDriver } from "../src/lib/neo4jClient.js";#import { closeDb } from "../src/lib/memoryStore.js";#' \
    -e 's#await ensureSchema();#useTempStore();#' \
    -e 's#await closeDriver();#closeDb();#' \
    tests/$f.test.js
done
grep -n 'sqliteGraph\|schema.js\|neo4jClient\|ensureSchema\|closeDriver' tests/graph-*.test.js tests/sqlite-graph-*.test.js
```

Expected: the final `grep` prints nothing.

Then the callers. Each edit replaces the quoted text exactly.

**`src/mcp/server.js`**

- Delete the line `import { ensureSchema } from "../lib/schema.js";`.
- Replace

  ```js
  import { closeDriver } from "../lib/neo4jClient.js";
  import { loadConnectionConfig, shouldNotifyOnWrite } from "../lib/config.js";
  ```

  with

  ```js
  import { getDb, closeDb, storeStatus } from "../lib/memoryStore.js";
  import { shouldNotifyOnWrite } from "../lib/config.js";
  ```

- Replace `memory_search`'s description string (the second argument of its `registerTool` call) with:

  ```js
    "Full-text search memory for entities and observations matching a query. Returns {results, relevance, topScore} where results are matching entities with their best-matching observations and a capped list of directly related entities, each {type, entity, direction}: direction 'out' means this result -[type]-> entity, 'in' means entity -[type]-> this result, 'self' a relation to itself (`relationCount` is the true total; call memory_get_entity for every relation). `relevance` is 'strong', 'weak', or 'none': 'weak' means the best result holds only one of a multi-word query's words, a fragment match that likely does not answer it. When `relevance` is 'weak' a `note` explains why - tell the user memory doesn't appear to have this rather than presenting those rows as the answer. When this project has no strong match, a separate `otherProjects` block may list up to 3 matches from OTHER projects, each labelled with its `project`: treat them as context from elsewhere, say where they came from, and never present them as facts about this repo.",
  ```

- Replace `memory_status`'s description and handler

  ```js
    "Report memory backend connection info (local Docker vs remote) and entity/observation counts for the current project.",
    {},
    async () => {
      const { uri, database, mode } = loadConnectionConfig();
      const counts = await graph.getStatus({ project });
      return { uri, database, mode, project, ...counts };
    }
  ```

  with

  ```js
    "Report where memory is stored (the SQLite file) and entity/observation counts for the current project.",
    {},
    async () => {
      const { path } = storeStatus();
      const counts = await graph.getStatus({ project });
      return { engine: "sqlite", path, project, ...counts };
    }
  ```

- Replace

  ```js
  await ensureSchema().catch(() => {
    // Connectivity/config problems surface per-tool-call instead of killing the server at startup.
  });
  ```

  with

  ```js
  try {
    getDb();
  } catch {
    // Store problems surface per tool call instead of killing the server at startup.
  }
  ```

- In `shutdown`, replace `await closeDriver();` with `closeDb();`.

**`src/hooks/session-start.js`**

- Delete the line `import { ensureSchema } from "../lib/schema.js";`.
- Replace the two lines `import { closeDriver, verifyConnectivity } from "../lib/neo4jClient.js";` and `import { isConfigured } from "../lib/config.js";` with `import { storeStatus, closeDb } from "../lib/memoryStore.js";`.
- Delete the `SETUP_HINT` constant and the blank line after it.
- Replace the `if (!isConfigured()) { … return; }` block with:

  ```js
    const status = storeStatus();
    if (!status.ready) {
      process.stdout.write(JSON.stringify({ systemMessage: `\u{1f9e0} Memory: unavailable (${status.reason}).` }));
      return;
    }
  ```

- Delete `await verifyConnectivity();`, `await ensureSchema();` and the blank line after them.
- Change `` `\u{1f9e0} Neo4j memory: ${observationCount} observation(s) across ${tagCount} ` + `` to `` `\u{1f9e0} Memory: ${observationCount} observation(s) across ${tagCount} ` + ``.
- Change `` systemMessage = `\u{1f9e0} Neo4j memory: connected, nothing remembered yet for ${project}.`; `` to `` systemMessage = `\u{1f9e0} Memory: nothing remembered yet for ${project}.`; ``.
- In the `catch` block, replace the two-line `systemMessage:` value (the "configured but unreachable" text and its `setup-local.sh` advice) with `` systemMessage: `\u{1f9e0} Memory: session start failed (${shortError}).`, ``.
- In the `finally` block, replace `await closeDriver();` with `closeDb();`.

**`src/hooks/capture.js`**

- Delete the line `import { ensureSchema } from "../lib/schema.js";`.
- Replace `import { closeDriver, verifyConnectivity } from "../lib/neo4jClient.js";` with `import { storeStatus, closeDb } from "../lib/memoryStore.js";`.
- Replace `import { isConfigured, CONFIG_DIR, STATE_DIR, ensureStateDir } from "../lib/config.js";` with `import { CONFIG_DIR, STATE_DIR, ensureStateDir } from "../lib/config.js";`.
- In the comment above `runCapture`, change `write them to Neo4j` to `write them to the memory store`.
- In `runCapture`, replace `await verifyConnectivity();` with:

  ```js
    const status = storeStatus();
    if (!status.ready) {
      throw new Error(`memory unavailable: ${status.reason}`);
    }
  ```

- Delete `await ensureSchema();` and the blank line after it.
- Replace both `await closeDriver();` (the worker's `finally` and `main`'s `finally`) with `closeDb();`.
- Change `if (!isConfigured() || process.env.CLAUDE_NEO4J_DISABLE_CAPTURE || !sessionId || !transcriptPath) {` to `if (process.env.CLAUDE_NEO4J_DISABLE_CAPTURE || !sessionId || !transcriptPath) {`.

**`src/lib/injection.js`**

- Change ``const sections = [`## Memory (Neo4j · ${project})`];`` to ``const sections = [`## Memory (${project})`];``.

**`scripts/memory-cli.mjs`**

- Change the header comment's first line to `// Terminal access to the memory store, outside of a Claude Code session.`.
- Delete the line `import { ensureSchema } from "../src/lib/schema.js";`.
- Replace `import { closeDriver } from "../src/lib/neo4jClient.js";` with `import { getDb, closeDb, storeStatus } from "../src/lib/memoryStore.js";`.
- Replace `import { loadConnectionConfig, shouldNotifyOnWrite, setNotifyOnWrite } from "../src/lib/config.js";` with `import { shouldNotifyOnWrite, setNotifyOnWrite } from "../src/lib/config.js";`.
- In the usage text, change `connection info + entity/observation counts` to `where memory is stored + entity/observation counts`.
- Replace `await ensureSchema();` with `getDb();`.
- Replace the `status` case's three statement lines with:

  ```js
        const counts = await graph.getStatus({ project });
        console.log(JSON.stringify({ engine: "sqlite", path: storeStatus().path, project, ...counts }, null, 2));
  ```

- Replace `.finally(() => closeDriver());` with `.finally(() => closeDb());`.

**`scripts/statusline.mjs`**

- Replace the header comment's four lines with:

  ```js
  // Claude Code statusLine command: prints one line to stdout showing the model
  // and, when the memory store can be opened, entity/observation counts for the
  // current project. Must be fast and must never block the UI, so the lookup is
  // capped with a hard timeout and failures are swallowed.
  ```

- Replace the three imports of `isConfigured`, `getStatus` and `closeDriver` with:

  ```js
  import { getStatus } from "../src/lib/graph.js";
  import { storeStatus, closeDb } from "../src/lib/memoryStore.js";
  ```

- Replace `if (isConfigured()) {` with `if (storeStatus().ready) {`, and `await closeDriver().catch(() => {});` with `closeDb();`.

**`scripts/token-cost.mjs`**

- Replace the imports of `closeDriver` (`neo4jClient.js`) and `ensureSchema` (`schema.js`) with `import { getDb, closeDb } from "../src/lib/memoryStore.js";`.
- Replace `await ensureSchema();` with `getDb();`, and `.finally(() => closeDriver());` with `.finally(() => closeDb());`.

- [ ] **Step 4: Run every suite, then try the scripts nothing tests**

```bash
for f in src/mcp/server.js src/hooks/session-start.js src/hooks/capture.js scripts/memory-cli.mjs scripts/statusline.mjs scripts/token-cost.mjs; do node --check "$f"; done
grep -rln 'neo4jClient\|schema.js' memory/src memory/scripts | sort
HOME="$(mktemp -d)" node --test tests/*.test.js 2>&1 | grep -E '^# (tests|pass|fail|skipped) |^not ok'
```

Expected:

- `node --check` prints nothing.
- `grep` lists only:
  - `scripts/backfill-subsystems.mjs`, `scripts/check-health.sh`, `scripts/migrate-from-claude-mem.mjs` and `scripts/migrate-to-sqlite.mjs`, which Part B ports or keeps;
  - `src/lib/schema.js` itself.
- `# tests 283`, `# pass 278`, `# fail 0`, `# skipped 5` (the rehearsal tests).

```bash
export HOME="$(mktemp -d)" CLAUDE_NEO4J_SQLITE="$(mktemp -d)/memory.sqlite"
node --no-warnings scripts/memory-cli.mjs add "decision:smoke" "the smoke test wrote this" --project smoke
node --no-warnings scripts/memory-cli.mjs status --project smoke
echo '{"model":{"display_name":"Opus"},"cwd":"/tmp"}' | node --no-warnings scripts/statusline.mjs; echo
node --no-warnings scripts/token-cost.mjs --project smoke | tail -2
unset CLAUDE_NEO4J_SQLITE
```

Expected:

- `add` prints `Added 1 observation(s) to "decision:smoke": <uuid>`.
- `status` prints JSON with `"engine": "sqlite"`, the temporary path, `"entityCount": 1` and `"observationCount": 1`.
- `statusline` prints `Opus · 🧠 0e/0o`.
- `token-cost` ends with `All read paths within their per-call ceilings.`

- [ ] **Step 5: Commit**

```bash
git add -A memory/src memory/scripts memory/tests
git commit -m "feat(memory)!: Run the memory engine on SQLite" -m "graph.js now stores and searches memory in SQLite; the Neo4j engine is gone.
The four graph test files run unchanged against temporary stores, and every
caller uses the store's lifecycle instead of Neo4j's.

BREAKING CHANGE: memory reads and writes go to ~/.claude-neo4j/memory.sqlite;
Part B adds the first-start migration that fills it from Neo4j.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `memory -- dupes`

**Files:**
- Create: `src/lib/dupesReport.js`
- Modify: `scripts/memory-cli.mjs`
- Test: `tests/dupes-report.test.js`

**Interfaces:**
- Consumes: `findRepeatedFacts` (Task 7, now in `graph.js`).
- Produces:
  - `formatDupes(pairs): string`
  - CLI `npm run memory -- dupes [--min N]`, scoped by the CLI's `--project` flag like every command. `--min` defaults to 0.3.

- [ ] **Step 1: Write the failing tests**

`tests/dupes-report.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDupes } from "../src/lib/dupesReport.js";

const fact = (id, text, createdAt) => ({ entity: "preference:style", project: "p", id, createdAt, text });

test("each pair shows its similarity, both facts, and the id to delete", () => {
  const out = formatDupes([
    { similarity: 0.65, newer: fact("n1", "In troglodyte/skills, branch-protection blocks the push", "2026-10-07T10:00:00.000Z"), older: fact("o1", "branch-protection.sh blocks the release commit", "2026-09-01T10:00:00.000Z") },
  ]);
  assert.match(out, /0\.65/);
  assert.match(out, /newer n1 \(2026-10-07\)/);
  assert.match(out, /older o1 \(2026-09-01\)/);
  assert.match(out, /forget-obs/);
});

test("no pairs says so", () => {
  assert.equal(formatDupes([]), "No likely repeats among this project's standing facts.");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/dupes-report.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/dupesReport.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/dupesReport.js`:

```js
const day = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "?");

/** findRepeatedFacts' pairs as text for a person deciding what to merge or delete. */
export function formatDupes(pairs) {
  if (pairs.length === 0) {
    return "No likely repeats among this project's standing facts.";
  }
  const blocks = pairs.map((pair) =>
    [
      `${pair.similarity.toFixed(2)}  ${pair.newer.entity}`,
      `  newer ${pair.newer.id} (${day(pair.newer.createdAt)}): ${pair.newer.text}`,
      `  older ${pair.older.id} (${day(pair.older.createdAt)}): ${pair.older.text}`,
    ].join("\n")
  );
  return (
    `${pairs.length} likely repeat(s), most similar first. Delete the one you don't want with ` +
    "`npm run memory -- forget-obs <entity> <id>` (memory_delete_observations in a session), or merge them by hand.\n\n" +
    blocks.join("\n\n")
  );
}
```

In `scripts/memory-cli.mjs`:

- Below `import * as graph from "../src/lib/graph.js";`, add `import { formatDupes } from "../src/lib/dupesReport.js";`.
- In the usage text, after the line `keeping the most recent N per entity (default 3) regardless of age`, add:

```text
  dupes [--min N]                     list likely repeated standing facts (default min 0.3) to merge or delete
```

- In the `parseFlags(rest, { … })` call, after `"dry-run": "boolean",`, add `min: true,`.
- Before `case "mute": {`, add:

```js
    case "dupes": {
      const pairs = await graph.findRepeatedFacts({ project, min: flags.min ? Number(flags.min) : undefined });
      console.log(formatDupes(pairs));
      break;
    }
```

- [ ] **Step 4: Run the tests, then try the command on a temporary store**

```bash
HOME="$(mktemp -d)" node --test tests/dupes-report.test.js
export HOME="$(mktemp -d)" CLAUDE_NEO4J_SQLITE="$(mktemp -d)/memory.sqlite"
node --no-warnings scripts/memory-cli.mjs add "preference:style" "prefers pnpm over npm for every repo" --type preference
node --no-warnings scripts/memory-cli.mjs add "preference:style" "prefers pnpm over npm in every repo" --type preference
node --no-warnings scripts/memory-cli.mjs dupes
node --no-warnings scripts/memory-cli.mjs dupes --min 0.9
unset CLAUDE_NEO4J_SQLITE
```

Expected:

- The tests pass, 2 tests.
- The first `dupes` prints `1 likely repeat(s)` and one pair at `0.86`: 6 shared words of 7, since "for" counts and "in" is too short.
- `dupes --min 0.9` prints `No likely repeats among this project's standing facts.`

- [ ] **Step 5: Commit**

```bash
git add src/lib/dupesReport.js scripts/memory-cli.mjs tests/dupes-report.test.js
git commit -m "feat(memory): Add memory dupes to review repeated standing facts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Search parity, and the acceptance run

**Files:**
- Create: `src/lib/searchParity.js`
- Create: `scripts/search-parity.mjs`
- Modify: `package.json` (add `"search-parity"` after `"search-review"`)
- Test: `tests/search-parity.test.js`

**Interfaces:**
- Consumes:
  - `readGraph` (`migrate/readNeo4j.js`), `runMigration` (`migrate/runMigration.js`)
  - `searchMemory` (`graph.js`), `closeDb` (`memoryStore.js`)
  - `WEAK_SCORE` (`relevance.js`)
- Produces:
  - `parityReport(pairs)`: `{ queries, answered, top1, overlapAt5, emptyMismatches, relevance, relevanceDisagreements }`
  - `PARITY_GATES = { top1: 0.95, relevance: 0.95 }`
  - `passesGates(report): boolean`
  - `npm run search-parity [-- --keep]`: exits 0 when the gates pass, 1 when not.

- [ ] **Step 1: Write the failing tests**

`tests/search-parity.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parityReport, passesGates } from "../src/lib/searchParity.js";

const pair = (query, before, after, beforeLabel = "strong", afterLabel = "strong") => ({
  query,
  project: "p",
  before: { names: before, relevance: before.length ? beforeLabel : "none" },
  after: { names: after, relevance: after.length ? afterLabel : "none" },
});

test("measures top-1 and top-5 agreement over queries either engine answered", () => {
  const report = parityReport([
    pair("a", ["x", "y", "z"], ["x", "z", "q"]),
    pair("b", ["m"], ["n"]),
    pair("c", [], []),
  ]);
  assert.equal(report.queries, 3);
  assert.equal(report.answered, 2);
  assert.equal(report.top1, 0.5);
  // a: 2 of 3 shared; b: 0 of 1. Mean 0.333.
  assert.equal(Number(report.overlapAt5.toFixed(3)), 0.333);
});

test("names every query only one engine found nothing for", () => {
  const report = parityReport([pair("only-before", ["x"], []), pair("both", ["x"], ["x"])]);
  assert.deepEqual(report.emptyMismatches, ["only-before"]);
});

test("measures and lists relevance-label disagreements", () => {
  const report = parityReport([pair("a", ["x"], ["x"], "strong", "weak"), pair("b", ["x"], ["x"])]);
  assert.equal(report.relevance, 0.5);
  assert.deepEqual(report.relevanceDisagreements, [{ query: "a", before: "strong", after: "weak" }]);
});

test("the gates need 95% top-1, 95% labels, and the same empty queries", () => {
  const ok = { top1: 0.95, relevance: 0.95, emptyMismatches: [] };
  assert.equal(passesGates(ok), true);
  assert.equal(passesGates({ ...ok, top1: 0.94 }), false);
  assert.equal(passesGates({ ...ok, relevance: 0.94 }), false);
  assert.equal(passesGates({ ...ok, emptyMismatches: ["q"] }), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `HOME="$(mktemp -d)" node --test tests/search-parity.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/searchParity.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/searchParity.js`:

```js
// Agreement between two search engines over the same queries and data. Each
// pair is { query, project, before: { names, relevance }, after: { names, relevance } },
// names best first. Acceptance: engine spec, "Search".
export const PARITY_GATES = { top1: 0.95, relevance: 0.95 };

const overlapAt5 = (pair) => {
  const before = new Set(pair.before.names.slice(0, 5));
  const shared = pair.after.names.slice(0, 5).filter((name) => before.has(name)).length;
  return shared / Math.min(5, Math.max(pair.before.names.length, pair.after.names.length));
};

export function parityReport(pairs) {
  const answered = pairs.filter((p) => p.before.names.length > 0 || p.after.names.length > 0);
  const disagreements = pairs.filter((p) => p.before.relevance !== p.after.relevance);
  const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 1);
  return {
    queries: pairs.length,
    answered: answered.length,
    top1: mean(answered.map((p) => (p.before.names[0] === p.after.names[0] ? 1 : 0))),
    overlapAt5: mean(answered.map(overlapAt5)),
    emptyMismatches: pairs.filter((p) => (p.before.names.length === 0) !== (p.after.names.length === 0)).map((p) => p.query),
    relevance: pairs.length ? (pairs.length - disagreements.length) / pairs.length : 1,
    relevanceDisagreements: disagreements.map((p) => ({ query: p.query, before: p.before.relevance, after: p.after.relevance })),
  };
}

export function passesGates(report) {
  return report.top1 >= PARITY_GATES.top1 && report.relevance >= PARITY_GATES.relevance && report.emptyMismatches.length === 0;
}
```

`scripts/search-parity.mjs`:

```js
#!/usr/bin/env node
// Replays the logged memory_search queries through the Lucene-era Neo4j search
// and the SQLite engine, over the same data, and checks they agree.
// Neo4j is only read. The SQLite side is a fresh migration of it into a
// scratch directory, deleted afterwards unless --keep.
//   node scripts/search-parity.mjs [--keep]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import neo4j from "neo4j-driver";
import { CONFIG_DIR, loadConnectionConfig } from "../src/lib/config.js";
import { getDriver, closeDriver } from "../src/lib/neo4jClient.js";
import { readGraph } from "../src/lib/migrate/readNeo4j.js";
import { runMigration } from "../src/lib/migrate/runMigration.js";
import { closeDb } from "../src/lib/memoryStore.js";
import { searchMemory } from "../src/lib/graph.js";
import { WEAK_SCORE } from "../src/lib/relevance.js";
import { parityReport, passesGates, PARITY_GATES } from "../src/lib/searchParity.js";

// The Neo4j engine's ranking (graph.js before the SQLite switch), kept as the
// reference until Neo4j is retired.
const LUCENE_SPECIAL = /([+\-!(){}[\]^"~*?:\\/&|])/g;
const NEO4J_SEARCH = `
  CALL {
    CALL db.index.fulltext.queryNodes('entityNameFulltext', $query) YIELD node, score
    RETURN node AS entity, score
    UNION
    CALL db.index.fulltext.queryNodes('observationTextFulltext', $query) YIELD node, score
    MATCH (node)-[:ABOUT]->(entity)
    RETURN entity, score
  }
  WITH entity, max(score) AS score
  WHERE $project IS NULL OR entity.project = $project OR entity.project IS NULL
  OPTIONAL MATCH (recent:Observation)-[:ABOUT]->(entity)
  WITH entity, score, max(recent.createdAt) AS lastSeen
  WITH entity, CASE WHEN lastSeen IS NULL THEN score
                    ELSE score * (1.0 / (1.0 + duration.inDays(lastSeen, datetime()).days / 30.0)) END AS rankScore
  ORDER BY rankScore DESC
  LIMIT 10
  RETURN entity.name AS name, rankScore AS score`;

function loggedQueries() {
  const seen = new Map();
  const file = path.join(CONFIG_DIR, "telemetry.jsonl");
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.tool === "memory_search" && typeof entry.query === "string") {
      seen.set(`${entry.project}\u0000${entry.query}`, { query: entry.query, project: entry.project ?? null });
    }
  }
  return [...seen.values()];
}

async function neo4jSearch(session, { query, project }) {
  const result = await session.executeRead((tx) =>
    tx.run(NEO4J_SEARCH, { query: query.replace(LUCENE_SPECIAL, "\\$1"), project })
  );
  const rows = result.records.map((r) => ({ name: r.get("name"), score: r.get("score") }));
  const relevance = rows.length === 0 ? "none" : Math.max(...rows.map((r) => r.score)) < WEAK_SCORE ? "weak" : "strong";
  return { names: rows.map((r) => r.name), relevance };
}

async function main() {
  const keep = process.argv.includes("--keep");
  const config = loadConnectionConfig();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "search-parity-"));
  const store = path.join(scratch, "memory.sqlite");
  try {
    const readOnce = async () => {
      const session = getDriver().session({ database: config.database, defaultAccessMode: neo4j.session.READ });
      try {
        return await readGraph(session);
      } finally {
        await session.close();
      }
    };
    const migrated = await runMigration({
      readOnce,
      out: store,
      reportPath: path.join(scratch, "migration-report.json"),
      sourceLabel: "neo4j (search parity)",
      log: () => {},
    });
    if (migrated.exitCode !== 0) {
      console.error(`The scratch migration failed (exit ${migrated.exitCode}); see ${scratch}.`);
      return 2;
    }
    process.env.CLAUDE_NEO4J_SQLITE = store;
    const session = getDriver().session({ database: config.database, defaultAccessMode: neo4j.session.READ });
    const pairs = [];
    try {
      for (const q of loggedQueries()) {
        const before = await neo4jSearch(session, q);
        const found = await searchMemory(q.query, 10, q.project);
        pairs.push({ ...q, before, after: { names: found.results.map((r) => r.name), relevance: found.relevance } });
      }
    } finally {
      await session.close();
    }
    const report = parityReport(pairs);
    console.log(JSON.stringify({ ...report, gates: PARITY_GATES }, null, 2));
    console.log(passesGates(report) ? "PASS" : "FAIL");
    return passesGates(report) ? 0 : 1;
  } finally {
    closeDb();
    await closeDriver();
    if (!keep) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
  }
);
```

In `package.json`, after the `"search-review"` line, add:

```json
    "search-parity": "node scripts/search-parity.mjs",
```

- [ ] **Step 4: Run the tests, then the acceptance run against the live graph (read-only)**

```bash
HOME="$(mktemp -d)" node --test tests/search-parity.test.js
npm run --silent search-parity > /tmp/search-parity.txt 2>&1; echo "exit $?"; tail -40 /tmp/search-parity.txt
```

The acceptance run is the one command in this plan that reaches the live Neo4j. It runs with your real `HOME` so it can find the config, opens only read sessions, and writes only to a scratch directory it deletes.

Expected:

- The tests pass, 4 tests.
- The acceptance run exits 0 and prints `PASS`, with:
  - `top1` at least 0.95. This plan's code replayed the 214 searches logged by 2026-10-08 against that day's snapshot at 0.98.
  - `relevance` at least 0.95 (0.972 in the same replay).
  - `emptyMismatches` `[]`.

  The live graph and the telemetry log have grown since, so expect slightly different numbers.

If it prints `FAIL`, stop. Record the report in the ledger and report to your human partner rather than tuning thresholds by hand; the gates are the spec's acceptance. Delete the output afterwards, since it quotes queries: `rm /tmp/search-parity.txt`.

- [ ] **Step 5: Run every suite, then commit**

```bash
HOME="$(mktemp -d)" node --test tests/*.test.js 2>&1 | grep -E '^# (tests|pass|fail|skipped) '
git add src/lib/searchParity.js scripts/search-parity.mjs package.json tests/search-parity.test.js
git commit -m "feat(memory): Add search parity between the Neo4j and SQLite engines" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `# tests 289`, `# pass 284`, `# fail 0`, `# skipped 5`. Put the parity report's numbers in the PR description.
