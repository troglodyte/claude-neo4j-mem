# SQLite Engine Part B (the cut-over) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SQLite engine (Part A, already on this branch) shippable: a launcher that finds a Node with `node:sqlite`, an automatic first-start move from Neo4j, a 7-day catch-up, SQLite backup/restore/health, docs and 0.7.0, then the rollout on this machine.

**Architecture:** Every memory process starts through `bin/memory-node`. `src/lib/firstStart.js` decides, without creating anything, whether the store is ready, new, pending, migrating or failed; `memoryStore.getDb()` refuses to create an empty store while memory should be moving, so tools and captures report "moving" instead. Session start detaches `scripts/first-start-migrate.mjs`, which migrates into `memory.sqlite.migrating` and renames it into place only on a passed check, and for 7 days after the switch detaches `scripts/catch-up.mjs`, an insert-only copy of what old sessions still wrote to Neo4j.

**Tech Stack:** Node 22.13+ (`node:sqlite`, `node:test`), bash 3.2-compatible shell, `neo4j-driver` (migration and catch-up only).

**Spec:** `docs/superpowers/specs/2026-10-09-sqlite-engine-design.md`, sections "Part B: the cut-over", "Failure handling" and "Testing → Part B". Tasks 1 and 6 adapt the other session's draft (`~/code/claude-neo4j-mem/.claude/worktrees/neo4j-sqlite-migration-1f8a1c/docs/superpowers/plans/2026-10-12-sqlite-cutover.md`, Tasks 1 and 3), whose launcher test already covers the bash 3.2 and stdin traps.

## Global Constraints

- Work in `~/code/claude-neo4j-mem/.claude/worktrees/sqlite-engine`, branch `feat/sqlite-engine` (base `948a47c`). Paths are relative to it.
- `node:sqlite` unflagged means Node 22.13+ in 22.x, 23.4+ in 23.x, any 24+. `engines.node` is `>=22.13`.
- `bin/memory-node` runs under macOS `/bin/bash` 3.2: no `mapfile`, no associative arrays, guard empty arrays under `set -u` with `${a[@]+"${a[@]}"}`, and never `exec` inside a loop fed by process substitution.
- Names stay: MCP server `neo4j-memory`, folder `~/.claude-neo4j`, env prefix `CLAUDE_NEO4J_`.
- Neo4j is only ever read. Nothing in this plan writes to or deletes from it.
- Tests: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" npm test`. `~/.claude/settings.json` sets that switch for every shell and it breaks the capture-hook tests. `engine-resolve.test.sh`'s pty case fails on macOS (it needs util-linux `script -qec`); that is not a regression.
- Commits: this repo's style, a plain imperative sentence with no conventional-commit prefix, the release commit suffixed `(0.7.0)`, ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The repo is public on GitHub. Nothing is pushed, and no live state changes, outside Task 8's gates.
- Read diffs with `git --no-pager diff --no-ext-diff --no-color` (difftastic is the default differ here).

## Review Focus

1. **Hook stdin reaches the script through the launcher.** Hooks read Claude Code's JSON on stdin; an `exec` inside a `while … done < <(…)` loop hands the child the candidate list instead. Task 1 test 6 pins this.
2. **Memory tools during the move must not create an empty store.** Without the gate, the first tool call would create `memory.sqlite`, and first start would then see a store and never migrate. Task 2's gate test pins it.
3. **Two sessions starting at once on a machine with no store.** Only one migration runs; the second worker finds the lock and leaves. Tasks 2 and 3 pin it.
4. **A row the new engine deleted must not come back.** That covers a pre-switch entity deleted in SQLite, and a post-switch row copied once and then deleted. Task 5 pins both.
5. **A store started fresh never catches up**, because it has no passed migration. Task 5 pins it.

---

### Task 1: Launcher and wiring

**Files:**
- Create: `bin/memory-node`, `tests/memory-node.test.sh`, `tests/manifests.test.js`
- Modify: `hooks/hooks.json`, `.mcp.json`, `package.json` (scripts, engines)

**Interfaces:**
- Produces: `bash bin/memory-node [--hook] <script> [args…]`. It execs `<node> --disable-warning=ExperimentalWarning <script> [args…]`, passing stdin, stdout and stderr through. If no Node qualifies: with `--hook` it prints `{"systemMessage":"🧠 Memory: off — …"}` and exits 0; without it, it prints `memory-node: …` on stderr and exits 1.

- [ ] **Step 1: Write the failing launcher test** at `tests/memory-node.test.sh`:

```bash
#!/usr/bin/env bash
# bin/memory-node picks the Node that runs every memory process. Each case builds
# fake `node` binaries that report a version and echo what they were asked to run,
# and runs the launcher under /bin/bash (3.2 on macOS) with HOME, NVM_DIR, FNM_DIR,
# VOLTA_HOME and HOMEBREW_PREFIX in a temp tree, so the real machine's Nodes stay out.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && cd .. && pwd -P)"
LAUNCHER="$REPO_ROOT/bin/memory-node"
REAL_NODE="$(command -v node)"

failures=0
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }
pass() { printf 'ok: %s\n' "$1"; }

# fake_node DIR VERSION: an executable DIR/node that answers --version and
# otherwise prints "ran VERSION <args>" followed by whatever arrives on stdin.
fake_node() {
  mkdir -p "$1"
  cat >"$1/node" <<EOF
#!/bin/bash
if [ "\$1" = "--version" ]; then echo "$2"; exit 0; fi
printf 'ran %s %s\n' "$2" "\$*"
cat
EOF
  chmod +x "$1/node"
}

# run_launcher TREE [launcher args...]: PATH holds only TREE/path plus the system dirs.
run_launcher() {
  local tree="$1"
  shift
  HOME="$tree/home" NVM_DIR="$tree/nvm" FNM_DIR="$tree/fnm" VOLTA_HOME="$tree/volta" HOMEBREW_PREFIX="$tree/brew" \
    PATH="$tree/path:/usr/bin:/bin" CLAUDE_NEO4J_NODE="${OVERRIDE:-}" \
    /bin/bash "$LAUNCHER" "$@" </dev/null
}

new_tree() {
  local t
  t="$(mktemp -d)"
  mkdir -p "$t/home" "$t/nvm" "$t/fnm" "$t/volta" "$t/brew" "$t/path"
  printf '%s' "$t"
}

# 1. node on PATH qualifies: it runs the script, with the warning flag first.
t="$(new_tree)"
fake_node "$t/path" v22.23.1
out="$(run_launcher "$t" script.js a b)"
[[ $out == "ran v22.23.1 --disable-warning=ExperimentalWarning script.js a b" ]] \
  && pass "PATH node that qualifies is used" || fail "PATH qualifies: $out"

# 2. PATH too old; nvm's newest qualifying version wins, sorted numerically.
t="$(new_tree)"
fake_node "$t/path" v20.15.1
fake_node "$t/nvm/versions/node/v9.11.2/bin" v9.11.2
fake_node "$t/nvm/versions/node/v22.13.0/bin" v22.13.0
fake_node "$t/nvm/versions/node/v24.1.0/bin" v24.1.0
out="$(run_launcher "$t" script.js)"
[[ $out == "ran v24.1.0 "* ]] && pass "newest nvm Node wins over an old PATH node" || fail "nvm: $out"

# 3. CLAUDE_NEO4J_NODE wins even when PATH qualifies.
t="$(new_tree)"
fake_node "$t/path" v22.23.1
fake_node "$t/override" v23.4.0
out="$(OVERRIDE="$t/override/node" run_launcher "$t" script.js)"
[[ $out == "ran v23.4.0 "* ]] && pass "CLAUDE_NEO4J_NODE override is used first" || fail "override: $out"

# 4. Nothing qualifies, server mode: exit 1, stderr names what it found.
t="$(new_tree)"
fake_node "$t/path" v22.12.0
err="$(run_launcher "$t" server.js 2>&1 >/dev/null)"
code=$?
[[ $code -eq 1 && $err == *"22.13+"* && $err == *"v22.12.0"* ]] \
  && pass "server mode fails visibly when no Node qualifies" || fail "server none: code=$code err=$err"

# 4b. No candidates at all (empty arrays under set -u on bash 3.2).
t="$(new_tree)"
err="$(run_launcher "$t" server.js 2>&1 >/dev/null)"
code=$?
[[ $code -eq 1 && $err == *"found: none"* ]] && pass "no candidates at all is reported" || fail "no candidates: code=$code err=$err"

# 5. Nothing qualifies, hook mode: exit 0 and a valid JSON systemMessage.
t="$(new_tree)"
fake_node "$t/path" v20.15.1
out="$(run_launcher "$t" --hook hook.js)"
code=$?
msg="$(printf '%s' "$out" | "$REAL_NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).systemMessage))' 2>/dev/null)"
[[ $code -eq 0 && $msg == *"Memory: off"* ]] && pass "hook mode exits 0 with a JSON systemMessage" || fail "hook none: code=$code out=$out"

# 6. stdin reaches the script (hooks read Claude Code's JSON from it).
t="$(new_tree)"
fake_node "$t/path" v22.23.1
out="$(HOME="$t/home" NVM_DIR="$t/nvm" FNM_DIR="$t/fnm" VOLTA_HOME="$t/volta" HOMEBREW_PREFIX="$t/brew" PATH="$t/path:/usr/bin:/bin" \
  /bin/bash "$LAUNCHER" --hook hook.js <<<'{"session_id":"s1"}')"
[[ $out == *'{"session_id":"s1"}'* && $out != *"--hook"* ]] \
  && pass "stdin passes through and --hook is not forwarded" || fail "stdin: $out"

# 7. Homebrew is tried when PATH and the version managers have nothing.
t="$(new_tree)"
fake_node "$t/brew/bin" v24.0.0
out="$(run_launcher "$t" script.js)"
[[ $out == "ran v24.0.0 "* ]] && pass "Homebrew Node is found" || fail "brew: $out"

# 8. Pre-release version strings still parse.
t="$(new_tree)"
fake_node "$t/path" v24.0.0-nightly20261001
out="$(run_launcher "$t" script.js)"
[[ $out == "ran v24.0.0-nightly20261001 "* ]] && pass "pre-release versions parse" || fail "nightly: $out"

# 9. volta's version folders carry no "v"; fnm's do.
t="$(new_tree)"
fake_node "$t/path" v20.15.1
fake_node "$t/volta/tools/image/node/24.2.0/bin" v24.2.0
fake_node "$t/fnm/node-versions/v22.14.0/installation/bin" v22.14.0
out="$(run_launcher "$t" script.js)"
[[ $out == "ran v22.14.0 "* ]] && pass "fnm comes before volta, and both are found" || fail "fnm/volta: $out"

if [[ $failures -gt 0 ]]; then
  printf '%d failure(s)\n' "$failures"
  exit 1
fi
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash tests/memory-node.test.sh`
Expected: every case FAILs (`/bin/bash: …/bin/memory-node: No such file or directory`), exit 1.

- [ ] **Step 3: Write the launcher** at `bin/memory-node`, then `chmod +x bin/memory-node`:

