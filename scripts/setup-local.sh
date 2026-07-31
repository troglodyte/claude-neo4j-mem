#!/usr/bin/env bash
# One-command local setup: resolves a container engine (Podman preferred,
# Docker fallback), generates docker/.env if missing, starts/waits for the
# Neo4j container, then configures the plugin against it. Safe to re-run any
# time (idempotent).
# Usage: ./scripts/setup-local.sh   (or from repo root: scripts/setup-local.sh)
set -euo pipefail

# Resolved in two steps and checked: as a single `cd "$(dirname X)/.."` this
# degrades to "/" when the substitution yields nothing, and set -e can't see it.
# The `|| =""` keeps set -e from aborting here with a bare "cd: null directory",
# so the explanatory check below is what the user actually sees.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || SCRIPT_DIR=""
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)" || REPO_ROOT=""
[ -f "$REPO_ROOT/.claude-plugin/plugin.json" ] || {
  echo "setup-local.sh: resolved repo root '$REPO_ROOT' is not this repo" >&2
  exit 1
}
cd "$REPO_ROOT"

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

# A stopped `podman machine` is by far the commonest macOS failure here, and
# it is not a missing engine: podman is installed and on PATH, `podman info`
# just fails while the VM is down -- which is exactly the state a reboot
# leaves behind. Without this branch the script announced "No container engine
# found" and offered to brew-install a podman that was already there, at the
# precise moment the real answer was one command. Returns 0 if the engine is
# usable afterwards, 1 to fall through to the install offer.
offer_machine_start() {
  [ "$(uname -s)" = "Darwin" ] || return 1
  command -v podman >/dev/null 2>&1 || return 1

  echo "Podman is installed, but its VM is not running — macOS runs the"
  echo "container inside podman-machine-default, and a reboot leaves it down."
  echo
  echo "    podman machine start"
  echo

  if [ ! -t 0 ]; then
    echo "Not running interactively — run the command above, then re-run this script." >&2
    return 1
  fi

  local reply=""
  read -r -p "Start it now? [Y/n] " reply || reply=""
  case "$reply" in
    [nN]|[nN][oO]) echo "Skipped. Run the command above, then re-run this script." >&2; return 1 ;;
  esac

  echo "Starting the Podman VM (a first-ever init can take a few minutes)..."
  podman machine init 2>/dev/null || true    # already-initialised is not an error
  podman machine start 2>/dev/null || true
  resolve_engine || return 1
  return 0
}

# shellcheck source=scripts/lib-engine.sh
. "$REPO_ROOT/scripts/lib-engine.sh"

if ! resolve_engine; then
  offer_machine_start || offer_engine_install || exit 1
fi
echo "Using container engine: $ENGINE"

ENV_FILE="docker/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE yet — generating one with a random password."
  cp docker/.env.example "$ENV_FILE"
  if command -v openssl >/dev/null 2>&1; then
    generated_password="$(openssl rand -hex 16)"
  else
    generated_password="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  # Portable in-place edit: write to a temp file, then replace (macOS `sed -i`
  # requires a backup-suffix arg; this form works the same on both GNU and BSD sed).
  sed "s/^NEO4J_PASSWORD=.*/NEO4J_PASSWORD=${generated_password}/" "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

: "${NEO4J_USERNAME:=neo4j}"
: "${NEO4J_BOLT_PORT:=7687}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD is not set in docker/.env}"

# Volume names differ by engine, deliberately. Docker's were created by
# compose with its directory name as a prefix ("docker_..."); renaming them
# would strand the existing graph in a detached volume and hand the user a
# silently empty database, so that spelling is permanent for Docker. Podman
# never saw compose — migrate-to-podman.sh creates its volumes fresh, under
# the plain unprefixed name — so matching that here is what lets this script
# find a migrated graph instead of Podman auto-creating an empty volume with
# the Docker-shaped name (see the guard below).
if [ "$ENGINE" = "podman" ]; then
  DATA_VOLUME="claude_neo4j_data"
  LOGS_VOLUME="claude_neo4j_logs"
else
  DATA_VOLUME="docker_claude_neo4j_data"
  LOGS_VOLUME="docker_claude_neo4j_logs"
fi

# The image is fully qualified because Podman will not guess a registry for an
# unqualified name unless the host sets `unqualified-search-registries`
# (commented out by default on Debian/Ubuntu), and Neo4j has no entry in
# shortnames.conf either -- so the short spelling fails here under Podman while
# working under Docker, which expands it silently. Docker accepts the long form
# unchanged. Same reasoning as migrate-to-podman.sh's $IMAGE, and
# tests/image-name.test.sh guards both.
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
    docker.io/library/neo4j:5-community >/dev/null
}

