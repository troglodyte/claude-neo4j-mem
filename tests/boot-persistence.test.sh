#!/usr/bin/env bash
# What brings claude-neo4j-memory back after a reboot depends on the platform
# as well as the engine, and the failure mode of getting it wrong is advice
# that silently does nothing rather than an error -- setup-local.sh's systemd
# path returns early on Darwin, so every script that told a Mac user to run it
# "to persist across reboots" was pointing at a no-op. These cases pin the
# mapping and, specifically, that the macOS hint names `podman machine start`.
#
# A `uname` shim on PATH stands in for the platform, so all four combinations
# run on any host -- same technique as engine-resolve.test.sh.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && cd .. && pwd -P)"
LIB="$REPO_ROOT/scripts/lib-engine.sh"

SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT

# Absolute, because the shim's shebang cannot rely on `env` finding bash.
BASH_BIN="$(command -v bash)"

failures=0
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }
pass() { printf 'ok: %s\n' "$1"; }

# Answers whatever $FAKE_UNAME says. Only `uname -s` is ever called, so the
# arguments are ignored deliberately.
cat >"$SHIM/uname" <<EOF
#!$BASH_BIN
printf '%s\n' "\${FAKE_UNAME:-Linux}"
EOF
chmod +x "$SHIM/uname"

# $1 = engine ("" for unset), $2 = platform, $3... = function to call.
in_env() {
  local engine="$1" platform="$2"; shift 2
  if [ -z "$engine" ]; then
    env -u ENGINE PATH="$SHIM:$PATH" FAKE_UNAME="$platform" \
      "$BASH_BIN" -c ". \"$LIB\"; $*"
  else
    env PATH="$SHIM:$PATH" ENGINE="$engine" FAKE_UNAME="$platform" \
      "$BASH_BIN" -c ". \"$LIB\"; $*"
  fi
}

check_kind() {
  local engine="$1" platform="$2" want="$3" got
  got="$(in_env "$engine" "$platform" boot_persistence_kind)"
  local label="kind: ENGINE='${engine:-<unset>}' on $platform -> $want"
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label (got '$got')"; fi
}

check_kind podman Linux   systemd
check_kind podman Darwin  launchagent
check_kind podman FreeBSD none
# Docker's daemon handles restarts itself, on every platform -- the platform
# must not be consulted at all.
check_kind docker Linux   docker
check_kind docker Darwin  docker
# No resolved engine must not be reported as Docker's "nothing to do".
check_kind ""     Linux   none

# The regression this file exists for: the macOS hint has to name the command
# that actually fixes an offline graph there.
hint="$(in_env podman Darwin boot_persistence_hint)"
case "$hint" in
  *"podman machine start"*) pass "macOS hint names 'podman machine start'" ;;
  *) fail "macOS hint omits 'podman machine start' (got: $hint)" ;;
esac
case "$hint" in
  *systemd*) fail "macOS hint mentions systemd, which does not exist there (got: $hint)" ;;
  *) pass "macOS hint does not mention systemd" ;;
esac

hint_linux="$(in_env podman Linux boot_persistence_hint)"
case "$hint_linux" in
  *systemd*) pass "Linux hint names the systemd unit" ;;
  *) fail "Linux hint omits systemd (got: $hint_linux)" ;;
esac

# 2 = "nothing to install on this platform", which is what keeps a Docker host
# from ever being prompted or failed for a missing systemd unit. It must not
# be confused with 1 ("missing").
for platform in Linux Darwin; do
  in_env docker "$platform" boot_persistence_installed
  rc=$?
  if [ "$rc" -eq 2 ]; then
    pass "installed: Docker on $platform reports 'nothing to install' (2)"
  else
    fail "installed: Docker on $platform returned $rc, expected 2"
  fi
done

in_env podman FreeBSD boot_persistence_installed
rc=$?
if [ "$rc" -eq 2 ]; then
  pass "installed: unknown platform reports 'nothing to install' (2)"
else
  fail "installed: unknown platform returned $rc, expected 2"
fi

if [ "$failures" -eq 0 ]; then
  echo "boot-persistence: all checks passed"
  exit 0
fi
echo "boot-persistence: $failures check(s) failed"
exit 1