```bash
#!/usr/bin/env bash
# Runs a memory process (the MCP server or a hook) under the first Node that has
# node:sqlite unflagged: 22.13+ in 22.x, 23.4+ in 23.x, any 24+. Repos pin older
# Nodes through nvm, and Claude Code starts hooks and MCP servers with whatever
# `node` that shell resolved, so `node` on PATH alone is not enough.
#
#   bash bin/memory-node [--hook] <script> [args...]
#
# Tried in order: $CLAUDE_NEO4J_NODE, `node` on PATH, the newest under nvm, fnm
# and volta, then Homebrew ($HOMEBREW_PREFIX, else /opt/homebrew and /usr/local).
# With none: --hook prints a one-line systemMessage and exits 0 so the session
# carries on; without it (the MCP server) it exits 1, so Claude Code shows the
# server as failed instead of hanging.
#
# Must stay bash 3.2-compatible: macOS runs this with /bin/bash.
set -uo pipefail

hook=0
if [ "${1:-}" = "--hook" ]; then
  hook=1
  shift
fi

# True when the Node binary $1 reports a version with unflagged node:sqlite.
has_sqlite() {
  local v major rest minor
  v="$("$1" --version 2>/dev/null)" || return 1
  v="${v#v}"
  major="${v%%.*}"
  rest="${v#*.}"
  minor="${rest%%.*}"
  [[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || return 1
  ((major >= 24 || (major == 23 && minor >= 4) || (major == 22 && minor >= 13)))
}

# newest DIR TAIL: the Nodes at DIR/<version>TAIL, newest first. Versions are keyed
# numerically, because a plain sort puts v9 after v22. A leading "v" is optional.
newest() {
  local dir="$1" tail="$2" bin v a b c
  for bin in "$dir"/*"$tail"; do
    [ -x "$bin" ] || continue
    v="${bin#"$dir"/}"
    v="${v%%/*}"
    v="${v#v}"
    IFS=. read -r a b c <<<"$v"
    [[ ${a:-} =~ ^[0-9]+$ ]] || continue
    printf '%05d%05d%05d %s\n' "$a" "${b:-0}" "${c%%[!0-9]*}" "$bin"
  done | sort -r | cut -d' ' -f2-
}

candidates() {
  local p bin
  [ -n "${CLAUDE_NEO4J_NODE:-}" ] && printf '%s\n' "$CLAUDE_NEO4J_NODE"
  command -v node 2>/dev/null
  newest "${NVM_DIR:-$HOME/.nvm}/versions/node" "/bin/node"
  newest "${FNM_DIR:-$HOME/.local/share/fnm}/node-versions" "/installation/bin/node"
  newest "$HOME/Library/Application Support/fnm/node-versions" "/installation/bin/node"
  newest "${VOLTA_HOME:-$HOME/.volta}/tools/image/node" "/bin/node"
  for p in ${HOMEBREW_PREFIX:-/opt/homebrew /usr/local}; do
    for bin in "$p"/bin/node "$p"/opt/node@*/bin/node; do
      [ -x "$bin" ] && printf '%s\n' "$bin"
    done
  done
}

# Collected first: exec'ing inside a loop fed by process substitution would hand
# the child that pipe as stdin, and hooks read Claude Code's JSON from stdin.
list=()
while IFS= read -r line; do
  [ -n "$line" ] && list+=("$line")
done < <(candidates)

found=""
for candidate in ${list[@]+"${list[@]}"}; do
  if has_sqlite "$candidate"; then
    exec "$candidate" --disable-warning=ExperimentalWarning "$@"
  fi
  found="${found:+$found; }$("$candidate" --version 2>/dev/null || echo unknown) ($candidate)"
done

message="memory needs Node 22.13+, 23.4+ or 24+ for node:sqlite; found: ${found:-none}. Install one with nvm, or set CLAUDE_NEO4J_NODE."
if [ "$hook" = 1 ]; then
  printf '{"systemMessage":"%s"}\n' "🧠 Memory: off — $message"
  exit 0
fi
printf 'memory-node: %s\n' "$message" >&2
exit 1
```

`${HOMEBREW_PREFIX:-/opt/homebrew /usr/local}` is unquoted on purpose, so the default splits into two prefixes.

- [ ] **Step 4: Run the launcher test**

Run: `bash tests/memory-node.test.sh`
Expected: 10 `ok:` lines, exit 0.

- [ ] **Step 5: Write the failing manifest test** at `tests/manifests.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

// Every memory process starts through the launcher, invoked as `bash <launcher>`
// so a checkout or snapshot copy that lost the executable bit still runs.
test("every hook command starts its script through bash bin/memory-node --hook", () => {
  const { hooks } = read("hooks/hooks.json");
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.ok(commands.length >= 3);
  for (const command of commands) {
    assert.match(command, /^bash "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/memory-node" --hook "\$\{CLAUDE_PLUGIN_ROOT\}\/src\/hooks\/[a-z-]+\.js"$/);
  }
});

test("the MCP server starts through bash bin/memory-node", () => {
  const server = read(".mcp.json").mcpServers["neo4j-memory"];
  assert.equal(server.command, "bash");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/bin/memory-node", "${CLAUDE_PLUGIN_ROOT}/src/mcp/server.js"]);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test tests/manifests.test.js`
Expected: both FAIL (commands still start with `node`).

- [ ] **Step 7: Rewire the manifests.** In `hooks/hooks.json`, replace each `"command"` value and keep the `timeout` fields:
  - SessionStart: `"bash \"${CLAUDE_PLUGIN_ROOT}/bin/memory-node\" --hook \"${CLAUDE_PLUGIN_ROOT}/src/hooks/session-start.js\""`
  - PreCompact and SessionEnd: `"bash \"${CLAUDE_PLUGIN_ROOT}/bin/memory-node\" --hook \"${CLAUDE_PLUGIN_ROOT}/src/hooks/capture.js\""`

  Replace `.mcp.json` with:

```json
{
  "mcpServers": {
    "neo4j-memory": {
      "command": "bash",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bin/memory-node", "${CLAUDE_PLUGIN_ROOT}/src/mcp/server.js"]
    }
  }
}
```

- [ ] **Step 8: Route node:sqlite scripts through the launcher.** In `package.json` set `"engines": { "node": ">=22.13" }` and these `scripts` entries, leaving the others:

```json
"mcp-server": "bash bin/memory-node src/mcp/server.js",
"memory": "bash bin/memory-node scripts/memory-cli.mjs",
"migrate-to-sqlite": "bash bin/memory-node scripts/migrate-to-sqlite.mjs",
"search-parity": "bash bin/memory-node scripts/search-parity.mjs",
"token-cost": "bash bin/memory-node scripts/token-cost.mjs",
"test": "bash tests/launcher-path.test.sh && bash tests/memory-node.test.sh && bash tests/engine-resolve.test.sh && bash tests/image-name.test.sh && bash tests/boot-persistence.test.sh && node --test tests/*.test.js",
"test:ci": "bash tests/launcher-path.test.sh && bash tests/memory-node.test.sh && bash tests/engine-resolve.test.sh && bash tests/image-name.test.sh && bash tests/boot-persistence.test.sh && node --test tests/*.test.js"
```

  `test:ci` no longer leaves out `graph-*`: on this branch those tests use temporary stores.

- [ ] **Step 9: Run everything**

Run: `node --test tests/manifests.test.js && env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" npm test`
Expected: manifest tests PASS; JS tests 286 pass, 5 skipped, 0 fail; bash suites pass except the known macOS `engine-resolve` pty case.

Then confirm the server starts through the launcher:

Run: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | HOME="$(mktemp -d)" bash bin/memory-node src/mcp/server.js | head -c 300`
Expected: a JSON-RPC `result` naming the `neo4j-memory` server.

- [ ] **Step 10: Commit**

```bash
git add bin/memory-node tests/memory-node.test.sh tests/manifests.test.js hooks/hooks.json .mcp.json package.json
git commit -m "Start every memory process through a launcher that finds node:sqlite" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: First-start state, the lock, and the store gate

**Files:**
- Create: `src/lib/firstStart.js`, `tests/first-start.test.js`
- Modify: `src/lib/memoryStore.js` (`getDb`), `src/lib/config.js` (export `readConfigFile`, delete `isConfigured`), `scripts/memory-cli.mjs` (`start-fresh`)

**Interfaces:**
- Consumes: `memoryDbPath()`, `STATE_DIR` from `src/lib/config.js`; `openMemoryDb(file)` from `src/lib/sqliteDb.js`.
- Produces, from `src/lib/firstStart.js`:
  - `LOCK_STALE_MS = 1_800_000`; `MOVING_MESSAGE = "memory is moving to SQLite; try again in a minute"`
  - `hasNeo4jConfig({ env, config }) → boolean`
  - `lockHolder({ stateDir, now }) → { pid, startedAt } | null`; `acquireLock({ stateDir, pid, now }) → boolean`; `releaseLock({ stateDir, pid })`
  - `readRecord(stateDir) → object | null`; `writeRecord(record, stateDir)`; `stagedPath(dbPath) → string`
  - `storeState({ dbPath, stateDir, env, config, now }) → { state: "ready" | "new" | "migrating" | "failed" | "pending", record? }`
  - `offReason(status) → string | null`
  - `startFresh({ dbPath, stateDir, now }) → string`

- [ ] **Step 1: Write the failing tests** at `tests/first-start.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  storeState,
  offReason,
  acquireLock,
  releaseLock,
  lockHolder,
  writeRecord,
  startFresh,
  MOVING_MESSAGE,
  LOCK_STALE_MS,
} from "../src/lib/firstStart.js";
import { getDb, closeDb } from "../src/lib/memoryStore.js";

// A machine in a temp folder: its store path, state folder, environment and config.
function machine({ password = true, store = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-start-"));
  const dbPath = path.join(dir, "memory.sqlite");
  if (store) {
    fs.writeFileSync(dbPath, "");
  }
  return { dir, dbPath, stateDir: path.join(dir, "state"), env: {}, config: password ? { password: "secret" } : {} };
}

const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;

test("an existing store is ready", () => {
  assert.equal(storeState(machine({ store: true })).state, "ready");
});

test("no store and no Neo4j config is a new user", () => {
  assert.equal(storeState(machine({ password: false })).state, "new");
});

test("NEO4J_PASSWORD counts as a Neo4j config", () => {
  const m = machine({ password: false });
  assert.equal(storeState({ ...m, env: { NEO4J_PASSWORD: "x" } }).state, "pending");
});

test("no store with a Neo4j config is pending, and memory is off while it moves", () => {
  const m = machine();
  assert.equal(storeState(m).state, "pending");
  assert.equal(offReason(storeState(m)), MOVING_MESSAGE);
});

test("a held lock means migrating, and a second taker is refused", () => {
  const m = machine();
  assert.equal(acquireLock({ stateDir: m.stateDir }), true);
  assert.equal(storeState(m).state, "migrating");
  assert.equal(acquireLock({ stateDir: m.stateDir }), false);
  releaseLock({ stateDir: m.stateDir });
  assert.equal(storeState(m).state, "pending");
});

test("a lock whose process is gone, or older than 30 minutes, is stale and reclaimed", () => {
  const m = machine();
  fs.mkdirSync(m.stateDir, { recursive: true });
  const lock = path.join(m.stateDir, "migrate.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), startedAt: Date.now() }));
  assert.equal(lockHolder({ stateDir: m.stateDir }), null);
  assert.equal(acquireLock({ stateDir: m.stateDir }), true);
  releaseLock({ stateDir: m.stateDir });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - LOCK_STALE_MS - 1 }));
  assert.equal(lockHolder({ stateDir: m.stateDir }), null);
});

test("a failed last migration keeps memory off with its reason, log and retry command", () => {
  const m = machine();
  writeRecord({ result: "failed", reason: "observations: 2 missing", log: "/x/migrate.log" }, m.stateDir);
  const status = storeState(m);
  assert.equal(status.state, "failed");
  assert.match(offReason(status), /failed \(observations: 2 missing\).*\/x\/migrate\.log.*npm run migrate-to-sqlite/);
});

test("start-fresh creates an empty store once, leaving Neo4j alone", () => {
  const m = machine();
  assert.match(startFresh(m), /empty store/);
  assert.equal(storeState(m).state, "ready");
  assert.match(startFresh(m), /already/);
});

test("start-fresh refuses while a migration runs", () => {
  const m = machine();
  acquireLock({ stateDir: m.stateDir });
  assert.match(startFresh(m), /migration is running/);
  assert.equal(fs.existsSync(m.dbPath), false);
  releaseLock({ stateDir: m.stateDir });
});

test("the store gate will not create an empty store while memory should be moving", () => {
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-")), "memory.sqlite");
  process.env.CLAUDE_NEO4J_SQLITE = file;
  process.env.NEO4J_PASSWORD = "secret";
  try {
    assert.throws(() => getDb(), new RegExp(MOVING_MESSAGE));
    assert.equal(fs.existsSync(file), false);
  } finally {
    delete process.env.NEO4J_PASSWORD;
    closeDb();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/first-start.test.js`
