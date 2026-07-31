#!/usr/bin/env bash
# resolve_engine must follow the graph, not a fixed preference: whichever
# engine is actually running claude-neo4j-memory wins, because picking the
# other one hands the caller a different (usually empty or stale) database
# with no error. Only when that says nothing does the static docker-then-podman
# order decide. It must also honour an explicit override and refuse anything
# else. Uses PATH shims so no engine is required to run these -- same technique
# as launcher-path.test.sh.
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

# A shim that succeeds or fails `info` on demand, reports whether it has a
# claude-neo4j-memory container and whether that container is running, and
# echoes itself for any other verb. Defaults are "usable engine, no container",
# which is what the pre-existing cases below assume.
#
# Shebang is the resolved absolute path, not "#!/usr/bin/env bash": once
# try_resolve narrows PATH to $SHIM alone (see above), `env` inside a
# "/usr/bin/env bash" shebang would fail to find bash the same way the outer
# invocation would have.
make_shim() {
  local name="$1" info_rc="$2" inspect_rc="${3:-1}" running="${4:-false}"
  cat >"$SHIM/$name" <<EOF
#!$BASH_BIN
if [ "\$1" = "info" ]; then exit $info_rc; fi
if [ "\$1" = "inspect" ]; then
  [ $inspect_rc -eq 0 ] || exit $inspect_rc
  # Answer the -f '{{.State.Running}}' form; a bare inspect just succeeds.
  for arg in "\$@"; do
    if [ "\$arg" = '{{.State.Running}}' ]; then printf '%s\n' "$running"; exit 0; fi
  done
  exit 0
fi
printf '%s %s\n' "$name" "\$*"
EOF
  chmod +x "$SHIM/$name"
}

# Readable aliases for make_shim's container arguments.
NO_CONTAINER=(1 false)
STOPPED_CONTAINER=(0 false)
RUNNING_CONTAINER=(0 true)

# Run resolve_engine in a subshell with a controlled PATH, echo the result.
try_resolve() {
  env PATH="$SHIM" CLAUDE_NEO4J_ENGINE="${1:-}" "$BASH_BIN" -c '
    source "$0" || exit 9
    if resolve_engine; then printf "%s\n" "$ENGINE"; else printf "ERR:%s\n" "$?"; fi
  ' "$LIB" 2>/dev/null
}

# 1. Both usable, neither holding the graph -> the static order picks podman.
#    Nothing is at stake in this case (there is no graph on either side yet),
#    so the better engine to start on wins: daemonless, rootless, no licensing.
#    The cases below are what keep this from touching anyone who already has a
#    container -- the tie-break only ever decides a fresh machine.
make_shim podman 0 "${NO_CONTAINER[@]}"; make_shim docker 0 "${NO_CONTAINER[@]}"
[ "$(try_resolve)" = "podman" ] && pass "prefers podman when both work and neither has the container" \
  || fail "expected podman, got: $(try_resolve)"

# 1a. Podman is holding the graph -> podman, despite docker being preferred.
#     This is the post-migration machine. Answering "docker" here would point
#     every script at the pre-migration volume, which still exists (the
#     migration stops that container but never deletes it) and would read as a
#     working database that has silently lost every observation since.
make_shim podman 0 "${RUNNING_CONTAINER[@]}"; make_shim docker 0 "${NO_CONTAINER[@]}"
[ "$(try_resolve)" = "podman" ] && pass "follows the graph to podman when it holds the container" \
  || fail "expected podman, got: $(try_resolve)"

# 1b. Both engines have a container named claude-neo4j-memory -- exactly what
#     the migration leaves behind, since Docker's is kept stopped for rollback.
#     Presence alone cannot separate them; running state can.
make_shim podman 0 "${RUNNING_CONTAINER[@]}"; make_shim docker 0 "${STOPPED_CONTAINER[@]}"
[ "$(try_resolve)" = "podman" ] && pass "prefers the running container when both engines have one" \
  || fail "expected podman, got: $(try_resolve)"

