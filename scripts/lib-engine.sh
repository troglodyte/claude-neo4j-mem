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