Expected: FAIL with `Cannot find module …/src/lib/firstStart.js`.

- [ ] **Step 3: Export `readConfigFile` and delete `isConfigured`** in `src/lib/config.js`: change `function readConfigFile() {` to `export function readConfigFile() {`, and delete the whole `export function isConfigured() { … }` block (it has no callers left; the store can always be created).

- [ ] **Step 4: Write `src/lib/firstStart.js`:**

```js
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, memoryDbPath, readConfigFile } from "./config.js";
import { openMemoryDb } from "./sqliteDb.js";

// Where memory stands on this machine, decided without creating anything:
// opening the store would create an empty file, and an empty file would make
// first start think this machine had already moved off Neo4j.
// Spec: docs/superpowers/specs/2026-10-09-sqlite-engine-design.md, "First start".

export const LOCK_STALE_MS = 30 * 60 * 1000;
export const MOVING_MESSAGE = "memory is moving to SQLite; try again in a minute";

const lockPath = (stateDir) => path.join(stateDir, "migrate.lock");
const recordPath = (stateDir) => path.join(stateDir, "migrate.json");

/** The file the first-start worker builds and renames into place on a passed check. */
export const stagedPath = (dbPath = memoryDbPath()) => `${dbPath}.migrating`;

/** A machine has a Neo4j config when config.json holds a password or NEO4J_PASSWORD is set. */
export function hasNeo4jConfig({ env = process.env, config = readConfigFile() } = {}) {
  return Boolean(env.NEO4J_PASSWORD || config?.password);
}

// The liveness test claude-mem and process registries use: EPERM still means alive.
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The lock's holder, or null when it is free or stale (its pid gone, or older than 30 minutes). */
export function lockHolder({ stateDir = STATE_DIR, now = Date.now() } = {}) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath(stateDir), "utf8"));
  } catch {
    return null;
  }
  if (!Number.isInteger(lock?.pid) || !alive(lock.pid) || now - lock.startedAt > LOCK_STALE_MS) {
    return null;
  }
  return lock;
}

/** Takes the lock for `pid`; false when a live holder has it. A stale lock is reclaimed. */
export function acquireLock({ stateDir = STATE_DIR, pid = process.pid, now = Date.now() } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath(stateDir), JSON.stringify({ pid, startedAt: now }), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (lockHolder({ stateDir, now })) {
        return false;
      }
      fs.rmSync(lockPath(stateDir), { force: true });
    }
  }
  return false;
}

/** Releases the lock if `pid` holds it. */
export function releaseLock({ stateDir = STATE_DIR, pid = process.pid } = {}) {
  try {
    if (JSON.parse(fs.readFileSync(lockPath(stateDir), "utf8")).pid === pid) {
      fs.rmSync(lockPath(stateDir), { force: true });
    }
  } catch {
    // already gone
  }
}

/** The last migration's outcome as the first-start worker recorded it. */
export function readRecord(stateDir = STATE_DIR) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(stateDir), "utf8"));
  } catch {
    return null;
  }
}

export function writeRecord(record, stateDir = STATE_DIR) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordPath(stateDir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * ready      memory.sqlite exists
 * migrating  a migration holds the lock
 * new        no store and no Neo4j config: an empty store may be created
 * failed     no store, and the last migration failed
 * pending    no store, a Neo4j config, nothing running: a migration should start
 */
export function storeState({ dbPath = memoryDbPath(), stateDir = STATE_DIR, env = process.env, config, now = Date.now() } = {}) {
  if (fs.existsSync(dbPath)) {
    return { state: "ready" };
  }
  if (lockHolder({ stateDir, now })) {
    return { state: "migrating" };
  }
  if (!hasNeo4jConfig({ env, config: config === undefined ? readConfigFile() : config })) {
    return { state: "new" };
  }
  const record = readRecord(stateDir);
  if (record?.result === "failed") {
    return { state: "failed", record };
  }
  return { state: "pending" };
}

/** Why memory is off, for tools and captures; null when the store may be opened. */
export function offReason(status) {
  if (status.state === "migrating" || status.state === "pending") {
    return MOVING_MESSAGE;
  }
  if (status.state === "failed") {
    return `the move to SQLite failed (${status.record.reason}); the log is ${status.record.log}. Retry with \`npm run migrate-to-sqlite\``;
  }
  return null;
}

/** Begins with an empty store, leaving Neo4j untouched (npm run memory -- start-fresh). */
export function startFresh({ dbPath = memoryDbPath(), stateDir = STATE_DIR, now = Date.now() } = {}) {
  if (fs.existsSync(dbPath)) {
    return `a store already exists at ${dbPath}; nothing changed`;
  }
  if (lockHolder({ stateDir, now })) {
    return "a migration is running; wait for it to finish";
  }
  openMemoryDb(dbPath).close();
  writeRecord({ result: "started-fresh", finishedAt: now }, stateDir);
  return `started an empty store at ${dbPath}; Neo4j is untouched`;
}
```

- [ ] **Step 5: Gate `getDb`.** In `src/lib/memoryStore.js`, add `import { storeState, offReason } from "./firstStart.js";` after the existing imports, and replace `getDb` with:

```js
export function getDb() {
  if (!open) {
    const file = memoryDbPath();
    // A tool call or capture during the move must not create an empty store:
    // first start would then see a store and never migrate.
    const reason = offReason(storeState({ dbPath: file }));
    if (reason) {
      throw new Error(reason);
    }
    open = { file, db: openMemoryDb(file) };
  }
  return open.db;
}
```

- [ ] **Step 6: Add `start-fresh` to the CLI.** In `scripts/memory-cli.mjs`, insert immediately before the line `  getDb();` in `main()`:

```js
  // Before getDb(): the gate refuses to create a store while memory should be moving.
  if (command === "start-fresh") {
    const { startFresh } = await import("../src/lib/firstStart.js");
    console.log(startFresh());
    return;
  }
```

  In `usage()`, after the `dupes` line, add:

```text
  start-fresh                         begin with an empty SQLite store; Neo4j is left untouched
```

- [ ] **Step 7: Run the tests**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/first-start.test.js && env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" npm test`
Expected: 10 PASS; the full suite as in Task 1 plus these 10.

- [ ] **Step 8: Commit**

```bash
git add src/lib/firstStart.js src/lib/memoryStore.js src/lib/config.js scripts/memory-cli.mjs tests/first-start.test.js
git commit -m "Decide first start without creating a store, and keep memory off while it moves" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The first-start worker

**Files:**
- Create: `src/lib/migrate/fromNeo4j.js`, `src/lib/firstStartWorker.js`, `scripts/first-start-migrate.mjs`, `tests/first-start-worker.test.js`
- Modify: `scripts/migrate-to-sqlite.mjs` (use `migrateFromNeo4j`)

**Interfaces:**
- Consumes: `acquireLock`, `releaseLock`, `writeRecord`, `stagedPath` (Task 2); `runMigration`, `EXIT` from `src/lib/migrate/runMigration.js`.
- Produces:
  - `withNeo4jReader(work: (readOnce, config) => Promise<T>) → Promise<T>`, throwing `Neo4jUnreachableError` when it cannot connect
  - `migrateFromNeo4j({ out, checkOnly, reportPath, log }) → Promise<{ exitCode }>`
  - `runFirstStartMigration({ dbPath, stateDir, migrate, now, log }) → Promise<exitCode>`

- [ ] **Step 1: Write the failing tests** at `tests/first-start-worker.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFirstStartMigration } from "../src/lib/firstStartWorker.js";
import { acquireLock, releaseLock, readRecord, lockHolder } from "../src/lib/firstStart.js";

function where() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-start-worker-"));
  return { dbPath: path.join(dir, "memory.sqlite"), stateDir: path.join(dir, "state"), log: () => {} };
}

// Stands in for the migration: writes the staged file, logs a last line, exits.
const migrateStub = (exitCode, lastLine) => async ({ out, log }) => {
  fs.writeFileSync(out, "built");
  log(lastLine);
  return { exitCode };
};

test("a passing migration is renamed into place and recorded", async () => {
  const w = where();
  assert.equal(await runFirstStartMigration({ ...w, migrate: migrateStub(0, "PASS   report: r.json") }), 0);
  assert.equal(fs.readFileSync(w.dbPath, "utf8"), "built");
  assert.equal(fs.existsSync(`${w.dbPath}.migrating`), false);
  assert.equal(readRecord(w.stateDir).result, "passed");
  assert.equal(lockHolder({ stateDir: w.stateDir }), null);
});

test("a failed check never becomes memory.sqlite; the staged file and the reason stay", async () => {
  const w = where();
  assert.equal(await runFirstStartMigration({ ...w, migrate: migrateStub(1, "FAIL   report: r.json") }), 1);
  assert.equal(fs.existsSync(w.dbPath), false);
  assert.equal(fs.readFileSync(`${w.dbPath}.migrating`, "utf8"), "built");
  const record = readRecord(w.stateDir);
  assert.equal(record.result, "failed");
  assert.equal(record.reason, "FAIL   report: r.json");
  assert.equal(lockHolder({ stateDir: w.stateDir }), null);
});

test("a migration that throws is recorded as failed", async () => {
  const w = where();
  const migrate = async () => {
    throw new Error("boom");
  };
  assert.equal(await runFirstStartMigration({ ...w, migrate }), 2);
  assert.equal(readRecord(w.stateDir).reason, "boom");
});

test("a worker that finds the lock held leaves the running migration alone", async () => {
  const w = where();
  acquireLock({ stateDir: w.stateDir });
  let ran = false;
  const migrate = async () => {
    ran = true;
    return { exitCode: 0 };
  };
  assert.equal(await runFirstStartMigration({ ...w, migrate }), 0);
  assert.equal(ran, false);
  releaseLock({ stateDir: w.stateDir });
});

