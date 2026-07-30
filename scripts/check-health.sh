#!/usr/bin/env bash
# Verifies the whole neo4j-memory plugin stack end to end: container
# health, plugin config file, Neo4j auth/connectivity, and the MCP server's
# JSON-RPC handshake. Prints PASS/FAIL per check and exits non-zero if any fail.
# Usage: scripts/check-health.sh
set -uo pipefail

# Resolved in two steps and checked: as a single `cd "$(dirname X)/.."` this
# degrades to "/" when the substitution yields nothing, and set -e can't see it.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
  echo "check-health.sh: resolved repo root '$REPO_ROOT' is not this repo" >&2
  exit 1
}
cd "$REPO_ROOT"
# shellcheck source=scripts/lib-engine.sh
. "$SCRIPT_DIR/lib-engine.sh"

FAILURES=0

pass() { echo "[OK]   $1"; }
fail() { echo "[FAIL] $1"; FAILURES=$((FAILURES + 1)); }

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

# 1b. Rootless Podman needs a systemd user unit to survive a reboot.
if [ "${ENGINE:-}" = "podman" ] && [ "$(uname -s)" = "Linux" ]; then
  if systemctl --user is-enabled claude-neo4j.service >/dev/null 2>&1; then
    pass "boot persistence: systemd user unit enabled"
  else
    fail "boot persistence: no systemd user unit — this container will not survive a reboot (run scripts/setup-local.sh to install one)"
  fi
fi

# 2. Plugin config file present and loadable
CONFIG_CHECK="$(node -e "
import('./src/lib/config.js').then(({ loadConnectionConfig }) => {
  try {
    const cfg = loadConnectionConfig();
    console.log('OK ' + cfg.mode + ' ' + cfg.uri);
  } catch (e) {
    console.log('FAIL ' + e.message);
  }
});
" 2>&1)"
if [[ "$CONFIG_CHECK" == OK* ]]; then
  pass "plugin config loads (${CONFIG_CHECK#OK }; ~/.claude-neo4j/config.json)"
else
  fail "plugin config: ${CONFIG_CHECK#FAIL }"
fi

# 3. Neo4j connectivity + auth (actually opens a bolt session)
CONN_CHECK="$(node -e "
import('./src/lib/neo4jClient.js').then(async (m) => {
  try {
    await m.verifyConnectivity();
    console.log('OK');
  } catch (e) {
    console.log('FAIL ' + (e.code || e.name) + ': ' + e.message.split('\n')[0]);
  } finally {
    await m.closeDriver();
    process.exit(0);
  }
});
" 2>&1)"
if [[ "$CONN_CHECK" == OK* ]]; then
  pass "Neo4j bolt connection + auth succeed"
else
  fail "Neo4j connectivity: ${CONN_CHECK#FAIL }"
fi

# 4. MCP server process starts and completes the JSON-RPC initialize handshake
MCP_CHECK="$(timeout 8 node -e "
import('node:child_process').then(({ spawn }) => {
  const proc = spawn('node', ['src/mcp/server.js'], { cwd: process.cwd() });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  const req = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check-health', version: '1.0' } },
  }) + '\n';
  proc.stdin.write(req);
  setTimeout(() => {
    proc.kill();
    try {
      const parsed = JSON.parse(out.trim().split('\n')[0]);
      if (parsed.result?.serverInfo?.name === 'neo4j-memory') {
        console.log('OK');
      } else {
        console.log('FAIL unexpected response: ' + out.trim());
      }
    } catch {
      console.log('FAIL no valid JSON-RPC response. stdout=' + out.trim() + ' stderr=' + err.trim());
    }
  }, 3000);
});
" 2>&1)"
if [[ "$MCP_CHECK" == OK* ]]; then
  pass "MCP server starts and completes initialize handshake"
else
  fail "MCP server handshake: ${MCP_CHECK#FAIL }"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All checks passed."
  exit 0
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
