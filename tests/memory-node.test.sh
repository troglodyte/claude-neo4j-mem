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
