#!/usr/bin/env bash
# Guards scripts/claude-with-memory.sh against silently resolving the plugin
# directory to "/". Claude Code accepts `--plugin-dir /` without complaint, so
# the failure mode is a session that looks normal but has no memory plugin --
# exactly what happened on 2026-07-21. The launcher must refuse instead.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && cd .. && pwd -P)"
LAUNCHER="$REPO_ROOT/scripts/claude-with-memory.sh"

SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@"\n' >"$SHIM/claude"
chmod +x "$SHIM/claude"

failures=0
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }
pass() { printf 'ok: %s\n' "$1"; }

# 1. A normal invocation hands claude this repo's root.
out="$(PATH="$SHIM:$PATH" bash "$LAUNCHER" 2>/dev/null)"
if [[ $out == "--plugin-dir"$'\n'"$REPO_ROOT" ]]; then
  pass "normal invocation passes the repo root"
else
  fail "normal invocation passed: ${out//$'\n'/ }"
fi

# 2. When the path computation misbehaves, the launcher must exit non-zero
#    rather than degrade to "/". `dirname` failing is one reproducer; the guard
#    needs to cover any cause, so it should assert on the resolved root.
printf '#!/usr/bin/env bash\nexit 127\n' >"$SHIM/dirname"
chmod +x "$SHIM/dirname"
out="$(PATH="$SHIM:$PATH" bash "$LAUNCHER" 2>&1)"
rc=$?
rm -f "$SHIM/dirname"

if [[ $out == *"--plugin-dir"$'\n'"/"* ]]; then
  fail "launched claude with --plugin-dir / (root cause of the silent no-memory session)"
elif ((rc == 0)); then
  fail "exited 0 despite failing to resolve the repo root"
elif [[ $out != *"is not this repo"* ]]; then
  fail "refused, but without the explanatory message: ${out//$'\n'/ }"
else
  pass "refuses to launch when the repo root cannot be resolved"
fi

# 3. The other scripts share the same path computation. They fail less
#    dangerously (no silent wrong behaviour, just confusing errors) but must
#    still refuse rather than operate on a bogus root.
printf '#!/usr/bin/env bash\nexit 127\n' >"$SHIM/dirname"
chmod +x "$SHIM/dirname"
for script in memory-usage.sh check-health.sh setup-local.sh cypher.sh; do
  out="$(PATH="$SHIM:$PATH" bash "$REPO_ROOT/scripts/$script" 2>&1)"
  rc=$?
  if ((rc != 0)) && [[ $out == *"is not this repo"* ]]; then
    pass "$script refuses an unresolvable repo root"
  else
    fail "$script exited $rc: ${out//$'\n'/ }"
  fi
done
rm -f "$SHIM/dirname"

((failures == 0)) || { printf '\n%d check(s) failed\n' "$failures"; exit 1; }
printf '\nall checks passed\n'
