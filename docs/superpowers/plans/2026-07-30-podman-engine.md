# Podman Engine Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the local Neo4j container under Podman instead of Docker, keeping Docker working, and move this machine's existing graph across without risking it.

**Architecture:** The plugin's JS never learns about the engine — it dials `bolt://localhost:7687` either way. All six shell scripts stop hardcoding `docker` and instead source a new `scripts/lib-engine.sh` that resolves an `$ENGINE` variable, preferring Podman. `setup-local.sh` replaces `docker compose up -d` with a plain `$ENGINE run` (one service does not justify a compose dependency Podman cannot satisfy natively) and gains consent-gated installs. A one-shot `migrate-to-podman.sh` moves the graph by dump/load, rehearsing on port 7688 while Docker keeps serving 7687.

**Tech Stack:** bash (the repo's existing shim-based test style), Podman 5.7 / Docker, Neo4j 5.26.28 (`neo4j:5-community`), `neo4j-admin database dump/load`, cypher-shell borrowed from inside the container.

**Spec:** `docs/superpowers/specs/2026-07-30-podman-engine-design.md`

## Global Constraints

- **Never write a SHA or a graph size into `CLAUDE.md`.** Repo rule; run `git status -sb` / `npm run usage` instead.
- **Test and smoke-test data is deleted after verification, every time.** Repo rule.
- **Docker must keep working.** No existing user migrates. Every change is engine-agnostic, not a Docker-to-Podman swap.
- **The Docker container and its volume are never written to.** Migration is copy-not-move; rollback stays available until the user runs the reclaim command by hand.
- **All new `scripts/*.sh` resolve the repo root in two steps and assert `.claude-plugin/plugin.json` exists.** A single `cd "$(dirname X)/.."` degrades to `/` silently and `set -e` cannot catch it. `tests/launcher-path.test.sh` enforces this.
- **Volume names differ per engine, deliberately.** On the **Docker** side they are `docker_claude_neo4j_data` / `docker_claude_neo4j_logs` — compose created them with its directory as a prefix, and `setup-local.sh` must keep those literals (Task 4's trap). On the **Podman** side they are `claude_neo4j_data` / `claude_neo4j_logs`, created fresh by the migration (Task 8). This asymmetry *is* the migration; it is not a typo to reconcile.
- **Container name:** `claude-neo4j-memory`. **Image:** `neo4j:5-community`.
- Version in `package.json` and `.claude-plugin/plugin.json` must stay in lockstep.

## File Structure

| file | responsibility |
| --- | --- |
| `scripts/lib-engine.sh` | **new.** `resolve_engine`, `container_health`, `engine_hint`. Sourced, never executed. Sole owner of "which engine and how do I ask it things". |
| `tests/engine-resolve.test.sh` | **new.** PATH-shim tests for `resolve_engine`. |
| `scripts/lib-backup.sh` | Drops its five `docker`-hardcoded helpers in favour of `$ENGINE`. |
| `scripts/backup.sh`, `scripts/restore.sh` | `docker run` → `"$ENGINE" run`. Nothing else. |
| `scripts/cypher.sh` | `docker exec` → `"$ENGINE" exec`. |
| `scripts/check-health.sh` | Engine-aware; reports which engine resolved. |
| `scripts/setup-local.sh` | Engine detection, `$ENGINE run` in place of compose, consent-gated Podman + systemd installs. |
| `scripts/fingerprint.sh` | **new.** Prints a 3-part content fingerprint of a running container's graph. Used on both sides of the migration. |
| `scripts/migrate-to-podman.sh` | **new, one-shot.** Orchestrates Steps 0–3, fails closed. |
| `docker/docker-compose.yml` | **deleted.** |
| `docker/.env` | Path kept deliberately — gitignored, already on disk, and `cypher.sh:63` reads it. |

---

### Task 1: Engine resolution

**Files:**
- Create: `scripts/lib-engine.sh`
- Create: `tests/engine-resolve.test.sh`
- Modify: `package.json:test`

**Interfaces:**
- Produces: `resolve_engine()` sets global `ENGINE` to `podman`|`docker`, returns 1 with a stderr message if none usable. `container_health <container>` echoes a health string. `engine_hint <engine>` echoes a remediation sentence.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/engine-resolve.test.sh`:

```bash
#!/usr/bin/env bash
# resolve_engine must prefer podman, fall back to docker, honour an explicit
# override, and refuse anything else. Uses PATH shims so no engine is required
# to run these -- same technique as launcher-path.test.sh.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && cd .. && pwd -P)"
LIB="$REPO_ROOT/scripts/lib-engine.sh"

SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT

failures=0
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }
pass() { printf 'ok: %s\n' "$1"; }

# A shim that succeeds or fails `info` on demand; any other verb echoes itself.
make_shim() {
  local name="$1" info_rc="$2"
  cat >"$SHIM/$name" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "info" ]; then exit $info_rc; fi
printf '%s %s\n' "$name" "\$*"
EOF
  chmod +x "$SHIM/$name"
}

# Run resolve_engine in a subshell with a controlled PATH, echo the result.
try_resolve() {
  env PATH="$SHIM" CLAUDE_NEO4J_ENGINE="${1:-}" bash -c '
    source "$0" || exit 9
    if resolve_engine; then printf "%s\n" "$ENGINE"; else printf "ERR:%s\n" "$?"; fi
  ' "$LIB" 2>/dev/null
}

# 1. Both present and working -> podman wins.
make_shim podman 0; make_shim docker 0
[ "$(try_resolve)" = "podman" ] && pass "prefers podman when both work" \
  || fail "expected podman, got: $(try_resolve)"

# 2. Podman present but not functional (mac: machine not started) -> docker.
make_shim podman 1; make_shim docker 0
[ "$(try_resolve)" = "docker" ] && pass "falls back to docker when podman info fails" \
  || fail "expected docker, got: $(try_resolve)"

# 3. Podman absent entirely -> docker.
rm -f "$SHIM/podman"; make_shim docker 0
[ "$(try_resolve)" = "docker" ] && pass "falls back to docker when podman is absent" \
  || fail "expected docker, got: $(try_resolve)"

# 4. Neither usable -> non-zero, no ENGINE.
rm -f "$SHIM/docker"
[[ "$(try_resolve)" == ERR:* ]] && pass "fails when no engine is usable" \
  || fail "expected failure, got: $(try_resolve)"

# 5. Explicit override is honoured even though podman is available and preferred.
make_shim podman 0; make_shim docker 0
[ "$(try_resolve docker)" = "docker" ] && pass "honours CLAUDE_NEO4J_ENGINE=docker" \
  || fail "override ignored, got: $(try_resolve docker)"