if ! "$ENGINE" inspect claude-neo4j-memory >/dev/null 2>&1; then
  # The container can genuinely live under the other engine (most commonly:
  # migrated to Podman, then the Podman container was later removed — `podman
  # rm`, `podman system reset`, or the rollback line migrate-to-podman.sh
  # prints). Creating a fresh one here would land on this engine's volume
  # name, which Podman/Docker each auto-create empty, silently orphaning the
  # real graph. The whole check is one `if` condition (never a bare `&&`
  # chain run standalone) so a missing other-engine binary — the common case —
  # can't trip `set -e`; it just fails the condition and falls through.
  OTHER="podman"; [ "$ENGINE" = "podman" ] && OTHER="docker"
  if command -v "$OTHER" >/dev/null 2>&1 && "$OTHER" inspect claude-neo4j-memory >/dev/null 2>&1; then
    echo "Container claude-neo4j-memory exists under $OTHER, not $ENGINE." >&2
    echo "Running this script does not move data between engines." >&2
    echo "Use: npm run migrate-to-podman" >&2
    exit 1
  fi
  echo "Container claude-neo4j-memory not found, starting it under $ENGINE..."
  start_container
fi

echo "Waiting for claude-neo4j-memory container to be healthy..."
for _ in $(seq 1 30); do
  status="$(container_health claude-neo4j-memory)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$status" = "unknown" ]; then
    echo "Container claude-neo4j-memory not found. Run: scripts/setup-local.sh" >&2
    exit 1
  fi
  sleep 2
done

if [ "$status" != "healthy" ]; then
  echo "Container did not become healthy in time (status: $status)." >&2
  exit 1
fi

# Podman is daemonless, so nothing brings this container back on its own after
# a reboot and the next Claude session is silently memory-less. The mechanism
# differs by platform and lib-engine.sh owns that mapping; this only asks, and
# then installs whichever one applies. Docker needs none of it.
offer_boot_persistence() {
  local kind state=0
  kind="$(boot_persistence_kind)"
  # 2 means "nothing to install here" (Docker, or a platform with no
  # mechanism) and 0 means it is already in place -- neither is worth a
  # prompt. `|| state=$?` keeps the non-zero returns from tripping set -e.
  boot_persistence_installed || state=$?
  [ "$state" -eq 1 ] || return 0

  case "$kind" in
    systemd)     offer_systemd_unit ;;
    launchagent) offer_launch_agent ;;
  esac
}

# macOS has neither a user systemd session nor lingering. The equivalent lever
# is a LaunchAgent, with one honest difference that is stated rather than
# glossed: it runs at *login*, not at boot -- macOS has no user-level
# pre-login start, so this is the closest parity available.
offer_launch_agent() {
  cat <<'EOF'

This container runs inside the podman-machine-default VM, and that VM does not
come back by itself after a reboot — so the container's --restart policy never
gets the chance to fire, and the next Claude session starts memory-less. macOS
has no systemd user unit or lingering; the equivalent is a login agent running:

    podman machine start

Note "at login", not at boot: macOS has no user-level pre-login start. If you
use Podman Desktop, its "Start Podman on login" setting does the same job —
skip this if that is already on.

EOF
  if [ ! -t 0 ]; then
    echo "Not interactive — skipping. Re-run this script to be asked again." >&2
    return 0
  fi

  local reply=""
  read -r -p "Install the login agent now? [y/N] " reply || reply=""
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Skipped. If memory is offline after a reboot, run: podman machine start"; return 0 ;;
  esac

  # As with the systemd path below, this is opt-in convenience and is never
  # allowed to abort the mandatory configure step, so every fallible command
  # returns 0 with an explanation rather than failing under set -e.
  local podman_bin=""
  # LaunchAgents inherit a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that
  # excludes both Homebrew prefixes, so a bare "podman" in the plist would
  # simply never run — and would fail at login, where nobody is watching.
  # Resolve the absolute path now, at install time.
  podman_bin="$(command -v podman)" || {
    echo "Boot-persistence setup failed: could not locate the podman binary. Safe to skip -- re-run scripts/setup-local.sh to retry." >&2
    return 0
  }

  if ! mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claude-neo4j"; then
    echo "Boot-persistence setup failed: could not create ~/Library/LaunchAgents. Safe to skip -- re-run scripts/setup-local.sh to retry." >&2
    return 0
  fi

  # No KeepAlive, deliberately: `podman machine start` is one-shot and exits,
  # so KeepAlive would have launchd respawn it in a tight loop forever. It
  # also exits non-zero when the VM is already running, which is a normal
  # no-op and the reason the log below is worth having.
  if ! cat > "$LAUNCH_AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LAUNCH_AGENT_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$podman_bin</string>
        <string>machine</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/.claude-neo4j/podman-machine-start.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.claude-neo4j/podman-machine-start.log</string>
</dict>
</plist>
EOF
  then
    rm -f "$LAUNCH_AGENT_PLIST"
    echo "Boot-persistence setup failed: could not write $LAUNCH_AGENT_PLIST. Safe to skip -- re-run scripts/setup-local.sh to retry." >&2
    return 0
  fi

  # `bootstrap` is the modern verb and `load -w` the deprecated one that still
  # works everywhere this repo runs. bootstrap also fails if the label is
  # already loaded, and re-running this script has to stay safe, so fall back
  # rather than treating its failure as fatal.
  local domain="gui/$(id -u)"
  if ! launchctl bootstrap "$domain" "$LAUNCH_AGENT_PLIST" 2>/dev/null; then
    if ! launchctl load -w "$LAUNCH_AGENT_PLIST" 2>/dev/null; then
      echo "Boot-persistence setup failed: launchctl would not load $LAUNCH_AGENT_PLIST. Safe to skip -- re-run scripts/setup-local.sh to retry." >&2
      return 0
    fi
  fi

  echo "Installed. 'podman machine start' will now run at login."
  echo "  log:    $HOME/.claude-neo4j/podman-machine-start.log"
  echo "  remove: launchctl bootout $domain/$LAUNCH_AGENT_LABEL && rm $LAUNCH_AGENT_PLIST"
}

