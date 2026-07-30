#!/usr/bin/env bash
# resolve_engine must prefer podman, fall back to docker, honour an explicit
# override, and refuse anything else. Uses PATH shims so no engine is required
# to run these -- same technique as launcher-path.test.sh.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && cd .. && pwd -P)"
LIB="$REPO_ROOT/scripts/lib-engine.sh"

SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT

# Resolved before PATH is narrowed to $SHIM below: try_resolve sets PATH to
# the shim dir *only* (not "$SHIM:$PATH") so a removed shim reads as a truly
# absent engine even on a host with a real docker/podman on the system PATH --
# this repo's dev machine has /usr/bin/docker, and leaking it in would make
# the "absent" cases below false-pass against the real binary. `env` execs
# its command by searching the PATH it is about to install, so the bare word
# "bash" would no longer resolve once that PATH is only $SHIM; capture the
# absolute path first so the subshell can still be started.
BASH_BIN="$(command -v bash)"

failures=0
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }
pass() { printf 'ok: %s\n' "$1"; }

# A shim that succeeds or fails `info` on demand; any other verb echoes itself.
# Shebang is the resolved absolute path, not "#!/usr/bin/env bash": once
# try_resolve narrows PATH to $SHIM alone (see above), `env` inside a
# "/usr/bin/env bash" shebang would fail to find bash the same way the outer
# invocation would have.
make_shim() {
  local name="$1" info_rc="$2"
  cat >"$SHIM/$name" <<EOF
#!$BASH_BIN
if [ "\$1" = "info" ]; then exit $info_rc; fi
printf '%s %s\n' "$name" "\$*"
EOF
  chmod +x "$SHIM/$name"
}

# Run resolve_engine in a subshell with a controlled PATH, echo the result.
try_resolve() {
  env PATH="$SHIM" CLAUDE_NEO4J_ENGINE="${1:-}" "$BASH_BIN" -c '
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

((failures == 0)) || { printf '\n%d check(s) failed\n' "$failures"; exit 1; }
printf '\nall checks passed\n'