test("a store that appeared meanwhile is left alone", async () => {
  const w = where();
  fs.writeFileSync(w.dbPath, "existing");
  let ran = false;
  const migrate = async () => {
    ran = true;
    return { exitCode: 0 };
  };
  assert.equal(await runFirstStartMigration({ ...w, migrate }), 0);
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(w.dbPath, "utf8"), "existing");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/first-start-worker.test.js`
Expected: FAIL with `Cannot find module …/src/lib/firstStartWorker.js`.

- [ ] **Step 3: Write `src/lib/migrate/fromNeo4j.js`** (the connection and run that `migrate-to-sqlite.mjs` did inline, shared with the worker and the catch-up):

```js
// Opens the configured Neo4j graph read-only and hands `work` a reader.
// Shared by migrate-to-sqlite, the first-start worker and the catch-up.

export class Neo4jUnreachableError extends Error {
  constructor(message) {
    super(`Cannot reach Neo4j: ${message}`);
    this.name = "Neo4jUnreachableError";
  }
}

export async function withNeo4jReader(work) {
  const { default: neo4j } = await import("neo4j-driver");
  const { loadConnectionConfig } = await import("../config.js");
  const { getDriver, verifyConnectivity, closeDriver } = await import("../neo4jClient.js");
  const { readGraph } = await import("./readNeo4j.js");
  try {
    let config;
    try {
      config = loadConnectionConfig();
      await verifyConnectivity();
    } catch (error) {
      throw new Neo4jUnreachableError(error.message);
    }
    const readOnce = async () => {
      const session = getDriver().session({ database: config.database, defaultAccessMode: neo4j.session.READ });
      try {
        return await readGraph(session);
      } finally {
        await session.close();
      }
    };
    return await work(readOnce, config);
  } finally {
    await closeDriver();
  }
}

/** The migration into `out`, as migrate-to-sqlite runs it. */
export async function migrateFromNeo4j({ out, checkOnly = false, reportPath, log = console.log }) {
  const { runMigration, EXIT } = await import("./runMigration.js");
  const { withoutCredentials } = await import("./cli.js");
  try {
    return await withNeo4jReader(async (readOnce, config) => {
      const source = withoutCredentials(config.uri);
      if (config.mode === "remote") {
        log(`Warning: the source is a remote graph (${source}); the SQLite file serves this machine only.`);
      }
      const { exitCode } = await runMigration({ readOnce, out, checkOnly, reportPath, sourceLabel: `${source} (${config.mode})`, log });
      return { exitCode };
    });
  } catch (error) {
    if (error instanceof Neo4jUnreachableError) {
      log(error.message);
      return { exitCode: EXIT.COULD_NOT_RUN };
    }
    throw error;
  }
}
```

- [ ] **Step 4: Use it in `scripts/migrate-to-sqlite.mjs`.** Replace everything from `  const { default: neo4j } = await import("neo4j-driver");` to the end of `main()` (the closing `}` before `main().then(`) with:

```js
  const { migrateFromNeo4j } = await import("../src/lib/migrate/fromNeo4j.js");
  const { exitCode } = await migrateFromNeo4j({ out: flags.out, checkOnly: flags.checkOnly, reportPath: flags.report });
  return exitCode;
}
```

  Also change its message `in Node 22.5 or later` to `in Node 22.13 or later`, and its import of `../src/lib/migrate/cli.js` to `import { parseArgs } from "../src/lib/migrate/cli.js";` (`withoutCredentials` moved into `fromNeo4j.js`).

- [ ] **Step 5: Write `src/lib/firstStartWorker.js`:**

```js
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, memoryDbPath } from "./config.js";
import { acquireLock, releaseLock, writeRecord, stagedPath } from "./firstStart.js";
import { migrateFromNeo4j } from "./migrate/fromNeo4j.js";

const lastLine = (lines) =>
  lines
    .flatMap((line) => line.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

/**
 * Moves this machine's Neo4j graph into SQLite: migrates into memory.sqlite.migrating
 * and renames it to memory.sqlite only when the check passes, so a failed check
 * never becomes the live store. Records the outcome where session start reads it.
 */
export async function runFirstStartMigration({ dbPath = memoryDbPath(), stateDir = STATE_DIR, migrate = migrateFromNeo4j, now = Date.now, log = console.log } = {}) {
  if (!acquireLock({ stateDir })) {
    log("first start: another migration holds the lock");
    return 0;
  }
  const staged = stagedPath(dbPath);
  const base = { staged, log: path.join(stateDir, "migrate.log"), report: path.join(stateDir, "migrate-report.json") };
  try {
    if (fs.existsSync(dbPath)) {
      log(`first start: ${dbPath} already exists`);
      return 0;
    }
    const lines = [];
    let exitCode;
    try {
      ({ exitCode } = await migrate({
        out: staged,
        reportPath: base.report,
        log: (line) => {
          lines.push(String(line));
          log(line);
        },
      }));
    } catch (error) {
      writeRecord({ ...base, result: "failed", exitCode: 2, reason: error.message, finishedAt: now() }, stateDir);
      log(`first start: failed: ${error.message}`);
      return 2;
    }
    // Closing the last connection checkpoints the WAL; one still on disk holds rows the rename would leave behind.
    if (exitCode === 0 && !fs.existsSync(`${staged}-wal`)) {
      fs.renameSync(staged, dbPath);
      writeRecord({ ...base, result: "passed", exitCode, finishedAt: now() }, stateDir);
      log(`first start: memory moved to ${dbPath}`);
      return 0;
    }
    const reason = exitCode === 0 ? `${staged}-wal survived; not moved into place` : (lastLine(lines) ?? `exit ${exitCode}`);
    writeRecord({ ...base, result: "failed", exitCode, reason, finishedAt: now() }, stateDir);
    log(`first start: failed: ${reason}`);
    return exitCode || 1;
  } finally {
    releaseLock({ stateDir });
  }
}
```

- [ ] **Step 6: Write `scripts/first-start-migrate.mjs`:**

```js
#!/usr/bin/env node
// Detached by session start on a machine with a Neo4j config and no store yet.
// Its output goes to ~/.claude-neo4j/state/migrate.log; its outcome to migrate.json.
import { runFirstStartMigration } from "../src/lib/firstStartWorker.js";

runFirstStartMigration().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`first start: ${error.message}`);
    process.exitCode = 2;
  }
);
```

- [ ] **Step 7: Run the tests**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/first-start-worker.test.js tests/migrate-cli.test.js tests/migrate-run.test.js`
Expected: 5 new PASS; the existing migrate suites still PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/migrate/fromNeo4j.js src/lib/firstStartWorker.js scripts/first-start-migrate.mjs scripts/migrate-to-sqlite.mjs tests/first-start-worker.test.js
git commit -m "Move the graph on first start into a staged file, renamed into place only on a passed check" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Session start during the move

**Files:**
- Modify: `src/lib/firstStart.js` (add `beginFirstStart`, `neo4jReachable`, `spawnMigrationWorker`), `src/hooks/session-start.js`
- Test: `tests/first-start.test.js`, `tests/session-start-hook.test.js`

**Interfaces:**
- Consumes: `storeState`, `offReason` (Task 2); `scripts/first-start-migrate.mjs` (Task 3).
- Produces: `beginFirstStart({ probe, spawnWorker, ...storeStateOptions }) → Promise<string | null>` (the session-start line, or null when the store can be used); `MOVING_LINE`; `UNREACHABLE_LINE`; `neo4jReachable({ env, config, timeoutMs }) → Promise<boolean>`; `spawnMigrationWorker({ stateDir, nodePath }) → pid`.

- [ ] **Step 1: Add failing unit tests** at the end of `tests/first-start.test.js`, and add `beginFirstStart, MOVING_LINE, UNREACHABLE_LINE` to its import from `../src/lib/firstStart.js`:

```js
const recorder = () => {
  const calls = [];
  return { calls, spawnWorker: () => calls.push("spawn") };
};

test("first start leaves a ready store or a new user alone", async () => {
  const spy = recorder();
  assert.equal(await beginFirstStart({ ...machine({ store: true }), spawnWorker: spy.spawnWorker, probe: async () => true }), null);
  assert.equal(await beginFirstStart({ ...machine({ password: false }), spawnWorker: spy.spawnWorker, probe: async () => true }), null);
  assert.deepEqual(spy.calls, []);
});

test("a pending machine with Neo4j reachable starts the worker and says memory is moving", async () => {
  const spy = recorder();
  assert.equal(await beginFirstStart({ ...machine(), spawnWorker: spy.spawnWorker, probe: async () => true }), MOVING_LINE);
  assert.deepEqual(spy.calls, ["spawn"]);
});

test("a pending machine with Neo4j down names both ways forward and starts nothing", async () => {
  const spy = recorder();
  const line = await beginFirstStart({ ...machine(), spawnWorker: spy.spawnWorker, probe: async () => false });
  assert.equal(line, UNREACHABLE_LINE);
  assert.match(line, /setup-local\.sh.*start-fresh/);
  assert.deepEqual(spy.calls, []);
});

test("a running migration or a failed one is reported without starting another", async () => {
  const spy = recorder();
  const running = machine();
  acquireLock({ stateDir: running.stateDir });
  assert.equal(await beginFirstStart({ ...running, spawnWorker: spy.spawnWorker, probe: async () => true }), MOVING_LINE);
  releaseLock({ stateDir: running.stateDir });
  const failed = machine();
  writeRecord({ result: "failed", reason: "boom", log: "/x/migrate.log" }, failed.stateDir);
  assert.match(await beginFirstStart({ ...failed, spawnWorker: spy.spawnWorker, probe: async () => true }), /failed \(boom\)/);
  assert.deepEqual(spy.calls, []);
});
```

  In `tests/session-start-hook.test.js`, give `runSessionStart` a second parameter that prepares the temp home: change `function runSessionStart(env = {}) {` to `function runSessionStart(env = {}, prepare = () => {}) {`, and after the `const home = …` line add `prepare(home);`. Then add at the end:

