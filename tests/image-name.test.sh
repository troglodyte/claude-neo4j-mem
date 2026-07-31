#!/usr/bin/env bash
# Every container image these scripts name must be fully qualified.
#
# Docker silently expands a short name like "neo4j:5-community" to
# docker.io/library/neo4j:5-community. Podman deliberately does not: with no
# `unqualified-search-registries` in /etc/containers/registries.conf -- the
# default on Debian and Ubuntu -- it refuses with
#
#   Error: short-name "neo4j:5-community" did not resolve to an alias and no
#   unqualified-search registries are defined
#
# so setup-local.sh, migrate-to-podman.sh and the backup/restore sidecars all
# fail on a stock Podman host while working perfectly under Docker. The trap is
# that common images (alpine, nginx) ARE shipped as short-name aliases in
# registries.conf.d/shortnames.conf, so a smoke test with one of those passes
# and hides the problem. neo4j has no such alias.
#
# Fully-qualified names work identically under Docker, so one spelling serves
# both engines and there is no reason for a short name to appear at all.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && cd .. && pwd -P)"

failures=0
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }
pass() { printf 'ok: %s\n' "$1"; }

# Matches an image reference like "neo4j:5-community" only when it is NOT
# already preceded by a registry path component. The leading character class
# excludes "/", so docker.io/library/neo4j:5-community does not match, while a
# bare occurrence after a space, quote or line start does. Deliberately narrow
# to `neo4j:<digit>` so the container name (claude-neo4j-memory), the volume
# names (claude_neo4j_data) and bolt URIs (neo4j://, neo4j+s://) can't trip it.
offenders="$(grep -rnE '(^|[^/[:alnum:]._-])neo4j:[0-9]' "$REPO_ROOT"/scripts/*.sh 2>/dev/null || true)"

if [ -z "$offenders" ]; then
  pass "no unqualified neo4j image reference in scripts/*.sh"
else
  fail "unqualified image name(s) - Podman cannot resolve these:"$'\n'"$offenders"
fi

# Complement: the regex above must actually be capable of firing, or this file
# would pass forever against any spelling at all.
probe="$(printf '%s\n' '  "$ENGINE" run --rm neo4j:5-community' \
  | grep -cE '(^|[^/[:alnum:]._-])neo4j:[0-9]')"
if [ "$probe" = "1" ]; then
  pass "the short-name pattern matches a short name when one is present"
else
  fail "the short-name pattern is inert; it would never catch a regression"
fi

# ...and must not fire on the qualified form, or the only way to pass would be
# to stop naming the image entirely.
probe_ok="$(printf '%s\n' '  "$ENGINE" run --rm docker.io/library/neo4j:5-community' \
  | grep -cE '(^|[^/[:alnum:]._-])neo4j:[0-9]' || true)"
if [ "$probe_ok" = "0" ]; then
  pass "the short-name pattern ignores a fully-qualified name"
else
  fail "the short-name pattern flags the qualified form too; it cannot be satisfied"
fi

((failures == 0)) || { printf '\n%d check(s) failed\n' "$failures"; exit 1; }
printf '\nall checks passed\n'