# Rootless Podman on Linux: --restart only holds while the user's Podman
# session lives, so a systemd *user* unit plus lingering is Podman's answer.
offer_systemd_unit() {
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
  read -r -p "Install it now? [y/N] " reply || reply=""
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Skipped. Re-run scripts/setup-local.sh after a reboot, or re-run this to be asked again."; return 0 ;;
  esac

  # Podman's own --restart on this container can race with systemd's stop/
  # restart of the unit we're about to generate (Podman itself warns against
  # combining the two). Clearing it is best-effort: reboot survival works
  # either way, only `systemctl stop/restart claude-neo4j.service` cleanliness
  # is at stake if this fails, so a failure here is never fatal and the
  # container is never recreated.
  if ! podman update --restart=no claude-neo4j-memory >/dev/null 2>&1; then
    echo "Note: could not clear the container's own restart policy; 'systemctl stop/restart claude-neo4j.service' may not behave cleanly. Continuing -- reboot survival still works." >&2
  fi

  # This whole install is opt-in convenience, never allowed to abort the
  # mandatory configure step below (this script runs under set -e). Every
  # fallible command here is therefore its own `if ! ...; then return 0; fi`
  # rather than a bare statement, and a partial/empty unit file is removed
  # rather than handed to daemon-reload/enable.
  if ! mkdir -p "$HOME/.config/systemd/user"; then
    echo "Boot-persistence setup failed: could not create ~/.config/systemd/user. This is safe to skip -- re-run scripts/setup-local.sh to retry." >&2
    return 0
  fi
  local unit_file="$HOME/.config/systemd/user/claude-neo4j.service"

  if ! podman generate systemd --name claude-neo4j-memory --restart-policy=always \
      > "$unit_file" 2>/dev/null; then
    rm -f "$unit_file"
    echo "Boot-persistence setup failed: 'podman generate systemd' did not succeed. This is safe to skip -- re-run scripts/setup-local.sh to retry." >&2
    return 0
  fi
  if [ ! -s "$unit_file" ]; then
    rm -f "$unit_file"
    echo "Boot-persistence setup failed: 'podman generate systemd' produced an empty unit file. This is safe to skip -- re-run scripts/setup-local.sh to retry." >&2
    return 0
  fi
  if ! systemctl --user daemon-reload; then
    echo "Boot-persistence setup failed: 'systemctl --user daemon-reload' failed. This is safe to skip -- re-run scripts/setup-local.sh to retry." >&2
    return 0
  fi
  if ! systemctl --user enable --now claude-neo4j.service; then
    echo "Boot-persistence setup failed: could not enable/start the systemd unit. This is safe to skip -- re-run scripts/setup-local.sh to retry." >&2
    return 0
  fi

  loginctl enable-linger "$USER" 2>/dev/null || \
    echo "Note: 'loginctl enable-linger' failed; the unit starts on login rather than boot." >&2
  echo "Installed. The container will now start at boot."
}

offer_boot_persistence

echo "Container healthy. Configuring plugin..."
node scripts/configure.mjs \
  --mode local \
  --uri "bolt://localhost:${NEO4J_BOLT_PORT}" \
  --username "$NEO4J_USERNAME" \
  --password "$NEO4J_PASSWORD" \
  --database neo4j