# 6. An unknown override is rejected rather than silently ignored.
[[ "$(try_resolve nerdctl)" == ERR:* ]] && pass "rejects an unknown CLAUDE_NEO4J_ENGINE" \
  || fail "accepted nerdctl, got: $(try_resolve nerdctl)"

# 7. An override naming an engine that is not installed fails loudly.
rm -f "$SHIM/podman"
[[ "$(try_resolve podman)" == ERR:* ]] && pass "rejects an override that is not on PATH" \
  || fail "accepted missing podman, got: $(try_resolve podman)"

((failures == 0)) || { printf '\n%d check(s) failed\n' "$failures"; exit 1; }
printf '\nall checks passed\n'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/engine-resolve.test.sh`
Expected: FAIL — every case reports `ERR:9` because `scripts/lib-engine.sh` does not exist yet (the `source` guard exits 9).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/lib-engine.sh`:

```bash
#!/usr/bin/env bash
# Resolves which container engine to drive. Sourced, never executed.
#
# Podman is preferred: it is daemonless and rootless, so it needs neither a
# privileged daemon nor docker-group membership. Docker stays fully supported
# so existing installs keep working untouched -- every verb these scripts use
# (info, inspect, start, stop, exec -i, run --rm --volumes-from) is spelled
# identically by both, which is the whole reason one variable suffices.

# Sets ENGINE on success. Returns 1 with an explanation on stderr otherwise.
resolve_engine() {
  local requested="${CLAUDE_NEO4J_ENGINE:-}" candidate

  if [ -n "$requested" ]; then
    case "$requested" in
      podman|docker) ;;
      *)
        echo "CLAUDE_NEO4J_ENGINE must be 'podman' or 'docker' (got: '$requested')" >&2
        return 1 ;;
    esac
    if ! command -v "$requested" >/dev/null 2>&1; then
      echo "CLAUDE_NEO4J_ENGINE=$requested, but $requested is not on PATH." >&2
      return 1
    fi
    if ! "$requested" info >/dev/null 2>&1; then
      echo "CLAUDE_NEO4J_ENGINE=$requested, but '$requested info' failed.$(engine_hint "$requested")" >&2
      return 1
    fi
    ENGINE="$requested"
    return 0
  fi

  for candidate in podman docker; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" info >/dev/null 2>&1; then
      ENGINE="$candidate"
      return 0
    fi
  done

  ENGINE=""
  return 1
}

engine_hint() {
  case "$1" in
    podman) printf ' On macOS run: podman machine start' ;;
    docker) printf ' Start Docker Desktop, or the docker service.' ;;
  esac
}

# Podman and Docker have disagreed about where healthcheck state lives
# (.State.Health vs .State.Healthcheck) across versions, and `inspect` returns
# an EMPTY STRING rather than an error for a template that matches nothing --
# so a wrong guess here reads as "not healthy yet" and silently burns the whole
# retry loop. Try both and say "unknown" only if neither answers.
container_health() {
  local container="$1" status
  status="$("$ENGINE" inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null)"
  [ -n "$status" ] || status="$("$ENGINE" inspect -f '{{.State.Healthcheck.Status}}' "$container" 2>/dev/null)"
  printf '%s' "${status:-unknown}"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/engine-resolve.test.sh`
Expected: PASS — `all checks passed`, 7 `ok:` lines.

- [ ] **Step 5: Wire into `npm test`**

Modify `package.json`, the `test` script, adding the new file to the existing chain:

```json
"test": "bash tests/launcher-path.test.sh && bash tests/engine-resolve.test.sh && node --test tests/**/*.test.js",
```

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib-engine.sh tests/engine-resolve.test.sh package.json
git commit -m "Add container-engine resolution preferring Podman