# 1c. The same test in the other direction, so a rule that just hardcodes
#     podman-when-both would not pass. Rolled back to Docker: Docker runs, the
#     Podman container is stopped but still present.
make_shim podman 0 "${STOPPED_CONTAINER[@]}"; make_shim docker 0 "${RUNNING_CONTAINER[@]}"
[ "$(try_resolve)" = "docker" ] && pass "follows a running container back to docker after a rollback" \
  || fail "expected docker, got: $(try_resolve)"

# 1d. Neither container runs, but only podman has one. Stopped is still where
#     the data is; starting a fresh container on the other engine would create
#     an empty volume instead.
make_shim podman 0 "${STOPPED_CONTAINER[@]}"; make_shim docker 0 "${NO_CONTAINER[@]}"
[ "$(try_resolve)" = "podman" ] && pass "prefers a stopped container over no container at all" \
  || fail "expected podman, got: $(try_resolve)"

# 1e. Container probing must never override an unusable engine: podman holds
#     the graph but its `info` fails, so docker is the only thing that can run.
make_shim podman 1 "${RUNNING_CONTAINER[@]}"; make_shim docker 0 "${NO_CONTAINER[@]}"
[ "$(try_resolve)" = "docker" ] && pass "does not pick an unusable engine just because it holds the container" \
  || fail "expected docker, got: $(try_resolve)"

# 1f. Docker absent entirely -> podman, container or not.
rm -f "$SHIM/docker"; make_shim podman 0 "${NO_CONTAINER[@]}"
[ "$(try_resolve)" = "podman" ] && pass "falls back to podman when docker is absent" \
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

# Piped stdin is not a tty, so this is deflected by the `[ ! -t 0 ]` guard
# before `read` ever runs -- it does NOT exercise the decline arm of the
# `case` (see the pty-backed cases below for that). It still must not escalate.
printf 'n\n' | env PATH="$SHIM:/usr/bin:/bin" bash "$SETUP" >/dev/null 2>&1
if [ -f "$SHIM/sudo.log" ]; then
  fail "setup-local.sh ran sudo with piped (non-tty) stdin: $(cat "$SHIM/sudo.log")"
else
  pass "piped, non-tty stdin does not escalate (caught by the no-tty guard)"
fi

# Non-interactive (no tty, empty stdin) must not escalate either.
rm -f "$SHIM/sudo.log"
env PATH="$SHIM:/usr/bin:/bin" bash "$SETUP" </dev/null >/dev/null 2>&1
if [ -f "$SHIM/sudo.log" ]; then
  fail "setup-local.sh ran sudo non-interactively: $(cat "$SHIM/sudo.log")"
else
  pass "non-interactive invocation does not escalate"
fi

# The two cases above both go through the no-tty guard at `[ ! -t 0 ]` and
# never reach the `read`/`case` at all -- a reordered or widened `case` could
# not be caught by them. Drive a real pty (via `script`, which forkpty()s a
# child) so the answer actually reaches `read -r -p` and the case arms below.
rm -f "$SHIM/sudo.log"
printf 'n\n' | script -qec "env PATH=\"$SHIM:/usr/bin:/bin\" $BASH_BIN \"$SETUP\"" /dev/null >/dev/null 2>&1
if [ -f "$SHIM/sudo.log" ]; then
  fail "setup-local.sh ran sudo despite an interactive (pty) decline: $(cat "$SHIM/sudo.log")"
else
  pass "an interactive (pty) decline does not escalate"
fi

# Complement of the case above: without this, a `case` that always fell
# through to the refusal arm would pass every escalation test above while
# being completely broken. Confirms "y" actually reaches sudo (via the
# recording shim -- nothing is really installed, and the engine shims still
# fail `info` afterwards so resolve_engine still reports failure).
rm -f "$SHIM/sudo.log"
printf 'y\n' | script -qec "env PATH=\"$SHIM:/usr/bin:/bin\" $BASH_BIN \"$SETUP\"" /dev/null >/dev/null 2>&1
if [ -f "$SHIM/sudo.log" ] && grep -q 'apt-get' "$SHIM/sudo.log"; then
  pass "an interactive (pty) accept does escalate via the recording shim"
else
  fail "setup-local.sh did not invoke sudo apt-get after an interactive (pty) accept"
fi

((failures == 0)) || { printf '\n%d check(s) failed\n' "$failures"; exit 1; }
printf '\nall checks passed\n'
