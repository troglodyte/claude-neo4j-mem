#!/usr/bin/env bash
# Resolves which container engine to drive. Sourced, never executed.
#
# Both engines are fully supported -- every verb these scripts use (info,
# inspect, start, stop, exec -i, run --rm --volumes-from) is spelled
# identically by both, which is the whole reason one variable suffices.
#
# The choice follows the DATA first, and only then a preference. Podman and
# Docker cannot see each other's named volumes, so naming the wrong engine
# doesn't fail -- it silently opens a different database. Whichever engine is
# actually holding claude-neo4j-memory therefore wins outright.
#
# Podman breaks a tie the container says nothing about, because it is the
# better engine to start on: daemonless, rootless, no licensing. Docker is a
# fully supported fallback wherever Podman isn't installed or isn't usable.
#
# The ordering only ever decides a machine with no container on either side.
# That distinction is the whole point: a preference alone used to mean that
# installing Podman beside a working Docker -- for any unrelated reason --
# silently moved every script onto an empty Podman volume. `npm run
# migrate-to-podman` is what actually moves a graph across.
ENGINE_CONTAINER="claude-neo4j-memory"

# 2 = running the container, 1 = has it but stopped, 0 = doesn't have it.
# Every inspect is guarded: an engine can be usable yet answer this oddly
# (see the container_health note below), and under `set -e` in a sourced
# caller an unguarded non-zero exit here would abort the whole script.
engine_holds_graph() {
  "$1" inspect "$ENGINE_CONTAINER" >/dev/null 2>&1 || { printf 0; return 0; }
  if [ "$("$1" inspect -f '{{.State.Running}}' "$ENGINE_CONTAINER" 2>/dev/null || true)" = "true" ]; then
    printf 2
  else
    printf 1
  fi
}

# Sets ENGINE on success. Returns 1 with an explanation on stderr otherwise.
resolve_engine() {
  local requested="${CLAUDE_NEO4J_ENGINE:-}" candidate
  local best="" best_score=-1 score

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

  # Usability is a hard gate, checked before the container probe: an engine
  # that can't run is not a candidate no matter what it is holding. The probe
  # only runs for engines that pass, so the single-engine machine -- almost
  # everyone -- pays for one extra `inspect` at most.
  for candidate in podman docker; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    "$candidate" info >/dev/null 2>&1 || continue
    score="$(engine_holds_graph "$candidate")"
    # Strictly greater, so the podman-first loop order settles equal scores.
    if [ "$score" -gt "$best_score" ]; then
      best_score="$score"
      best="$candidate"
    fi
    # 2 is the maximum, so nothing later can beat it. Worth short-circuiting:
    # the old code returned on the first usable engine and never paid for the
    # second, and `podman info` on a cold rootless session is not free.
    # (`if` rather than `[ ... ] && break`: an AND-list whose left side fails
    # leaves the loop body's status non-zero, which is a `set -e` hazard not
    # worth reasoning about in a file every script sources.)
    if [ "$score" -eq 2 ]; then break; fi
  done

  if [ -n "$best" ]; then
    ENGINE="$best"
    return 0
  fi

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
# (.State.Health vs .State.Healthcheck) across versions. A template that
# doesn't match either engine's actual state shape is an ERROR (non-zero exit)
# -- verified empirically, not the empty string this comment used to claim --
# so both `inspect` calls below are guarded with `|| true`: without it, a
# non-matching template on the FIRST guess would trip `set -e` in any caller
# and abort the whole script right there, with the `.State.Healthcheck`
# fallback never reached and no explanation printed. Try both and say
# "unknown" only if neither answers.
container_health() {
  local container="$1" status
  status="$("$ENGINE" inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
  [ -n "$status" ] || status="$("$ENGINE" inspect -f '{{.State.Healthcheck.Status}}' "$container" 2>/dev/null || true)"
  printf '%s' "${status:-unknown}"
}