Podman is daemonless and rootless; Docker stays supported so no existing
install has to migrate. container_health reads both .State.Health and
.State.Healthcheck because inspect returns an empty string, not an error,
for a template that matches nothing."
```

---

### Task 2: Convert the backup/restore path to `$ENGINE`

**Files:**
- Modify: `scripts/lib-backup.sh:8`, `:66-110`
- Modify: `scripts/backup.sh:80`, `:106`, `:109`
- Modify: `scripts/restore.sh:57`, `:104`, `:148`

**Interfaces:**
- Consumes: `resolve_engine`, `container_health`, `ENGINE` from Task 1.
- Produces: `require_engine()` replacing `require_docker()`. No other caller-visible change.

Both scripts already stream the archive over stdout/stdin (`--to-stdout` / `--from-stdin`), so nothing is bind-mounted. That matters: rootless Podman shifts uids through the subuid range, and a bind-mounted dump would land owned by an unusable uid. This path needs no adaptation for that.

- [ ] **Step 1: Source the new lib and replace `require_docker`**

In `scripts/lib-backup.sh`, after the `CONTAINER=` line at the top:

```bash
CONTAINER="claude-neo4j-memory"
# shellcheck source=scripts/lib-engine.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib-engine.sh"
```

Replace `require_docker()` (currently lines 66-70) with:

```bash
require_engine() {
  resolve_engine || die "no container engine available. Install Podman (recommended) or Docker, then re-run. See: scripts/setup-local.sh"
  "$ENGINE" inspect "$CONTAINER" >/dev/null 2>&1 || die "container $CONTAINER not found under $ENGINE (run: scripts/setup-local.sh)"
}
```

- [ ] **Step 2: Replace the remaining `docker` literals in `lib-backup.sh`**

```bash
container_running() {
  [ "$("$ENGINE" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

container_image() {
  "$ENGINE" inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null
}
```

In `restart_container`, both `docker start` occurrences:

```bash
  "$ENGINE" start "$CONTAINER" >/dev/null || {
    echo "$PROG: FAILED to restart $CONTAINER — start it with: $ENGINE start $CONTAINER" >&2
    return 1
  }
```

In `stop_container_with_restart_trap`: `"$ENGINE" stop "$CONTAINER"`.

In `wait_for_health`, use the Task 1 helper instead of the raw template:

```bash
    status="$(container_health "$CONTAINER")"
```

- [ ] **Step 3: Update the three call sites**

`scripts/backup.sh:80` and `scripts/restore.sh:57`: `require_docker` → `require_engine`.

`scripts/backup.sh:106` and `:109`, `scripts/restore.sh:104` and `:148`: `docker run` → `"$ENGINE" run`. Leave every flag and the `${PIPESTATUS[...]}` handling exactly as-is — those indices depend on pipeline shape, not on the engine.

- [ ] **Step 4: Verify against the live Docker container**

Run: `CLAUDE_NEO4J_ENGINE=docker npm run backup`
Expected: a new `.dump` + `.sha256` in `~/.claude-neo4j/backups/`, container stopped and restarted, exit 0.

Run: `npm run backup -- --info "$(ls -t ~/.claude-neo4j/backups/*.dump | head -1)"`
Expected: archive metadata printed, exit 0.

Run: `npm test`
Expected: PASS (`launcher-path.test.sh` covers backup.sh/restore.sh root resolution).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib-backup.sh scripts/backup.sh scripts/restore.sh
git commit -m "Drive backup/restore through the resolved engine

Both already stream the archive via stdout/stdin, so there is nothing
bind-mounted for rootless Podman's uid shifting to break."
```

---

### Task 3: Convert cypher.sh and check-health.sh

**Files:**
- Modify: `scripts/cypher.sh:96-106`, `:125-126`
- Modify: `scripts/check-health.sh:23-33`

**Interfaces:**
- Consumes: `resolve_engine`, `container_health`, `ENGINE` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Update `cypher.sh`**

Source the lib next to the existing `CONTAINER=` definition, then replace the container branch at lines 96-106:

```bash
if [ "$MODE" = "local" ] && resolve_engine && "$ENGINE" inspect "$CONTAINER" >/dev/null 2>&1; then
  if [ "$("$ENGINE" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
    echo "cypher.sh: container $CONTAINER exists but is not running (run: $ENGINE start $CONTAINER)" >&2
    exit 1
  fi
  # Inside the container Neo4j is always at the default bolt port, regardless
  # of whatever host port mapping NEO4J_BOLT_PORT set up.
  exec "$ENGINE" exec -i "$CONTAINER" cypher-shell \
    -a "bolt://localhost:7687" -u "$USERNAME" -p "$PASSWORD" -d "$DATABASE" \
    --format "$FORMAT" "$QUERY"
fi
```

In the trailing help text at lines 125-126, replace the compose instruction:

```
For local mode, starting the container also gives you one for free:
  scripts/setup-local.sh
```

- [ ] **Step 2: Update `check-health.sh`**

Source the lib after the `cd "$REPO_ROOT"` line, then replace check 1 (lines 23-33):

```bash
# 1. Container present and healthy, under whichever engine resolved
if ! resolve_engine; then
  fail "no container engine available (install Podman or Docker, then run scripts/setup-local.sh)"
elif ! "$ENGINE" inspect claude-neo4j-memory >/dev/null 2>&1; then
  fail "container claude-neo4j-memory not found under $ENGINE (run: scripts/setup-local.sh)"
else
  status="$(container_health claude-neo4j-memory)"
  if [ "$status" = "healthy" ]; then
    pass "container claude-neo4j-memory is healthy (engine: $ENGINE)"
  else
    fail "container claude-neo4j-memory status is '$status', expected 'healthy' (engine: $ENGINE)"
  fi
fi
```

Reporting the engine is the point: with two engines possible, "healthy" alone no longer says *which* database you are talking to.

Also update the file header comment on line 2: `Docker container health` → `container health`.

- [ ] **Step 3: Verify**

Run: `scripts/check-health.sh`
Expected: 4 `[OK]` lines, `All checks passed.`, and check 1 reads `(engine: docker)` — Podman is not installed yet.

Run: `scripts/cypher.sh "MATCH (e:Entity) RETURN count(e) AS entities"`
Expected: the entity count, matching `npm run usage`.

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/cypher.sh scripts/check-health.sh
git commit -m "Make cypher.sh and check-health.sh engine-agnostic

check-health now names the resolved engine: with two possible, 'healthy'
alone no longer identifies which database you reached."
```

---

### Task 4: Replace compose with `$ENGINE run`

**Files:**
- Modify: `scripts/setup-local.sh:20-40`, `:66-87`
- Delete: `docker/docker-compose.yml`

**Interfaces:**
- Consumes: `resolve_engine`, `container_health`, `ENGINE` from Task 1.
- Produces: `start_container()` used by Task 5.

`podman compose` in 5.7 is a shim that delegates to a `docker-compose` or `podman-compose` binary which must already be installed, so "install Podman" alone would not make `compose up -d` work. The compose file describes exactly one service, so inlining it removes a dependency rather than adding a branch.

> **TRAP — volume naming.** Compose prefixes volumes with its project directory, so the live volume is `docker_claude_neo4j_data`, **not** `claude_neo4j_data`. A plain `run -v claude_neo4j_data:/data` would create a *different, empty* volume and a Docker user re-running setup after removing their container would find their graph apparently gone (the old volume survives, just detached). The literal names below preserve the existing ones exactly. Do not tidy them.

- [ ] **Step 1: Replace the engine preamble**

Replace `scripts/setup-local.sh` lines 20-40 (the two `docker` checks) with:

```bash
# shellcheck source=scripts/lib-engine.sh
. "$REPO_ROOT/scripts/lib-engine.sh"

if ! resolve_engine; then
  offer_engine_install || exit 1     # defined in Task 5
fi
echo "Using container engine: $ENGINE"
```

Until Task 5 lands, stub `offer_engine_install` immediately above that block so this task is independently runnable:

```bash
# Replaced in Task 5 by the consent-gated installer.
offer_engine_install() {
  cat >&2 <<'EOF'
No container engine found. Install Podman (recommended) or Docker, then re-run.

  Debian/Ubuntu  sudo apt-get install -y podman
  macOS          brew install podman && podman machine init && podman machine start

Or skip containers entirely and point the plugin at a remote Neo4j
(e.g. Neo4j Aura's free tier: https://console.neo4j.io):
  node scripts/configure.mjs --mode remote \
    --uri neo4j+s://xxxxx.databases.neo4j.io \
    --username neo4j --password '...' --database neo4j
EOF
  return 1
}
```

- [ ] **Step 2: Replace the compose invocation**

Replace lines 66-69 with a `start_container` function and its call:

```bash
# Volume names are the ones compose already created ("docker_" prefix and all).
# Renaming them would strand the existing graph in a detached volume and hand
# the user a silently empty database.
DATA_VOLUME="docker_claude_neo4j_data"
LOGS_VOLUME="docker_claude_neo4j_logs"

start_container() {
  "$ENGINE" run -d \
    --name claude-neo4j-memory \
    --restart unless-stopped \
    -p "${NEO4J_HTTP_PORT:-7474}:7474" \
    -p "${NEO4J_BOLT_PORT:-7687}:7687" \
    -e NEO4J_AUTH="${NEO4J_USERNAME}/${NEO4J_PASSWORD}" \
    -e NEO4J_dbms_memory_pagecache_size=512M \
    -e NEO4J_server_memory_heap_max__size=512M \
    -v "$DATA_VOLUME:/data" \
    -v "$LOGS_VOLUME:/logs" \
    --health-cmd "wget -O /dev/null -q http://localhost:7474 || exit 1" \
    --health-interval 5s \
    --health-timeout 5s \
    --health-retries 30 \
    neo4j:5-community >/dev/null
}

if ! "$ENGINE" inspect claude-neo4j-memory >/dev/null 2>&1; then
  echo "Container claude-neo4j-memory not found, starting it under $ENGINE..."
  start_container
fi
```

- [ ] **Step 3: Use the shared health reader**

Replace line 73 with `status="$(container_health claude-neo4j-memory)"`, and line 78's remediation text with `Run: scripts/setup-local.sh`.

Note `container_health` returns `unknown`, never the old `missing` sentinel, so update the branch at lines 77-80 to test for `unknown` instead.

- [ ] **Step 4: Delete the compose file**

```bash
git rm docker/docker-compose.yml
```

- [ ] **Step 5: Verify nothing regressed for Docker**

The live container already exists, so `start_container` must NOT run.

Run: `scripts/setup-local.sh`
Expected: `Using container engine: docker`, no container recreated, `Container healthy. Configuring plugin...`, exit 0.

Run: `npm run usage --silent -- --quiet`
Expected: unchanged totals — 7 projects, same entity/observation counts as before this task.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A scripts/setup-local.sh docker/
git commit -m "Replace docker compose with a plain engine run

podman compose is a shim needing a separate compose binary, and the file
described one service. Volume names keep compose's docker_ prefix -- a
rename would strand the existing graph in a detached volume."
```

---

### Task 5: Consent-gated Podman install

**Files:**
- Modify: `scripts/setup-local.sh` (replace the Task 4 stub)

**Interfaces:**
- Consumes: `resolve_engine` from Task 1.
- Produces: `offer_engine_install()` returning 0 once an engine resolves, 1 otherwise.

Podman has no supported user-local tarball, so Linux needs `sudo`. It is never escalated silently: the exact command is printed and confirmed first.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine-resolve.test.sh`, before the final tally:

```bash
# 8. setup-local.sh must never invoke sudo without an affirmative answer.
#    Shim sudo so any escalation is recorded rather than performed.
SETUP="$REPO_ROOT/scripts/setup-local.sh"
cat >"$SHIM/sudo" <<EOF
#!/usr/bin/env bash
echo "SUDO-CALLED \$*" >>"$SHIM/sudo.log"
exit 0
EOF
chmod +x "$SHIM/sudo"
cat >"$SHIM/apt-get" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SHIM/apt-get"

# CRITICAL: shadow both engines with shims whose `info` FAILS, rather than
# deleting them. setup-local.sh needs coreutils, so /usr/bin must stay on PATH
# -- and /usr/bin/docker is the REAL docker driving the user's live graph. With
# the shims absent, resolve_engine would find it, succeed, and this test would
# start containers and rewrite ~/.claude-neo4j/config.json for real. $SHIM comes
# first on PATH, so these shadow the real binaries and force the no-engine path.
make_shim podman 1
make_shim docker 1
rm -f "$SHIM/sudo.log"

# Declining the prompt must not escalate.
printf 'n\n' | env PATH="$SHIM:/usr/bin:/bin" bash "$SETUP" >/dev/null 2>&1
if [ -f "$SHIM/sudo.log" ]; then
  fail "setup-local.sh ran sudo despite a declined prompt: $(cat "$SHIM/sudo.log")"
else
  pass "declining the install prompt does not escalate"
fi

# Non-interactive (no tty, empty stdin) must not escalate either.
env PATH="$SHIM:/usr/bin:/bin" bash "$SETUP" </dev/null >/dev/null 2>&1
if [ -f "$SHIM/sudo.log" ]; then
  fail "setup-local.sh ran sudo non-interactively: $(cat "$SHIM/sudo.log")"
else
  pass "non-interactive invocation does not escalate"
fi
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/engine-resolve.test.sh`

These two cases pass trivially against the Task 4 stub, which never escalates —
a green result here proves nothing. Confirm the test can actually fail before
trusting it: temporarily add `sudo apt-get install -y podman` as the first line
of the stub's body, re-run, and see both cases report
`setup-local.sh ran sudo...`. Then remove that line.

A test that cannot fail is worse than no test, and this one guards an
irreversible action.

**Before running this at all, verify the shims are in place** (`make_shim docker 1`).
Without them the test drives the real `/usr/bin/docker` against the live graph.

- [ ] **Step 3: Replace the stub with the real installer**

```bash
# Podman has no supported user-local tarball, so Linux installs need sudo.
# It is never escalated silently: print the exact command, then ask.
offer_engine_install() {
  local cmd=""
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 && cmd="brew install podman" ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        cmd="sudo apt-get install -y podman"
      elif command -v dnf >/dev/null 2>&1; then
        cmd="sudo dnf install -y podman"
      elif command -v pacman >/dev/null 2>&1; then
        cmd="sudo pacman -S --noconfirm podman"
      fi ;;
  esac

  if [ -z "$cmd" ]; then
    cat >&2 <<'EOF'
No container engine found, and no supported package manager was detected.

Install Podman (recommended) or Docker by hand, then re-run this script.
  https://podman.io/docs/installation

Or point the plugin at a remote Neo4j instead (e.g. Neo4j Aura's free tier):
  node scripts/configure.mjs --mode remote \
    --uri neo4j+s://xxxxx.databases.neo4j.io \
    --username neo4j --password '...' --database neo4j
EOF
    return 1
  fi

  echo "No container engine found. Podman can be installed with:"
  echo
  echo "    $cmd"
  echo

  # No tty means no consent. Print and stop rather than assume.
  if [ ! -t 0 ]; then
    echo "Not running interactively — run the command above, then re-run this script." >&2
    return 1
  fi

  local reply=""
  read -r -p "Run it now? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Skipped. Run the command above, then re-run this script." >&2; return 1 ;;
  esac

  # shellcheck disable=SC2086
  $cmd || { echo "Install failed. Run '$cmd' by hand and re-check the output." >&2; return 1; }

  if [ "$(uname -s)" = "Darwin" ]; then
    echo "Provisioning the Podman VM (this can take a few minutes)..."
    podman machine init 2>/dev/null || true   # already-initialised is not an error
    podman machine start 2>/dev/null || true
  fi

  resolve_engine || {
    echo "Podman installed but still not usable.$(engine_hint podman)" >&2
    return 1
  }
  return 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/engine-resolve.test.sh`
Expected: PASS — 9 `ok:` lines including both no-escalation cases.

- [ ] **Step 5: Install Podman for real**

Run: `scripts/setup-local.sh`
Expected: since Docker already resolves, the installer never fires and setup proceeds on Docker. To exercise the installer path deliberately:

Run: `CLAUDE_NEO4J_ENGINE=podman scripts/setup-local.sh`
Expected: fails with `podman is not on PATH`. Then install by hand and confirm the version:

```bash
sudo apt-get install -y podman
podman --version   # expect 5.7.x on Ubuntu 26.04
podman info >/dev/null && echo "podman usable"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/setup-local.sh tests/engine-resolve.test.sh
git commit -m "Offer a consent-gated Podman install in setup-local.sh

Podman has no user-local tarball so Linux needs sudo; the exact command is
printed and confirmed first, and a non-interactive run refuses rather than
assuming consent. Tested with a sudo shim that records escalation."
```

---

### Task 6: Opt-in systemd user unit

**Files:**
- Modify: `scripts/setup-local.sh`
- Modify: `scripts/check-health.sh`

**Interfaces:**
- Consumes: `ENGINE` from Task 1.
- Produces: `offer_boot_persistence()`.

> Docker's `restart: unless-stopped` is enforced by a root daemon that starts at boot. **Rootless Podman has no daemon**, so the restart policy only applies while the user's Podman session lives — after a reboot nothing brings the container back. The symptom is the one `CLAUDE.md` records as this project's worst: a session that comes up without memory. This task closes that gap, and `check-health.sh` reports honestly when it was declined.

- [ ] **Step 1: Add the offer to `setup-local.sh`**

Call it after the container is confirmed healthy, before the `configure.mjs` invocation:

```bash
# Rootless Podman is daemonless: --restart only holds while the user's Podman
# session lives, so a reboot leaves the container down and the next Claude
# session memory-less. A systemd *user* unit plus lingering is Podman's answer.
offer_boot_persistence() {
  [ "$ENGINE" = "podman" ] || return 0                 # Docker's daemon already does this
  [ "$(uname -s)" = "Linux" ] || return 0              # macOS: podman machine handles it
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl --user is-enabled claude-neo4j.service >/dev/null 2>&1 && return 0

  cat <<'EOF'

Rootless Podman has no daemon, so this container will NOT come back after a
reboot on its own. A systemd user unit fixes that:

    systemctl --user enable --now claude-neo4j.service
    loginctl enable-linger "$USER"      (so it runs without an active login)

EOF
  if [ ! -t 0 ]; then
    echo "Not interactive — skipping. Re-run this script to be asked again." >&2
    return 0
  fi

  local reply=""
  read -r -p "Install it now? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Skipped. Re-run scripts/setup-local.sh after a reboot, or re-run this to be asked again."; return 0 ;;
  esac

  mkdir -p "$HOME/.config/systemd/user"
  podman generate systemd --name claude-neo4j-memory --restart-policy=always \
    > "$HOME/.config/systemd/user/claude-neo4j.service"
  systemctl --user daemon-reload
  systemctl --user enable --now claude-neo4j.service
  loginctl enable-linger "$USER" 2>/dev/null || \
    echo "Note: 'loginctl enable-linger' failed; the unit starts on login rather than boot." >&2
  echo "Installed. The container will now start at boot."
}

offer_boot_persistence
```

- [ ] **Step 2: Report the gap in `check-health.sh`**

Add as a new check after check 1, so a declined unit is visible rather than inferred:

```bash
# 1b. Rootless Podman needs a systemd user unit to survive a reboot.
if [ "${ENGINE:-}" = "podman" ] && [ "$(uname -s)" = "Linux" ]; then
  if systemctl --user is-enabled claude-neo4j.service >/dev/null 2>&1; then
    pass "boot persistence: systemd user unit enabled"
  else
    fail "boot persistence: no systemd user unit — this container will not survive a reboot (run scripts/setup-local.sh to install one)"
  fi
fi
```

- [ ] **Step 3: Verify**

Podman is installed but not yet serving the graph, so assert only that Docker is unaffected:

Run: `scripts/check-health.sh`
Expected: still 4 `[OK]`, `(engine: docker)`, no boot-persistence check (it is Podman-only).

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/setup-local.sh scripts/check-health.sh
git commit -m "Offer a systemd user unit for rootless Podman boot persistence

Podman is daemonless, so --restart does not survive a reboot -- which would
yield exactly the silent memory-less session this project already knows to
fear. Opt-in, and check-health reports when it was declined."
```

---

### Task 7: Graph fingerprint

**Files:**
- Create: `scripts/fingerprint.sh`

**Interfaces:**
- Consumes: `ENGINE` (set by caller, or resolved internally).
- Produces: `scripts/fingerprint.sh <engine> <container>` printing exactly four lines to stdout:
  `counts=<entities>,<observations>,<relations>` / `entities=<sha256>` / `observations=<sha256>` / `relations=<sha256>` / `schema=<sha256>`.

Counts alone can match while content is wrong, so the hashes are the real check. Queries use the schema as it actually exists: `(:Entity {name, project})`, `(:Observation {id})-[:ABOUT]->(:Entity)`, `(:Entity)-[:RELATES_TO {type}]->(:Entity)`.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Prints a content fingerprint of the graph inside a running container, so the
# same graph can be compared across engines. Counts alone can match while the
# content differs, so every count is paired with a hash of the sorted content.
# Usage: scripts/fingerprint.sh <engine> <container>
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || SCRIPT_DIR=""
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || REPO_ROOT=""
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
  echo "fingerprint.sh: resolved repo root '$REPO_ROOT' is not this repo" >&2
  exit 1
}

ENGINE="${1:?usage: fingerprint.sh <engine> <container>}"
CONTAINER="${2:?usage: fingerprint.sh <engine> <container>}"

set -a; . "$REPO_ROOT/docker/.env"; set +a
: "${NEO4J_USERNAME:=neo4j}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD is not set in docker/.env}"

# Always the in-container port: host mappings differ between the two sides.
q() {
  "$ENGINE" exec -i "$CONTAINER" cypher-shell \
    -a bolt://localhost:7687 -u "$NEO4J_USERNAME" -p "$NEO4J_PASSWORD" \
    -d neo4j --format plain "$1"
}

h() { sha256sum | cut -d' ' -f1; }

counts="$(q '
MATCH (e:Entity) WITH count(e) AS entities
MATCH (o:Observation) WITH entities, count(o) AS observations
RETURN entities + "," + observations + "," + COUNT { ()-[:RELATES_TO]->() }
' | tail -n +2 | tr -d '"[:space:]')"

entities="$(q '
MATCH (e:Entity)
RETURN e.name + "\t" + coalesce(e.project, "") AS row ORDER BY row
' | tail -n +2 | h)"

observations="$(q '
MATCH (o:Observation) RETURN o.id AS row ORDER BY row
' | tail -n +2 | h)"

relations="$(q '
MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
RETURN a.name + "\t" + coalesce(a.project, "") + "\t" + r.type + "\t" +
       b.name + "\t" + coalesce(b.project, "") AS row ORDER BY row
' | tail -n +2 | h)"

# The composite (name, project) constraint and the full-text index memory_search
# runs on are the two pieces a bad import would silently drop.
schema="$( { q 'SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name'
             q 'SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name'; } | h)"

printf 'counts=%s\nentities=%s\nobservations=%s\nrelations=%s\nschema=%s\n' \
  "$counts" "$entities" "$observations" "$relations" "$schema"
```

- [ ] **Step 2: Verify it agrees with `npm run usage`**

```bash
chmod +x scripts/fingerprint.sh
scripts/fingerprint.sh docker claude-neo4j-memory
npm run usage --silent -- --quiet | tail -3
```

Expected: the `counts=` triple matches the `Totals:` line — entities, observations, relations.

- [ ] **Step 3: Verify it is stable**

Run it twice; all five lines must be byte-identical. A differing hash means a query lacks a total order — fix the `ORDER BY` before continuing, because an unstable fingerprint would fail the migration for no reason.

- [ ] **Step 4: Commit**

```bash
git add scripts/fingerprint.sh
git commit -m "Add a graph content fingerprint for migration verification

Counts can match while content differs, so each count is paired with a hash
of sorted content, plus a schema hash covering the composite (name, project)
constraint and the full-text index memory_search depends on."
```

---

### Task 8: The migration script

**Files:**
- Create: `scripts/migrate-to-podman.sh`
- Modify: `package.json` (add `migrate-to-podman`)

**Interfaces:**
- Consumes: `scripts/fingerprint.sh` (Task 7), `resolve_engine`/`container_health` (Task 1), `scripts/backup.sh` (Task 2).
- Produces: nothing consumed by later tasks.

Rehearses on **7688** while Docker keeps 7687, and fails closed: any mismatch leaves Docker running and never takes the port.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# One-shot Docker -> Podman migration for the local memory graph.
#
# Podman cannot see Docker's named volumes (separate storage backends), so the
# graph moves by dump/load. Both sides run the identical neo4j:5-community
# image, so the dump is version-neutral and NEO4J_AUTH sets the new container's
# password on first start.
#
# Nothing here writes to the Docker container or its volume. Until the reclaim
# command printed at the end is run by hand, rollback is always:
#   podman stop claude-neo4j-memory && docker start claude-neo4j-memory
set -euo pipefail

PROG="migrate-to-podman.sh"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || SCRIPT_DIR=""
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || REPO_ROOT=""
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
  echo "$PROG: resolved repo root '$REPO_ROOT' is not this repo" >&2
  exit 1
}
cd "$REPO_ROOT"

CONTAINER="claude-neo4j-memory"
REHEARSAL="claude-neo4j-rehearsal"
IMAGE="neo4j:5-community"
die() { echo "$PROG: $*" >&2; exit 1; }

command -v podman >/dev/null 2>&1 || die "podman is not installed (run scripts/setup-local.sh)"
podman info >/dev/null 2>&1 || die "podman is installed but not usable"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "no Docker container $CONTAINER to migrate from"

set -a; . "$REPO_ROOT/docker/.env"; set +a
: "${NEO4J_USERNAME:=neo4j}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD is not set in docker/.env}"

cleanup_rehearsal() { podman rm -f -v "$REHEARSAL" >/dev/null 2>&1 || true; }
trap cleanup_rehearsal EXIT

# --- Step 1: baseline fingerprint (Docker still serving) --------------------
echo "==> Fingerprinting the live Docker graph..."
docker start "$CONTAINER" >/dev/null 2>&1 || true
BEFORE="$(scripts/fingerprint.sh docker "$CONTAINER")"
echo "$BEFORE" | sed 's/^/    /'

# --- Step 0: safety net, and the migration source ---------------------------
# Same artifact for both roles: what is verified in rehearsal is byte-identical
# to what would be restored in an emergency.
echo "==> Taking a backup (safety net AND migration source)..."
CLAUDE_NEO4J_ENGINE=docker bash scripts/backup.sh
DUMP="$(ls -t "${CLAUDE_NEO4J_BACKUP_DIR:-$HOME/.claude-neo4j/backups}"/*.dump | head -1)"
[ -n "$DUMP" ] || die "backup produced no .dump"
echo "    $DUMP"
( cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256" ) \
  || die "backup checksum failed; refusing to migrate from an unverified dump"

# --- Step 2: rehearse on 7688 (Docker untouched on 7687) --------------------
echo "==> Rehearsing on port 7688..."
podman volume create claude_neo4j_data >/dev/null 2>&1 || true
podman volume create claude_neo4j_logs >/dev/null 2>&1 || true

podman run --rm -i -v claude_neo4j_data:/data "$IMAGE" \
  neo4j-admin database load neo4j --from-stdin --overwrite-destination=true \
  < "$DUMP" || die "load into the Podman volume failed; Docker is untouched"

podman run -d --name "$REHEARSAL" \
  -p 7688:7687 -p 7475:7474 \
  -e NEO4J_AUTH="${NEO4J_USERNAME}/${NEO4J_PASSWORD}" \
  -v claude_neo4j_data:/data -v claude_neo4j_logs:/logs \
  --health-cmd "wget -O /dev/null -q http://localhost:7474 || exit 1" \
  --health-interval 5s --health-timeout 5s --health-retries 30 \
  "$IMAGE" >/dev/null

echo "    waiting for the rehearsal container..."
for _ in $(seq 1 40); do
  s="$(podman inspect -f '{{.State.Health.Status}}' "$REHEARSAL" 2>/dev/null)"
  [ -n "$s" ] || s="$(podman inspect -f '{{.State.Healthcheck.Status}}' "$REHEARSAL" 2>/dev/null)"
  [ "$s" = "healthy" ] && break
  sleep 2
done
[ "${s:-}" = "healthy" ] || die "rehearsal container never became healthy (status: ${s:-unknown}); Docker is untouched"

AFTER="$(scripts/fingerprint.sh podman "$REHEARSAL")"
echo "$AFTER" | sed 's/^/    /'

if [ "$BEFORE" != "$AFTER" ]; then
  echo >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  die "fingerprint mismatch — the Podman copy differs from Docker. Nothing was cut over; Docker is still serving 7687."
fi
echo "    fingerprints match."

# --- Step 3: cut over --------------------------------------------------------
echo "==> Cutting over to Podman on 7687..."
podman rm -f -v "$REHEARSAL" >/dev/null 2>&1 || true
trap - EXIT
docker stop "$CONTAINER" >/dev/null || die "could not stop the Docker container; nothing changed"

podman run -d --name "$CONTAINER" --restart unless-stopped \
  -p "${NEO4J_HTTP_PORT:-7474}:7474" -p "${NEO4J_BOLT_PORT:-7687}:7687" \
  -e NEO4J_AUTH="${NEO4J_USERNAME}/${NEO4J_PASSWORD}" \
  -e NEO4J_dbms_memory_pagecache_size=512M \
  -e NEO4J_server_memory_heap_max__size=512M \
  -v claude_neo4j_data:/data -v claude_neo4j_logs:/logs \
  --health-cmd "wget -O /dev/null -q http://localhost:7474 || exit 1" \
  --health-interval 5s --health-timeout 5s --health-retries 30 \
  "$IMAGE" >/dev/null || {
    echo "$PROG: Podman container failed to start; rolling back to Docker." >&2
    docker start "$CONTAINER" >/dev/null || true
    exit 1
  }

cat <<EOF

Migration complete. Podman now serves the graph on 7687.

  Verify:   scripts/check-health.sh
  Rollback: podman stop $CONTAINER && podman rm $CONTAINER && docker start $CONTAINER

The Docker container and its 544MB volume are untouched. Once you are
satisfied, reclaim that space with:

  docker rm $CONTAINER
  docker volume rm docker_claude_neo4j_data docker_claude_neo4j_logs

Backup kept at: $DUMP
EOF
```

- [ ] **Step 2: Add the npm script**

```json
"migrate-to-podman": "bash scripts/migrate-to-podman.sh",
```

- [ ] **Step 3: Extend the path guard**

In `tests/launcher-path.test.sh:52`, add the two new executable scripts to the loop:

```bash
for script in memory-usage.sh check-health.sh setup-local.sh cypher.sh backup.sh restore.sh fingerprint.sh migrate-to-podman.sh; do
```

Run: `npm test`
Expected: PASS, with two new `ok:` lines for the added scripts.

- [ ] **Step 4: Commit**

```bash
chmod +x scripts/migrate-to-podman.sh
git add scripts/migrate-to-podman.sh package.json tests/launcher-path.test.sh
git commit -m "Add the one-shot Docker->Podman graph migration

Rehearses on 7688 while Docker keeps serving 7687, compares a full content
fingerprint, and fails closed on any mismatch. The backup is both the safety
net and the migration source, so the emergency artifact is the tested one."
```

---

### Task 9: Run the migration and verify

**Files:** none — this is the operational task the whole plan exists for.

**Interfaces:**
- Consumes: everything above.

> Do not start this until Tasks 1–8 are committed and `npm test` is green. This is the only task that touches the live graph.

- [ ] **Step 1: Record the pre-migration state**

```bash
npm run usage --silent -- --quiet | tee /tmp/usage-before.txt
```

Expected: 7 projects. Keep this file — Step 5 diffs against it.

- [ ] **Step 2: Run the migration**

Run: `npm run migrate-to-podman`
Expected: baseline fingerprint, backup + checksum verified, rehearsal healthy, `fingerprints match.`, cutover, the completion banner. On any mismatch it must exit non-zero **with Docker still serving** — if that happens, stop and report; do not hand-fix.

- [ ] **Step 3: Functional proof**

```bash
scripts/check-health.sh
```
Expected: `(engine: podman)`, all checks pass, plus the boot-persistence line reflecting whatever was chosen in Task 6.

```bash
npm run usage --silent -- --quiet | diff /tmp/usage-before.txt - && echo "usage identical"
```
Expected: no diff.

Both full-text indexes `memory_search` depends on (`graph.js:185`, `:191`) must
have survived. This is the one thing counts cannot detect:

```bash
scripts/cypher.sh "CALL db.index.fulltext.queryNodes('entityNameFulltext', 'plugin') YIELD node RETURN count(node) AS hits"
scripts/cypher.sh "CALL db.index.fulltext.queryNodes('observationTextFulltext', 'podman') YIELD node RETURN count(node) AS hits"
```
Expected: a number from each, not an error. `Failed to invoke procedure ... there is no such fulltext schema index` means the index did not come across and the migration must be rolled back.

- [ ] **Step 4: Prove the engine-specific backup path**

The one verb with a plausible engine difference is `run --rm --volumes-from` under rootless Podman.

```bash
npm run backup
npm run backup -- --info "$(ls -t ~/.claude-neo4j/backups/*.dump | head -1)"
```
Expected: a new dump written and its metadata read back, exit 0 both times.

- [ ] **Step 5: Round-trip a real write through MCP**

In a fresh Claude session launched with `scripts/claude-with-memory.sh`, confirm the `SessionStart` banner appears, then `memory_search` for a known term and add one throwaway observation and read it back.

Then delete it — test data is deleted after verification, every time:

```bash
scripts/cypher.sh "MATCH (o:Observation) WHERE o.text CONTAINS '<throwaway marker>' DETACH DELETE o"
```

- [ ] **Step 6: Regression gates**

```bash
npm test
npm run token-cost
```
Expected: both pass. `token-cost` should be flat — no read-path shapes changed, so movement means something unintended happened.

- [ ] **Step 7: Reboot proof**

This is the regression Task 6 exists for, and the only way to know it works:

```bash
sudo reboot
# after logging back in, WITHOUT running anything else:
podman ps --filter name=claude-neo4j-memory
scripts/check-health.sh
```

Expected, if the systemd unit was installed: the container is already running and health passes. If it was declined: the container is down and `check-health.sh` says so explicitly rather than failing obscurely.

- [ ] **Step 8: Commit nothing, report**

No code changes here. Report the verification output, and leave the Docker container and volume in place — the user reclaims that space themselves.

---

### Task 10: Documentation and version bump

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`
- Modify: `.claude-plugin/plugin.json`, `package.json` (version)

- [ ] **Step 1: Update `.claude-plugin/plugin.json`**

The `description` currently reads "Runs against a local Docker container by default". Change to "Runs against a local Podman or Docker container by default". Bump `version` from `0.3.1` to `0.4.0` — a new engine and a new migration path is a minor bump, not a patch.

- [ ] **Step 2: Match `package.json`**

Set `version` to `0.4.0`. Per `CLAUDE.md` these must stay in lockstep, and an unbumped version means other projects silently keep the old marketplace snapshot.

- [ ] **Step 3: Update `CLAUDE.md`**

In **Environment**, replace the `docker/docker-compose.yml` reference: the container is now created by `scripts/setup-local.sh` and runs under Podman or Docker.

Add to **Design decisions and traps**:

```markdown
- **Podman and Docker are both supported; `scripts/lib-engine.sh` picks one.**
  Podman is preferred (daemonless, rootless, no licensing), Docker is the
  fallback, `CLAUDE_NEO4J_ENGINE` pins either. Podman **cannot see Docker's
  named volumes** — separate storage backends — so switching engines moves data
  by dump/load, not by pointing at the same volume.
- **The container volumes are still named `docker_claude_neo4j_data`/`_logs`.**
  Compose created them with its directory as a prefix; `setup-local.sh` now uses
  a plain `run` but keeps the literal names. Renaming them strands the existing
  graph in a detached volume and yields a silently empty database.
- **Container healthcheck state lives at a different path per engine.**
  `.State.Health.Status` vs `.State.Healthcheck.Status`, and `inspect` returns
  an *empty string* rather than an error for a template matching nothing — so a
  wrong guess reads as "not healthy yet" and silently burns the retry loop.
  `container_health` in `lib-engine.sh` tries both.
- **Rootless Podman does not survive a reboot.** No daemon means `--restart`
  only holds while the user's Podman session lives. `setup-local.sh` offers a
  systemd user unit plus `loginctl enable-linger`; `check-health.sh` reports
  when it was declined. This is the one behavioural regression against Docker.
```

- [ ] **Step 4: Update `README.md`**

Replace Docker-specific setup instructions with engine-neutral wording, note that `setup-local.sh` can install Podman with consent, and document `CLAUDE_NEO4J_ENGINE`.

- [ ] **Step 5: Update `CHANGELOG.md`**

```markdown
## 0.4.0

- Local mode now runs under Podman or Docker. `scripts/lib-engine.sh` resolves
  the engine, preferring Podman; `CLAUDE_NEO4J_ENGINE` pins either. Existing
  Docker installs keep working with no action required.
- `scripts/setup-local.sh` replaces `docker compose` with a plain `run`, and can
  install Podman after an explicit prompt. `docker/docker-compose.yml` is gone;
  `docker/.env` keeps its path.
- `npm run migrate-to-podman` moves an existing graph from Docker to Podman by
  dump/load, rehearsing on port 7688 and failing closed on any content
  mismatch. Nothing is destroyed; the reclaim command is printed.
- Rootless Podman is daemonless, so the container does not restart after a
  reboot unless the offered systemd user unit is installed. `check-health.sh`
  reports this.
```

- [ ] **Step 6: Verify and commit**

Run: `npm test && scripts/check-health.sh`
Expected: both pass.

```bash
git add README.md CLAUDE.md CHANGELOG.md .claude-plugin/plugin.json package.json
git commit -m "Document Podman support and bump to 0.4.0

Records the traps found implementing it: Podman cannot see Docker's volumes,
the compose-prefixed volume names must survive, healthcheck state lives at a
different inspect path per engine, and rootless Podman needs a systemd user
unit to survive a reboot."
```

---

## Self-Review

**Spec coverage:**

| spec requirement | task |
| --- | --- |
| `$ENGINE` resolution preferring Podman, `CLAUDE_NEO4J_ENGINE` override | 1 |
| `lib-backup.sh` / `backup.sh` / `restore.sh` conversion | 2 |
| `cypher.sh` / `check-health.sh` conversion, report resolved engine | 3 |
| Compose replaced by `$ENGINE run`; `docker-compose.yml` deleted | 4 |
| `docker/.env` path kept deliberately | 4 (and `CLAUDE.md`, Task 10) |
| Consent-gated Podman install, never silent `sudo`, non-interactive refuses | 5 |
| macOS `podman machine init/start` | 5 |
| Opt-in systemd user unit + lingering; declined state reported | 6 |
| 3-part fingerprint incl. constraints/indexes | 7 |
| Step 0 backup as both safety net and migration source | 8 |
| Rehearse on 7688, fail closed, Docker untouched | 8 |
| Rollback path | 8 (banner), 9 (Step 2 on failure) |
| Functional proof: check-health, full-text search, write/read-back | 9 |
| `--volumes-from` under rootless Podman | 9 Step 4 |
| Test data deleted after verification | 9 Step 5 |
| `npm test` + `npm run token-cost` flat | 9 Step 6 |
| `launcher-path.test.sh` extended to new scripts | 8 Step 3 |
| Version bump + docs | 10 |

No gaps.

**Placeholder scan:** No TBD/TODO. Every code step carries real code; every verification step names a command and its expected output. The one deliberately deferred item is the Task 4 `offer_engine_install` stub, which Task 5 replaces — flagged inline in both.

**Type consistency:** `resolve_engine`/`ENGINE`/`container_health`/`engine_hint` (Task 1) are used under those exact names in Tasks 2, 3, 4, 6, 8. `require_docker` → `require_engine` renamed at both call sites (Task 2 Step 3). `start_container` (Task 4) and `offer_engine_install` (Tasks 4/5) and `offer_boot_persistence` (Task 6) are each defined once and called once. `fingerprint.sh <engine> <container>` is invoked with that signature in Task 8 twice and Task 7's verification. Volume literals `docker_claude_neo4j_data`/`_logs` (Docker side, Task 4) and `claude_neo4j_data`/`_logs` (Podman side, Task 8) are deliberately different — that asymmetry is the migration, not a typo.

All schema identifiers are read from the code, not inferred: `:Entity{name,project}`, `:Observation{id}`, `:RELATES_TO{type}`, `:ABOUT` (`graph.js`, `memory-usage.sh:78`), and the two full-text indexes `entityNameFulltext` / `observationTextFulltext` (`graph.js:185`, `:191`). An earlier draft guessed the index name as `observationText` and was wrong — worth remembering that the index names are not derivable from the property names.