```js
test("a machine with a Neo4j config but Neo4j down keeps memory off and creates no store", async () => {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  let store;
  // NEO4J_URI is pinned too, so a URI in the developer's own environment cannot point the probe at a live graph.
  const out = await runSessionStart({ NEO4J_URI: `bolt://127.0.0.1:${port}` }, (home) => {
    store = path.join(home, "memory.sqlite");
    fs.mkdirSync(path.join(home, ".claude-neo4j"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude-neo4j", "config.json"), JSON.stringify({ password: "x", uri: `bolt://127.0.0.1:${port}` }));
  });
  assert.match(out.systemMessage, /Memory: off — Neo4j is not running/);
  assert.equal(fs.existsSync(store), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/first-start.test.js tests/session-start-hook.test.js`
Expected: the new unit tests FAIL (`beginFirstStart` is not exported); the hook test FAILs (the hook creates an empty store and says nothing is remembered).

- [ ] **Step 3: Add to `src/lib/firstStart.js`**: these imports at the top, beside the existing ones:

```js
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
```

  and at the end of the file:

```js
export const MOVING_LINE = "moving to SQLite; memory is off for about a minute.";
export const UNREACHABLE_LINE =
  "Neo4j is not running, so memory cannot move to SQLite yet. Start it once (scripts/setup-local.sh) so memory can move, " +
  "or run `npm run memory -- start-fresh` to begin empty with Neo4j left untouched.";

const WORKER = fileURLToPath(new URL("../../scripts/first-start-migrate.mjs", import.meta.url));

/** Whether the configured Neo4j accepts a TCP connection; a quick probe, not a login. */
export function neo4jReachable({ env = process.env, config = readConfigFile(), timeoutMs = 1500 } = {}) {
  let host;
  let port;
  try {
    const url = new URL(env.NEO4J_URI ?? config?.uri ?? "bolt://localhost:7687");
    host = url.hostname;
    port = Number(url.port) || 7687;
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Detaches the first-start worker; its output goes to state/migrate.log. */
export function spawnMigrationWorker({ stateDir = STATE_DIR, nodePath = process.execPath } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(stateDir, "migrate.log"), "a", 0o600);
  try {
    const child = spawn(nodePath, ["--disable-warning=ExperimentalWarning", WORKER], { detached: true, stdio: ["ignore", log, log] });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

/** Session start's first-start step: null when the store can be used, else the line to show. */
export async function beginFirstStart({ probe = neo4jReachable, spawnWorker = spawnMigrationWorker, ...where } = {}) {
  const status = storeState(where);
  if (status.state === "ready" || status.state === "new") {
    return null;
  }
  if (status.state === "migrating") {
    return MOVING_LINE;
  }
  if (status.state === "failed") {
    return offReason(status);
  }
  if (!(await probe())) {
    return UNREACHABLE_LINE;
  }
  spawnWorker();
  return MOVING_LINE;
}
```

- [ ] **Step 4: Call it from session start.** In `src/hooks/session-start.js`, add `import { beginFirstStart } from "../lib/firstStart.js";` after the `memoryStore.js` import, and insert immediately before `  const status = storeStatus();`:

```js
  const firstStart = await beginFirstStart();
  if (firstStart) {
    process.stdout.write(JSON.stringify({ systemMessage: `\u{1f9e0} Memory: off — ${firstStart}` }));
    return;
  }
```

- [ ] **Step 5: Run the tests**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/first-start.test.js tests/session-start-hook.test.js && env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" npm test`
Expected: all PASS; the full suite as before plus the 5 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/firstStart.js src/hooks/session-start.js tests/first-start.test.js tests/session-start-hook.test.js
git commit -m "Start the move to SQLite from session start, and say why memory is off meanwhile" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Catch-up after the switch

**Files:**
- Create: `src/lib/catchUp.js`, `scripts/catch-up.mjs`, `tests/catch-up.test.js`
- Modify: `src/hooks/session-start.js`

**Interfaces:**
- Consumes: `acquireLock`, `releaseLock` (Task 2); `withNeo4jReader`, `Neo4jUnreachableError` (Task 3); `readConsistentGraph`, `keyOf` from `src/lib/migrate/fingerprint.js`; `writeGraph` from `src/lib/migrate/writeSqlite.js` (it indexes new rows for search through `syncFullText`); `readSqliteGraph` from `src/lib/migrate/readSqlite.js`.
- Produces: `CATCH_UP_DAYS = 7`; `switchedAt(db) → ms | null`; `catchUpDue(db, { now }) → boolean`; `rowsToCopy(records, { since, switchAt, existing }) → GraphRecords`; `runCatchUp({ dbPath, stateDir, readOnce, now, log }) → Promise<{ copied?, watermark?, skipped?, failed? }>`; `spawnCatchUp({ stateDir, nodePath })`.

The spec gives the reader a `since` option. This plan filters the full consistent read instead (`rowsToCopy`), so no Cypher changes. A background worker reading about 12,000 rows twice costs seconds.

- [ ] **Step 1: Write the failing tests** at `tests/catch-up.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { runCatchUp, catchUpDue, CATCH_UP_DAYS } from "../src/lib/catchUp.js";

const DAY = 24 * 60 * 60 * 1000;
const SWITCH = Date.UTC(2026, 9, 12, 12);

// A store that moved to SQLite at SWITCH, holding one entity created before it.
function store({ passed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catch-up-"));
  const dbPath = path.join(dir, "memory.sqlite");
  const db = openMemoryDb(dbPath);
  if (passed) {
    db.prepare("INSERT INTO migrations (source, started_at, finished_at, counts, result) VALUES ('test', ?, ?, '{}', 'passed')").run(SWITCH - 1000, SWITCH);
  }
  db.prepare("INSERT INTO entities (name, project, type, created_at, updated_at) VALUES ('decision:old', 'p', 'decision', ?, NULL)").run(SWITCH - DAY);
  db.close();
  return { dbPath, stateDir: path.join(dir, "state"), log: () => {} };
}

const entity = (name, createdAt, type = "decision") => ({ name, project: "p", type, createdAt, updatedAt: null });
const observation = (id, entityName, createdAt) => ({
  id,
  entityName,
  entityProject: "p",
  text: `fact ${id}`,
  subsystem: null,
  source: null,
  sessionId: null,
  createdAt,
  seq: createdAt,
});
const graph = ({ entities = [entity("decision:old", SWITCH - DAY)], observations = [], relations = [], sessions = [] } = {}) => ({
  entities,
  observations,
  relations,
  sessions,
  sessionLinks: [],
  unmapped: [],
});
const reader = (records) => async () => structuredClone(records);
const ids = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT id FROM observations ORDER BY id").all().map((row) => row.id);
  } finally {
    db.close();
  }
};

test("rows created after the switch are copied, with the new entities they need, and older rows are not", async () => {
  const s = store();
  const records = graph({
    entities: [entity("decision:old", SWITCH - DAY), entity("decision:new", SWITCH + 500)],
    observations: [observation("before", "decision:old", SWITCH - 10), observation("after", "decision:old", SWITCH + 1000), observation("new", "decision:new", SWITCH + 2000)],
  });
  const result = await runCatchUp({ ...s, readOnce: reader(records), now: SWITCH + DAY });
  assert.deepEqual(ids(s.dbPath), ["after", "new"]);
  assert.equal(result.copied.observations, 2);
});

test("a pre-switch entity deleted in SQLite does not come back, and its new rows are dropped", async () => {
  const s = store();
  const db = new DatabaseSync(s.dbPath);
  db.exec("DELETE FROM entities WHERE name = 'decision:old'");
  db.close();
  await runCatchUp({ ...s, readOnce: reader(graph({ observations: [observation("after", "decision:old", SWITCH + 1000)] })), now: SWITCH + DAY });
  const check = new DatabaseSync(s.dbPath, { readOnly: true });
  assert.equal(check.prepare("SELECT count(*) AS n FROM entities WHERE name = 'decision:old'").get().n, 0);
  check.close();
  assert.deepEqual(ids(s.dbPath), []);
});

test("updates made in Neo4j are ignored", async () => {
  const s = store();
  const records = graph({ entities: [entity("decision:old", SWITCH - DAY, "constraint")], observations: [observation("after", "decision:old", SWITCH + 1000)] });
  await runCatchUp({ ...s, readOnce: reader(records), now: SWITCH + DAY });
  const db = new DatabaseSync(s.dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT type FROM entities WHERE name = 'decision:old'").get().type, "decision");
  db.close();
});

test("a copied row deleted in SQLite stays deleted on the next run", async () => {
  const s = store();
  const records = graph({ observations: [observation("after", "decision:old", SWITCH + 1000)] });
  await runCatchUp({ ...s, readOnce: reader(records), now: SWITCH + DAY });
  const db = new DatabaseSync(s.dbPath);
  db.exec("DELETE FROM observations WHERE id = 'after'");
  db.close();
  await runCatchUp({ ...s, readOnce: reader(records), now: SWITCH + 2 * DAY });
  assert.deepEqual(ids(s.dbPath), []);
});

test("nothing runs once the 7 days are over", async () => {
  const s = store();
  const result = await runCatchUp({ ...s, readOnce: reader(graph({ observations: [observation("after", "decision:old", SWITCH + 1000)] })), now: SWITCH + (CATCH_UP_DAYS + 1) * DAY });
  assert.equal(result.skipped, "outside the catch-up window");
  assert.deepEqual(ids(s.dbPath), []);
});

test("a store started fresh never catches up", () => {
  const s = store({ passed: false });
  const db = new DatabaseSync(s.dbPath, { readOnly: true });
  assert.equal(catchUpDue(db, { now: SWITCH + DAY }), false);
  db.close();
});

test("an unreachable Neo4j is skipped quietly", async () => {
  const s = store();
  const readOnce = async () => {
    throw new Error("connection refused");
  };
  assert.equal((await runCatchUp({ ...s, readOnce, now: SWITCH + DAY })).skipped, "neo4j unreachable");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/catch-up.test.js`
Expected: FAIL with `Cannot find module …/src/lib/catchUp.js`.

- [ ] **Step 3: Write `src/lib/catchUp.js`:**

```js
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_DIR, memoryDbPath } from "./config.js";
import { openMemoryDb } from "./sqliteDb.js";
import { acquireLock, releaseLock } from "./firstStart.js";
import { readConsistentGraph, keyOf } from "./migrate/fingerprint.js";
import { writeGraph } from "./migrate/writeSqlite.js";
import { readSqliteGraph } from "./migrate/readSqlite.js";

// Sessions open when the plugin switched keep writing to Neo4j until they end.
// For 7 days, session start copies what they wrote: insert-only, never touching
// anything created before the switch, so a row the new engine deleted cannot come back.
// Spec: docs/superpowers/specs/2026-10-09-sqlite-engine-design.md, "Catch-up after the switch".

export const CATCH_UP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const WORKER = fileURLToPath(new URL("../../scripts/catch-up.mjs", import.meta.url));
const statePath = (stateDir) => path.join(stateDir, "catch-up.json");

/** When this store switched to SQLite: the first passed migration's finished_at, or null. */
export function switchedAt(db) {
  return db.prepare("SELECT min(finished_at) AS at FROM migrations WHERE result = 'passed'").get()?.at ?? null;
}

export function catchUpDue(db, { now = Date.now() } = {}) {
  const at = switchedAt(db);
  return at !== null && now - at < CATCH_UP_DAYS * DAY_MS;
}

const entityKey = (name, project) => keyOf("entities", { name, project });

/**
 * The part of a Neo4j read to copy: rows created after `since`, plus the entities
 * they need. An entity created before the switch is only ever referenced: if
 * SQLite no longer has it, it was deleted there, and its new rows are dropped.
 */
export function rowsToCopy(records, { since, switchAt, existing }) {
  const byKey = new Map(records.entities.map((e) => [entityKey(e.name, e.project), e]));
  const usable = (name, project) => {
    const key = entityKey(name, project);
    return existing.has(key) || (byKey.get(key)?.createdAt ?? -Infinity) > switchAt;
  };
  const observations = records.observations.filter((o) => o.createdAt > since && usable(o.entityName, o.entityProject));
  const relations = records.relations.filter(
    (r) => (r.createdAt ?? -Infinity) > since && usable(r.fromName, r.fromProject) && usable(r.toName, r.toProject)
  );
  const sessions = records.sessions.filter((s) => s.startedAt > since);
  const needed = new Set([
    ...observations.map((o) => entityKey(o.entityName, o.entityProject)),
    ...relations.flatMap((r) => [entityKey(r.fromName, r.fromProject), entityKey(r.toName, r.toProject)]),
  ]);
  const copied = new Set(observations.map((o) => o.id));
  return {
    entities: [...needed].map((key) => byKey.get(key)).filter(Boolean),
    observations,
    relations,
    sessions,
    sessionLinks: (records.sessionLinks ?? []).filter((link) => copied.has(link.observationId)),
    unmapped: [],
  };
}

// The check, limited to the copied rows: each must now be in the store.
function missingAfterCopy(rows, target) {
  const missing = [];
  for (const type of ["entities", "observations", "relations", "sessions"]) {
    const have = new Set(target[type].map((record) => keyOf(type, record)));
    for (const record of rows[type]) {
      if (!have.has(keyOf(type, record))) {
        missing.push(`${type} ${keyOf(type, record)}`);
      }
    }
  }
  return missing;
}

function readState(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(stateDir), "utf8"));
  } catch {
    return null;
  }
}

function writeState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath(stateDir), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

/**
 * One catch-up run. Each run copies only rows newer than the last run's newest
 * copied row (the watermark), so a copied row deleted in SQLite later is not copied again.
 */
export async function runCatchUp({ dbPath = memoryDbPath(), stateDir = STATE_DIR, readOnce, now = Date.now(), log = console.log }) {
  if (!acquireLock({ stateDir })) {
    return { skipped: "locked" };
  }
  try {
    const db = openMemoryDb(dbPath);
    try {
      const switchAt = switchedAt(db);
      if (switchAt === null || now - switchAt >= CATCH_UP_DAYS * DAY_MS) {
        return { skipped: "outside the catch-up window" };
      }
      const since = Math.max(switchAt, readState(stateDir)?.watermark ?? switchAt);
      let read;
      try {
        read = await readConsistentGraph(readOnce);
      } catch (error) {
        log(`catch-up: skipped: ${error.message}`);
        return { skipped: "neo4j unreachable" };
      }
      if (!read.consistent) {
        log("catch-up: skipped: Neo4j kept changing between reads");
        return { skipped: "inconsistent" };
      }
      const existing = new Set(db.prepare("SELECT name, project FROM entities").all().map((e) => entityKey(e.name, e.project)));
      const rows = rowsToCopy(read.records, { since, switchAt, existing });
      const write = writeGraph(db, rows);
      const missing = missingAfterCopy(rows, readSqliteGraph(db));
      if (missing.length > 0) {
        log(`catch-up: check failed: ${missing.slice(0, 5).join("; ")}`);
        return { failed: missing };
      }
      const watermark = Math.max(
        since,
        ...rows.observations.map((o) => o.createdAt),
        ...rows.relations.map((r) => r.createdAt ?? since),
        ...rows.sessions.map((s) => s.startedAt)
      );
      writeState(stateDir, { watermark, lastRun: now, copied: write.inserted });
      log(`catch-up: copied ${JSON.stringify(write.inserted)} created after ${new Date(since).toISOString()}`);
      return { copied: write.inserted, watermark };
    } finally {
      db.close();
    }
  } finally {
    releaseLock({ stateDir });
  }
}

/** Detaches scripts/catch-up.mjs; its output goes to state/catch-up.log. */
export function spawnCatchUp({ stateDir = STATE_DIR, nodePath = process.execPath } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(stateDir, "catch-up.log"), "a", 0o600);
  try {
    const child = spawn(nodePath, ["--disable-warning=ExperimentalWarning", WORKER], { detached: true, stdio: ["ignore", log, log] });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}
```

- [ ] **Step 4: Write `scripts/catch-up.mjs`:**

```js
#!/usr/bin/env node
// Detached by session start for 7 days after the switch: copies what sessions
// still running the Neo4j engine wrote. Neo4j unreachable or unconfigured: skipped quietly.
import { withNeo4jReader, Neo4jUnreachableError } from "../src/lib/migrate/fromNeo4j.js";
import { runCatchUp } from "../src/lib/catchUp.js";

try {
  await withNeo4jReader((readOnce) => runCatchUp({ readOnce }));
} catch (error) {
  console.log(error instanceof Neo4jUnreachableError ? `catch-up: skipped: ${error.message}` : `catch-up: failed: ${error.message}`);
}
```

- [ ] **Step 5: Start it from session start.** In `src/hooks/session-start.js`, add `import { catchUpDue, spawnCatchUp } from "../lib/catchUp.js";`, change the `memoryStore.js` import to `import { storeStatus, closeDb, getDb } from "../lib/memoryStore.js";`, and insert immediately after `    pruneStaleState();`:

```js
    try {
      if (catchUpDue(getDb())) {
        spawnCatchUp();
      }
    } catch (error) {
      process.stderr.write(`claude-neo4j: catch-up not started: ${error.message}\n`);
    }
```

- [ ] **Step 6: Run the tests**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/catch-up.test.js && env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" npm test`
Expected: 7 PASS; the full suite as before plus these 7.

- [ ] **Step 7: Commit**

```bash
git add src/lib/catchUp.js scripts/catch-up.mjs src/hooks/session-start.js tests/catch-up.test.js
git commit -m "Copy what old sessions still write to Neo4j for 7 days after the switch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Backup, restore and health on SQLite

**Files:**
- Create: `src/lib/backup.js`, `src/lib/health.js`, `scripts/backup.mjs`, `scripts/restore.mjs`, `scripts/check-health.mjs`, `tests/backup.test.js`, `tests/health.test.js`
- Modify: `package.json` scripts; the header comment of `scripts/backup.sh`, `scripts/restore.sh`, `scripts/lib-backup.sh`, `scripts/check-health.sh` (legacy label only)

**Interfaces:**
- Consumes: `memoryDbPath()`, `CONFIG_DIR` from `src/lib/config.js`; `integrityReport(db)` and `openMemoryDb(file)` from `src/lib/sqliteDb.js`.
- Produces: `backupStore({ source, dir, keep, now }) → { file, pruned }`; `listBackups(dir) → string[]` (newest first); `restoreStore({ backup, target, force, holders, now }) → { target, movedAside }`; `openHolders(file) → string[]`; `healthChecks(file) → Array<{ name, ok, detail }>`.

- [ ] **Step 1: Write the failing backup test** at `tests/backup.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { backupStore, listBackups, restoreStore } from "../src/lib/backup.js";

function storeWithEntity(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  const file = path.join(dir, "memory.sqlite");
  const db = openMemoryDb(file);
  db.prepare("INSERT INTO entities (name, project, type, created_at, updated_at) VALUES (?, 'p', NULL, 1, 1)").run(name);
  db.close();
  return { dir, file };
}

const entityNames = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM entities ORDER BY name").all().map((r) => r.name);
  } finally {
    db.close();
  }
};

test("a backup is a private, complete copy named by its UTC time", () => {
  const { dir, file } = storeWithEntity("alpha");
  const { file: backup } = backupStore({ source: file, dir: path.join(dir, "backups"), now: new Date("2026-10-12T17:15:00.123Z") });
  assert.equal(path.basename(backup), "memory-20261012T171500Z.sqlite");
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.deepEqual(entityNames(backup), ["alpha"]);
});

test("--keep prunes the oldest memory backups and leaves other files alone", () => {
  const { dir, file } = storeWithEntity("alpha");
  const backups = path.join(dir, "backups");
  fs.mkdirSync(backups);
  fs.writeFileSync(path.join(backups, "neo4j-20260101T000000Z.dump"), "legacy");
  for (const hour of ["01", "02", "03"]) {
    backupStore({ source: file, dir: backups, keep: 2, now: new Date(`2026-10-12T${hour}:00:00Z`) });
  }
  assert.deepEqual(listBackups(backups).map((f) => path.basename(f)), ["memory-20261012T030000Z.sqlite", "memory-20261012T020000Z.sqlite"]);
  assert.ok(fs.existsSync(path.join(backups, "neo4j-20260101T000000Z.dump")));
});

test("restore moves the current store aside and puts the backup in its place", () => {
  const { dir, file: backupSource } = storeWithEntity("from-backup");
  const { file: backup } = backupStore({ source: backupSource, dir: path.join(dir, "backups") });
  const { file: target } = storeWithEntity("current");
  const { movedAside } = restoreStore({ backup, target, holders: [], now: new Date("2026-10-12T18:00:00Z") });
  assert.deepEqual(entityNames(target), ["from-backup"]);
  assert.deepEqual(entityNames(movedAside), ["current"]);
  assert.match(movedAside, /memory\.sqlite\.pre-restore-20261012T180000Z$/);
});

test("restore refuses while a process holds the store, unless forced", () => {
  const { dir, file: source } = storeWithEntity("from-backup");
  const { file: backup } = backupStore({ source, dir: path.join(dir, "backups") });
  const { file: target } = storeWithEntity("current");
  assert.throws(() => restoreStore({ backup, target, holders: ["4242"] }), /4242/);
  assert.deepEqual(entityNames(target), ["current"]);
  restoreStore({ backup, target, holders: ["4242"], force: true });
  assert.deepEqual(entityNames(target), ["from-backup"]);
});

test("restore refuses a backup that is not a healthy memory store", () => {
  const { dir, file: target } = storeWithEntity("current");
  const junk = path.join(dir, "junk.sqlite");
  fs.writeFileSync(junk, "not a database");
  assert.throws(() => restoreStore({ backup: junk, target, holders: [] }));
  assert.deepEqual(entityNames(target), ["current"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/backup.test.js`
Expected: FAIL with `Cannot find module …/src/lib/backup.js`.

- [ ] **Step 3: Write `src/lib/backup.js`:**

```js
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { integrityReport } from "./sqliteDb.js";

const BACKUP_NAME = /^memory-\d{8}T\d{6}Z\.sqlite$/;

// 2026-10-12T17:15:00.123Z -> 20261012T171500Z
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * Online backup: VACUUM INTO a new file. Safe while sessions write, because a
 * WAL reader copies one consistent snapshot. Shares ~/.claude-neo4j/backups
 * with the legacy Neo4j dumps; --keep only ever prunes memory-*.sqlite files.
 */
export function backupStore({ source, dir, keep = null, now = new Date() }) {
  if (!fs.existsSync(source)) {
    throw new Error(`no memory store at ${source}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `memory-${stamp(now)}.sqlite`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(file);
  } finally {
    db.close();
  }
  fs.chmodSync(file, 0o600);
  const pruned = keep === null ? [] : listBackups(dir).slice(keep);
  for (const old of pruned) {
    fs.rmSync(old);
  }
  return { file, pruned };
}

export function listBackups(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .reverse()
    .map((name) => path.join(dir, name));
}

/** Pids holding `file` open, from lsof. Without lsof the guard cannot see anyone. */
export function openHolders(file) {
  const result = spawnSync("lsof", ["-t", file], { encoding: "utf8" });
  if (result.error || !result.stdout) {
    return [];
  }
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * Replaces the store with a backup. The current store (and its -wal/-shm) is
 * renamed aside, never deleted. Refuses while a process holds the store, because
 * a session writing through an open handle would keep writing into the renamed file.
 */
export function restoreStore({ backup, target, force = false, holders = openHolders(target), now = new Date() }) {
  const check = new DatabaseSync(backup, { readOnly: true });
  let report;
  try {
    report = integrityReport(check);
  } finally {
    check.close();
  }
  if (!report.ok) {
    throw new Error(`${backup} is not a healthy memory store: ${report.integrity.join("; ")} (schema version ${report.userVersion})`);
  }
  if (holders.length > 0 && !force) {
    throw new Error(`processes ${holders.join(", ")} have ${target} open; close Claude Code sessions first, or pass --force`);
  }
  let movedAside = null;
  if (fs.existsSync(target)) {
    movedAside = `${target}.pre-restore-${stamp(now)}`;
    fs.renameSync(target, movedAside);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(target + suffix)) {
        fs.renameSync(target + suffix, movedAside + suffix);
      }
    }
  }
  fs.copyFileSync(backup, target);
  fs.chmodSync(target, 0o600);
  return { target, movedAside };
}
```

  If `integrityReport` throws on the junk file instead of returning `ok: false`, the last test still passes (`assert.throws`).

- [ ] **Step 4: Run to verify it passes**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/backup.test.js`
Expected: 5 PASS.

- [ ] **Step 5: Write the failing health test** at `tests/health.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { healthChecks } from "../src/lib/health.js";

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "health-test-")), "memory.sqlite");
const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name, c]));

test("a healthy store passes every check", () => {
  const file = tempFile();
  openMemoryDb(file).close();
  const checks = healthChecks(file);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  assert.match(byName(checks).node.detail, /^\d+\.\d+\.\d+$/);
});

test("a missing store fails the store check and stops there", () => {
  const checks = byName(healthChecks(tempFile()));
  assert.equal(checks.store.ok, false);
  assert.equal(checks.integrity, undefined);
});

test("a file that is not a database fails the integrity check", () => {
  const file = tempFile();
  fs.writeFileSync(file, "not a database");
  const checks = byName(healthChecks(file));
  assert.equal(checks.store.ok, true);
  assert.equal(checks.integrity.ok, false);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/health.test.js`
Expected: FAIL with `Cannot find module …/src/lib/health.js`.

- [ ] **Step 7: Write `src/lib/health.js`:**

```js
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { integrityReport } from "./sqliteDb.js";

/**
 * PASS/FAIL facts about the SQLite memory store. Read-only: opening with
 * openMemoryDb would create or upgrade the file, and a health check must not.
 */
export function healthChecks(file) {
  const checks = [{ name: "node", ok: true, detail: process.versions.node }];
  if (!fs.existsSync(file)) {
    checks.push({ name: "store", ok: false, detail: `${file} does not exist (start a session, or run npm run migrate-to-sqlite)` });
    return checks;
  }
  checks.push({ name: "store", ok: true, detail: file });
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const report = integrityReport(db);
    checks.push({
      name: "integrity",
      ok: report.ok,
      detail: `schema v${report.userVersion}, integrity ${report.integrity.join("; ")}, ${report.foreignKeyViolations} foreign-key violation(s)`,
    });
    if (report.ok) {
      const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      checks.push({ name: "contents", ok: true, detail: `${count("entities")} entities, ${count("observations")} observations` });
      const last = db.prepare("SELECT result, finished_at FROM migrations ORDER BY id DESC LIMIT 1").get();
      checks.push({ name: "migration", ok: true, detail: last ? `last ${last.result} at ${new Date(last.finished_at).toISOString()}` : "none recorded" });
    }
  } catch (error) {
    checks.push({ name: "integrity", ok: false, detail: error.message });
  } finally {
    db?.close();
  }
  return checks;
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" node --test tests/health.test.js`
Expected: 3 PASS.

- [ ] **Step 9: Add the three CLIs.** `scripts/backup.mjs`:

```js
#!/usr/bin/env node
// Online backup of the SQLite memory store into ~/.claude-neo4j/backups.
//   npm run backup [-- --keep N]
import path from "node:path";
import { CONFIG_DIR, memoryDbPath } from "../src/lib/config.js";
import { backupStore } from "../src/lib/backup.js";

const args = process.argv.slice(2);
const keepAt = args.indexOf("--keep");
const keep = keepAt === -1 ? null : Number(args[keepAt + 1]);
if (keep !== null && !(Number.isInteger(keep) && keep > 0)) {
  console.error("usage: backup [--keep N]   (N a positive integer)");
  process.exit(2);
}
try {
  const { file, pruned } = backupStore({ source: memoryDbPath(), dir: path.join(CONFIG_DIR, "backups"), keep });
  console.log(`backed up to ${file}${pruned.length ? `; pruned ${pruned.length} older backup(s)` : ""}`);
} catch (error) {
  console.error(`backup failed: ${error.message}`);
  process.exit(1);
}
```

`scripts/restore.mjs`:

```js
#!/usr/bin/env node
// Replaces the SQLite memory store with a backup; the current store is moved aside.
//   npm run restore -- --latest | <backup file> [--force]
import path from "node:path";
import { CONFIG_DIR, memoryDbPath } from "../src/lib/config.js";
import { listBackups, restoreStore } from "../src/lib/backup.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const named = args.find((a) => !a.startsWith("--"));
const backup = args.includes("--latest")
  ? listBackups(path.join(CONFIG_DIR, "backups"))[0]
  : named && path.resolve(process.env.INIT_CWD ?? process.cwd(), named);
if (!backup) {
  console.error("usage: restore --latest | <backup file> [--force]   (no backup found)");
  process.exit(2);
}
try {
  const { target, movedAside } = restoreStore({ backup, target: memoryDbPath(), force });
  console.log(`restored ${backup} to ${target}${movedAside ? `; previous store kept at ${movedAside}` : ""}`);
} catch (error) {
  console.error(`restore refused: ${error.message}`);
  process.exit(1);
}
```

`scripts/check-health.mjs`:

```js
#!/usr/bin/env node
// PASS/FAIL per check for the SQLite memory store. Run through bin/memory-node
// (npm run health), so getting this far already proves the launcher found a Node.
import { memoryDbPath } from "../src/lib/config.js";
import { healthChecks } from "../src/lib/health.js";

const checks = healthChecks(memoryDbPath());
for (const { name, ok, detail } of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(10)} ${detail}`);
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
```

  In `package.json` scripts set:

```json
"backup": "bash bin/memory-node scripts/backup.mjs",
"restore": "bash bin/memory-node scripts/restore.mjs",
"health": "bash bin/memory-node scripts/check-health.mjs"
```

  As line 2 of each of `scripts/backup.sh`, `scripts/restore.sh`, `scripts/lib-backup.sh` and `scripts/check-health.sh`, insert:

```text
# LEGACY (Neo4j engine): kept to reach a Neo4j graph until it is retired. The SQLite equivalent is npm run backup|restore|health.
```

- [ ] **Step 10: Smoke-test the CLIs against a temp store** (a subshell, so HOME comes back):

```bash
( T="$(mktemp -d)"; export HOME="$T" CLAUDE_NEO4J_SQLITE="$T/memory.sqlite"
  echo '{"session_id":"s","cwd":"/tmp"}' | bash bin/memory-node --hook src/hooks/session-start.js >/dev/null
  npm run health && npm run backup -- --keep 1 && npm run restore -- --latest --force; echo "exit $?" )
```
Expected: PASS lines, then `backed up to …/backups/memory-…sqlite`, then `restored … previous store kept at …`, then `exit 0`.

- [ ] **Step 11: Full suite**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" npm test`
Expected: as before plus the 8 new tests.

- [ ] **Step 12: Commit**

```bash
git add src/lib/backup.js src/lib/health.js scripts/backup.mjs scripts/restore.mjs scripts/check-health.mjs scripts/backup.sh scripts/restore.sh scripts/lib-backup.sh scripts/check-health.sh tests/backup.test.js tests/health.test.js package.json
git commit -m "Back up, restore and health-check the SQLite store" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docs, legacy labels, the stray-test-row remover, 0.7.0, public-repo review

**Files:**
- Create: `scripts/remove-test-rows.mjs`
- Modify: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `skills/memory-search/SKILL.md`, `skills/memory-status/SKILL.md`, `skills/timeline-report/SKILL.md`; line 2 of `scripts/setup-local.sh`, `scripts/configure.mjs`, `scripts/lib-engine.sh`, `scripts/migrate-to-podman.sh`, `scripts/fingerprint.sh`, `scripts/cypher.sh`, `scripts/memory-usage.sh`, `scripts/backfill-subsystems.mjs`, `scripts/migrate-from-claude-mem.mjs`

Scope note for Michael's review: the spec ports `backfill-subsystems.mjs`, `migrate-from-claude-mem.mjs` and `memory-usage.sh` to SQLite. This plan only labels them legacy, Neo4j-only, and leaves porting them for a later change. None of them is needed to switch a machine.

- [ ] **Step 1: Legacy labels.** As line 2 of each script listed above (after the shebang; for `configure.mjs` and the `.mjs` files use `//`), insert:

```text
# LEGACY (Neo4j engine): reaches the old Neo4j graph only; kept until Neo4j is retired.
```

- [ ] **Step 2: Version and descriptions.**
  - Set `"version": "0.7.0"` in `package.json` and `.claude-plugin/plugin.json`.
  - `plugin.json` description: `"Persistent memory for Claude Code in a local SQLite file (node:sqlite; no server, no container). Injects standing facts and a subsystem map at session start, captures new facts at compaction and session end, and exposes search tools. A machine's Neo4j graph moves across by itself on first start."`
  - `plugin.json` `"keywords"`: `["memory", "sqlite", "knowledge-graph"]`.
  - `marketplace.json`: the plugin's `description` becomes `"Persistent memory for Claude Code in a local SQLite file."`

- [ ] **Step 3: CHANGELOG.** Add at the top, under a new `## 0.7.0 — <today's date>` heading:

```markdown
- **Changed (breaking)**: the engine runs on SQLite (`~/.claude-neo4j/memory.sqlite`, via
  `node:sqlite`) instead of Neo4j. No server or container is needed. On a machine with a Neo4j
  config, the first session start moves the graph across by itself; memory is off for that
  minute, and a failed check never becomes the live store. For 7 days after, session start also
  copies what sessions still running 0.6 wrote to Neo4j. Rollback is installing 0.6.0: Neo4j is
  only read.
- **Added** `bin/memory-node`, which starts the MCP server and hooks under the first Node with
  `node:sqlite` (22.13+, 23.4+, 24+): `CLAUDE_NEO4J_NODE`, `node` on PATH, nvm, fnm, volta,
  Homebrew. With none, hooks show one line and the server fails visibly.
- **Added** `npm run backup` (`VACUUM INTO`), `npm run restore -- --latest|<file>` (integrity
  check, refuses while the store is open unless `--force`, moves the current store aside),
  `npm run health`, and `npm run memory -- start-fresh`.
- **Legacy (Neo4j only)**: `backup.sh`, `restore.sh`, `check-health.sh`, `setup-local.sh`,
  `configure.mjs`, `migrate-to-podman.sh`, `cypher.sh`, `fingerprint.sh`, `memory-usage.sh`,
  `backfill-subsystems.mjs`, `migrate-from-claude-mem.mjs`, and `docker/`.
```

- [ ] **Step 4: README.** Rewrite it around SQLite. Keep the existing sections on tools, budgets, relevance, subsystems and telemetry that are still true. It must contain, in this order:
  1. **What it is**: one paragraph on local SQLite memory and what it injects, captures and exposes.
  2. **Requirements**: Node 22.13+/23.4+/24+ somewhere on the machine, and the launcher's search order.
  3. **Install**, with the commands below. Then: if the install path (`installPath` in `~/.claude/plugins/installed_plugins.json`) has no `node_modules`, run `npm install --omit=dev --registry=https://registry.npmjs.org/` in it. All three dependencies are public, so this skips any private registry `~/.npmrc` names.

```bash
claude plugin marketplace add troglodyte/claude-neo4j-mem
claude plugin install neo4j-memory@claude-neo4j-local --scope user
```

  4. **First start**: the state table from the spec in plain words: an existing store, a new user, the move (about a minute, memory off), Neo4j down (start it once, or `npm run memory -- start-fresh`), and a failed move (the log path and `npm run migrate-to-sqlite`). Then the 7-day catch-up in two sentences.
  5. **Moving a machine off Neo4j**: install while Neo4j still runs → start one session and wait for the move → `npm run health` → `npm run backup` → the stray-test-row remover (dry run, then `--apply`) → stop the container (`podman stop claude-neo4j-memory`, or `docker stop claude-neo4j-memory`) once the catch-up no longer matters.
  6. **Backup, restore, health.**
  7. **Legacy: Neo4j**: the scripts that remain for reaching the old graph.
  8. **Development**: `scripts/claude-with-memory.sh`, and `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" npm test`.

- [ ] **Step 5: CLAUDE.md.** After the intro paragraph insert:

```markdown
## Engine

Since 0.7.0 the engine is SQLite: `~/.claude-neo4j/memory.sqlite`, opened through
`src/lib/memoryStore.js` (which refuses to create a store while `src/lib/firstStart.js` says memory
should be moving), schema in `src/lib/sqliteDb.js`, every process started by `bin/memory-node`.
Neo4j survives only as the source of the first-start move and the 7-day catch-up
(`src/lib/catchUp.js`). Everything below under "Legacy: Neo4j engine" describes the old engine
and its container plumbing, kept until the graph is retired.
```

  Then rename `## Environment` to `## Legacy: Neo4j engine`, and move under it every Neo4j, Podman or Docker bullet from "Design decisions and traps" (`resolve_engine`, volumes, healthcheck paths, rootless Podman, boot persistence, podman machine, Lucene escaping). In `## Useful commands`, append ` (legacy)` to every line naming a Neo4j-only script, and rewrite `npm run backup`/`restore` to describe the SQLite versions.

- [ ] **Step 6: Skills.**
  - `memory-search/SKILL.md`: "Search the Neo4j memory graph" → "Search the memory store".
  - `timeline-report/SKILL.md`: "from the Neo4j memory graph's chronological observation timeline" → "from the memory store's chronological observation timeline".
  - `memory-status/SKILL.md`: the description becomes `Report where memory is stored (the SQLite file), the active project scope, and entity/observation counts, or list every project in the store with its usage. Use when the user asks whether memory is working, where it is stored, how much has been remembered, what projects are stored, or how much each project takes.` Delete the "Running arbitrary Cypher" section and the "Do not write ad-hoc Cypher" line. The failure paragraph becomes `If a tool call fails, run npm run health inside the plugin directory: it checks the launcher's Node, the store file, its schema and integrity, and prints PASS/FAIL per check.`

- [ ] **Step 7: The stray-test-row remover**, `scripts/remove-test-rows.mjs`. A test run wrote these rows into the live Neo4j graph on 2026-10-09, and the move copies them into SQLite:

```js
#!/usr/bin/env node
// Removes the rows a test run wrote into the live Neo4j graph on 2026-10-09
// (19:10–19:14Z), which the move to SQLite then copied: the projects
// github.com/acme/app, github.com/acme/other and p, plus observations on the
// global `user` entity from that window ("g", "global", "quokka global", ...).
// SQLite only; Neo4j is never touched. Dry run unless --apply.
import { getDb, closeDb } from "../src/lib/memoryStore.js";
import { deleteEntity, deleteObservations } from "../src/lib/graph.js";

const TEST_PROJECTS = ["github.com/acme/app", "github.com/acme/other", "p"];
const WINDOW = [Date.parse("2026-10-09T19:00:00Z"), Date.parse("2026-10-09T19:30:00Z")];
const apply = process.argv.includes("--apply");
const db = getDb();

const entities = db
  .prepare(`SELECT name, project FROM entities WHERE project IN (${TEST_PROJECTS.map(() => "?").join(",")})`)
  .all(...TEST_PROJECTS);
const userObs = db
  .prepare(
    `SELECT o.id, o.text, o.created_at FROM observations o JOIN entities e ON e.id = o.entity_id
     WHERE e.name = 'user' AND e.project = '' AND o.created_at BETWEEN ? AND ?`
  )
  .all(...WINDOW);

console.log(`${entities.length} test entities in ${TEST_PROJECTS.join(", ")}`);
console.log(`${userObs.length} global "user" observations from the test window:`);
for (const o of userObs) {
  console.log(`  ${new Date(o.created_at).toISOString()}  ${o.text}`);
}
if (apply) {
  for (const { name, project } of entities) {
    await deleteEntity(name, project);
  }
  if (userObs.length) {
    await deleteObservations("user", userObs.map((o) => o.id), "");
  }
  console.log("deleted");
} else {
  console.log("dry run; pass --apply to delete");
}
closeDb();
```

  Smoke-test it: `HOME=$(mktemp -d) bash bin/memory-node scripts/remove-test-rows.mjs` prints `0 test entities …` and `dry run`.

- [ ] **Step 8: Public-repo review.** Run this, where `~/.config/public-repo-terms` (kept outside the repo) holds one pattern per line for the employer's internal identifiers and ticket keys, and list every hit (file:line and text) for Michael without editing any:

```bash
rg -n -i -f "$HOME/.config/public-repo-terms" -g '!node_modules' -g '!package-lock.json' .
```

- [ ] **Step 9: Verify and commit**

Run: `env -u CLAUDE_NEO4J_DISABLE_CAPTURE HOME="$(mktemp -d)" npm test`
Expected: as in Task 6.

```bash
git add -A -- . ':!node_modules'
git commit -m "Document the SQLite engine and release it (0.7.0)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Rollout on this machine (operational; Michael approves each GATE)

Run each step from `$HOME`, not from inside the repo: `claude plugin` commands run inside a repo can rewrite its `.claude/settings.json`. Stop at each **GATE** and wait for Michael's yes. `$SCRATCH` is the session scratchpad.

On this machine, the work plugin (0.13.0) still carries the Neo4j engine, and it reads the same `~/.claude-neo4j/config.json` and the same `CLAUDE_NEO4J_DISABLE_CAPTURE`. Its memory goes quiet once the Neo4j password leaves `config.json` (Step 7). Its tools are hidden with a permission rule.

- [ ] **Step 1 (GATE: push).** After Michael resolves the Task 7 Step 8 findings: fast-forward `main` to this branch and `git push origin main`.

- [ ] **Step 2: Install, with Neo4j still running.**

```bash
cd ~ && claude plugin marketplace add troglodyte/claude-neo4j-mem && claude plugin install neo4j-memory@claude-neo4j-local --scope user
IP=$(jq -r '.plugins["neo4j-memory@claude-neo4j-local"][] | select(.scope=="user") | .installPath' ~/.claude/plugins/installed_plugins.json); echo "$IP"
[ -d "$IP/node_modules" ] || (cd "$IP" && npm install --omit=dev --registry=https://registry.npmjs.org/)
grep -q memory-node "$IP/.mcp.json" && echo "snapshot is 0.7.0 code"
cp ~/.claude-neo4j/config.json ~/.claude-neo4j/config.json.pre-sqlite
```

- [ ] **Step 3: Rehearse the move** into a scratch file. Neo4j is only read.

```bash
cd "$IP" && npm run migrate-to-sqlite -- --out "$SCRATCH/rehearsal.sqlite" --report "$SCRATCH/rehearsal-report.json"; echo "exit $?"
```
Expected: exit 0 and `PASS`. Show Michael the summary table.

- [ ] **Step 4 (GATE: first start).** Michael restarts his Claude Code sessions (this also drops claude-mem's hooks, which keep recreating `~/.claude-mem` until then) and opens one. Expected: `🧠 Memory: off — moving to SQLite…`. Then:

```bash
tail -5 ~/.claude-neo4j/state/migrate.log; jq '{result, reason}' ~/.claude-neo4j/state/migrate.json
cd "$IP" && npm run health && npm run backup
```
Expected: `first start: memory moved to …/memory.sqlite`, `result: "passed"`, all PASS with `migration last passed`, and a backup file.

- [ ] **Step 5: Spec acceptance, while Neo4j still runs.** `cd "$IP" && npm run search-parity` must meet the spec's thresholds (top result ≥ 95%, relevance label ≥ 95%). Then `npm run memory -- dupes --project github.com/troglodyte/claude-neo4j-mem` lists that project's reworded repeats, and the next session start shows collapsed standing facts.

- [ ] **Step 6 (GATE: stray test rows, SQLite only).** `cd "$IP" && bash bin/memory-node scripts/remove-test-rows.mjs`; show Michael the list; only after his yes, run it again with `--apply`, then `npm run health`.

- [ ] **Step 7 (GATE: settings).**

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.pre-sqlite-$(date +%Y%m%d)
jq 'del(.env.CLAUDE_NEO4J_DISABLE_CAPTURE)
    | .permissions.deny = ((.permissions.deny // []) + ["mcp__plugin_<work-plugin>_neo4j-memory"] | unique)' \
  ~/.claude/settings.json > "$SCRATCH/settings.json" && mv "$SCRATCH/settings.json" ~/.claude/settings.json
cd ~/.claude-neo4j && umask 077 && jq '{mode, uri, username, password, database}' config.json > neo4j-legacy.json \
  && jq 'del(.password, .uri, .username, .database, .mode)' config.json > config.new && mv config.new config.json && chmod 600 config.json neo4j-legacy.json
```

  With the password out of `config.json`, the work plugin's capture stays off (it checks `isConfigured()`), its session start shows one harmless "not configured yet" line, and the catch-up skips quietly. The password stays in `neo4j-legacy.json` and `config.json.pre-sqlite`.

- [ ] **Step 8 (GATE: stop Neo4j).** `podman stop claude-neo4j-memory && podman update --restart=no claude-neo4j-memory`. The volume stays.

- [ ] **Step 9: Verify.** `cd "$IP" && npm run health` is all PASS. In a new session: the session-start line comes from SQLite; `memory_search` answers a known past fact; the work plugin's memory tools are absent. After that session ends, `tail -3 ~/.claude-neo4j/capture.log` shows a captured line, and `npm run memory -- status` counts rose.

- [ ] **Step 10: Hand Michael the follow-ups.**
  - A drafted edit to the Memory section of `~/.claude/CLAUDE.md` (it still names the work plugin's tools); he applies it.
  - The `~/.claude-mem` that claude-mem's lingering hooks recreated after the uninstall: move it aside once every session has restarted.
  - The second machine: the README's "Moving a machine off Neo4j".
  - Later: port or drop the three legacy scripts, remove memory from the work plugin, retire `neo4j-driver` and the container scripts, delete the Podman volume.
