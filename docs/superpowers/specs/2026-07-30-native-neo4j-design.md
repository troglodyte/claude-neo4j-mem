# Replace Docker with a natively-installed Neo4j

**Status**: SUPERSEDED by `2026-07-30-podman-engine-design.md`. Not implemented.
**Date**: 2026-07-30

> Abandoned in favour of running the same container under Podman, which needs
> no tarball pin, no JDK prerequisite, and no `set-initial-password` window.
> Kept for the two findings that outlived it: the `system`-database auth trap
> (§ "Trap"), and the measured per-prompt cost of a static `neo4j-driver`
> import (§ "Deferred injection"). The rehearse-on-7688 verification approach
> carried over to the Podman design intact.

Move the local backend from a Docker container to a pinned Neo4j tarball the
plugin installs and runs itself, and migrate the existing graph without risking
it.

## Why

Docker is the plugin's only hard external dependency for local mode. On macOS
it means Docker Desktop (a VM, plus licensing for commercial use); on Linux it
means a daemon and group membership. A pinned tarball needs neither — just a
JVM — and behaves identically on both platforms.

## Decisions

| question | decision |
| --- | --- |
| Docker path after this | **Replaced.** `mode: local` means native. `docker/` is deleted. A one-shot migration script ships. |
| How Neo4j is installed | **Pinned tarball** into `~/.claude-neo4j/neo4j/`. No sudo, no package manager, same code path on mac and linux. |
| Version | **5.26.28**, matching the container exactly, so dump/load is version-neutral. |
| Lifecycle | **Lazy-load per Claude session**, plus `ensure_running` in the shell scripts. No systemd/launchd. |
| Lost injection | **Deferred, not lost** — recovered by a new `UserPromptSubmit` hook. |
| Migration mechanism | **Offline dump → load**, reusing the artifact `backup.sh` already produces. |
| Old container | **Never destroyed automatically.** Migration is copy-not-move; the reclaim command is printed. |

`mode: remote` (Aura) is unaffected throughout.

## Architecture

`~/.claude-neo4j/config.json` needs no change. Native Neo4j binds `7687`/`7474`
by default — the same ports the container published — so `bolt://localhost:7687`
keeps resolving and **no JS connection code is touched**.

```
~/.claude-neo4j/
  config.json          unchanged
  neo4j/               pinned 5.26.28 tarball (bin/, conf/, lib/)
  data/                the graph
  logs/
  state/               existing; gains <session_id>.pending-injection
```

### Components

| piece | change |
| --- | --- |
| `scripts/lib-neo4j.sh` | **new.** Resolves `~/.claude-neo4j/neo4j/bin`, `ensure_running`, `wait_for_bolt`. Replaces the docker helpers in `lib-backup.sh` (`require_docker`, `container_running`, `container_image`, `stop_container_with_restart_trap`, `wait_for_health`). |
| `scripts/setup-local.sh` | **rewritten.** Fetch + checksum tarball, write `neo4j.conf` pointing data at `~/.claude-neo4j/data`, `neo4j-admin dbms set-initial-password`, start. |
| `scripts/neo4j-version.txt` | **new.** The pinned version and its expected sha256, tracked in git — a checksum fetched at install time alongside the tarball verifies nothing. |
| `scripts/migrate-from-docker.sh` | **new, one-shot.** Dump from container → install native → load → verify → print reclaim command. |
| `scripts/backup.sh`, `restore.sh` | Drop `docker run --volumes-from`; call local `neo4j-admin` directly. Net simplification — no sibling container. |
| `scripts/cypher.sh` | Drop the `docker exec` branch; use `cypher-shell` from the tarball. Remote-mode path unchanged. |
| `scripts/check-health.sh` | Container checks become process/bolt checks. |
| `src/hooks/session-start.js` | Call `ensureRunning()` before `verifyConnectivity()`; write the pending-injection marker when it gives up. Update `SETUP_HINT` (line 49) — it names Docker. |
| `src/hooks/prompt-submit.js` | **new.** Deferred-injection recovery. |
| `hooks/hooks.json` | Register `UserPromptSubmit`. |
| `.claude-plugin/plugin.json` | Bump `version`; the `description` names Docker. `package.json` version stays in lockstep. |
| `docker/` | **deleted.** |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md` | Docker references throughout. |

## Lifecycle: lazy-load

Three properties of the existing code make this work:

- **The driver is lazy.** `neo4jClient.js:6` builds it on first use and
  `withSession` opens a fresh session per call, so MCP tools hold no connection
  from session start. A `memory_search` fired 30s in connects fine even if
  Neo4j was cold at session start.
- **Failure is already non-silent.** `session-start.js:68` wraps
  `verifyConnectivity()` in a try; the catch at line 118 reports it. Lazy-load
  must *preserve* this, not invent it.
- **Detached spawn is an established pattern here.** `SessionEnd` capture
  already re-spawns itself detached and unref'd. Starting a JVM has the same
  shape and reuses it.

`session-start.js`, before `verifyConnectivity()`:

1. Bolt listening → proceed. One TCP connect. Every session but the first after
   a reboot.
2. Not listening → spawn `neo4j start` **detached and unref'd** under a lockfile
   in `~/.claude-neo4j/state/` — concurrent Claude sessions otherwise race to
   start two JVMs — then poll bolt up to a bounded budget.
3. Budget expires → write the pending-injection marker, emit an explicit banner,
   return. The start keeps warming in the background.

**The budget default is set from measurement, not guessed.** Step 2 of the
migration measures real cold-start on the real 520 MB store at zero cost;
implementation starts at a provisional **15s** and replaces it with
`ceil(measured × 1.5)` so the default is headroom over an observed number rather
than a round guess. `CLAUDE_NEO4J_START_TIMEOUT` overrides, matching how
`CLAUDE_NEO4J_CAPTURE_WINDOW` is already handled.

The budget is a ceiling, not a sleep: polling stops the moment bolt accepts.

## Deferred injection

Injection is read once at `session-start.js:74`. If it is skipped there, a
`UserPromptSubmit` hook recovers it on the next prompt.

1. `existsSync(marker)` → absent, `exit(0)`. Every prompt of every normal
   session stops here.
2. Present → **dynamically** import the driver, try bolt. Down? Leave the
   marker, exit silently; retries next prompt (a refused connect is
   sub-millisecond).
3. Up → build via the same `renderInjection` path, return as
   `hookSpecificOutput.additionalContext`, delete the marker.

**Measured on this machine, and the reason the dynamic import is mandatory:**

| path | cost |
| --- | --- |
| no-op (`existsSync`, no driver import) | ~10ms |
| same, but importing `neo4j-driver` | ~50ms |

A static `neo4j-driver` import at the top of `prompt-submit.js` makes every
prompt in every session 5× more expensive for a benefit that applies to roughly
one session per reboot. The import must sit inside the marker-present branch.

The marker carries the project and cwd `session-start.js` already resolved, so
recovery does not redo project detection and cannot disagree with it. The
existing `pruneStaleState` sweeps `~/.claude-neo4j/state/`. Retry is bounded to
~10 minutes of session time: an unbounded marker would inject a session-start
snapshot hours into a conversation, which is worse than not injecting it.

**This also fixes a bug that exists today**, independent of the migration: if
Neo4j is down at session start (crash, resume-from-sleep), that session runs
without injection permanently, even after Neo4j recovers seconds later.

## Migration

### Mechanism

**Offline dump → load.** `neo4j-admin database dump --to-stdout` from a sibling
container against the stopped container's volumes, then
`neo4j-admin database load --from-stdin` natively. This is exactly the artifact
`backup.sh:106` produces and `restore.sh:104` consumes — both already tested.
Versions match (5.26.28 → 5.26.28), and the dump preserves indexes and
constraints, including the composite `(name, project)` uniqueness constraint and
the full-text index `memory_search` runs on.

Rejected: **raw volume copy** (copies mid-flight transaction logs and store lock
files; every file arrives owned by the container's uid 7474). Rejected:
**Cypher-level export** (APOC absent; re-import through the plugin's own model
silently drops schema).

### Trap: credentials live in `system`, not `neo4j`

Dumping only the `neo4j` database carries the graph but **not** the auth. The
native install would come up on the default `neo4j/neo4j`, and every connection
using the password in `config.json` would fail with an auth error that looks
nothing like a migration bug.

Fix: `neo4j-admin dbms set-initial-password` with the existing password before
the native server's first start — it only works while no auth file exists, which
is exactly this window. Migrating the `system` database instead is the wrong
lever; it also carries roles and DB metadata that should not be transplanted.

### Steps

Both engines bind `7687` and cannot coexist. The rehearsal therefore runs on
**7688** while the container keeps serving `7687`, so the native stack is proven
before the container gives up the port.

- **Step 0 — safety net, and the migration source.** `npm run backup`, the
  existing tested path. Yields a `.dump` + `.sha256` sidecar. Its trap restarts
  the container on failure and Ctrl-C.

  **Step 2 loads this same artifact** rather than taking a second dump: the
  container is stopped once, not twice, and the thing verified in the rehearsal
  is byte-identical (via the sidecar) to the thing kept as the safety net. A
  second dump would mean the artifact restored from in an emergency was never
  the one actually tested.
- **Step 1 — baseline fingerprint.** Against the still-running container.
  Counts alone can match while content is wrong, so capture all three:
  - totals and per-project table from `npm run usage`
  - `SHOW CONSTRAINTS` / `SHOW INDEXES`
  - sha256 over sorted `(name, project)` pairs, sorted observation ids, sorted
    relation triples
- **Step 2 — rehearse on 7688.** Verify the Step 0 sidecar, install the tarball,
  set the initial password, load the dump, start on 7688 (`server.bolt.listen_address`
  and `server.http.listen_address` in the generated `neo4j.conf`). Re-run every
  Step 1 probe against it; all three fingerprints must match exactly. Also
  **measure cold-start time** here for the lazy-load budget. The live container
  is untouched, so failure costs nothing and the attempt is
  `rm -rf ~/.claude-neo4j/neo4j`.
- **Step 3 — cut over.** Only if Step 2 is clean. Stop the container, rewrite
  those two conf values to the default ports, restart native. `config.json`
  never changes — this is the only reason the rehearsal needed a different port
  in the first place.
- **Step 4 — functional proof.** Counts prove the store loaded, not that the
  plugin works:
  - `scripts/check-health.sh` end to end (config, auth, MCP handshake)
  - a real `memory_search` through MCP — exercises the full-text index
    specifically
  - a write + read-back through `memory_add_observations`
  - **cold-start path**: kill the JVM, start a fresh session, confirm the banner
    appears and the `UserPromptSubmit` hook delivers the deferred injection on
    the first prompt — not silence
  - test data deleted after verification, per the repo rule
- **Step 5 — regression gates.** `npm test` and `npm run token-cost`. Read-path
  shapes do not change here, so `token-cost` should be flat; movement means
  something unintended happened.

### Rollback

Rollback is a real path, not a hope. The container and its volume are never
written to at any step, so until the reclaim command is run by hand, rollback is
`stop native → docker start claude-neo4j-memory`. The migration script fails
closed: any verification mismatch leaves the container running and refuses to
take the port.

Expected failure modes, both caught at Step 2: the auth trap above (surfaces as
an auth error, not a data error), and a tarball checksum mismatch (surfaces
before anything is installed).

## Implementation phasing

Two phases, sequenced so the risky part lands and is verified before anything
touches the hook surface. They are separable: **Phase 2 fixes a bug that exists
today** and would be worth doing even if the migration were abandoned.

**Phase 1 — native backend and data migration.** `lib-neo4j.sh`, rewritten
`setup-local.sh`, `migrate-from-docker.sh`, the `backup`/`restore`/`cypher`/
`check-health` conversions, `docker/` deleted, docs. Lifecycle here is just
`ensure_running` in the shell scripts. Ends at Step 5 green, with the graph
live on native and the container parked as rollback.

At the end of Phase 1 a reboot leaves Neo4j down until a script starts it —
`session-start.js` reports the failure (as it does today) but nothing recovers
it. That is the known, temporary gap Phase 2 closes; it is not a shipping state.

**Phase 2 — lazy-load and deferred injection.** `session-start.js` gains
`ensureRunning()` and the marker; `prompt-submit.js` and the `UserPromptSubmit`
registration are new. Uses the cold-start number Phase 1 measured. Version bump
and `CHANGELOG.md` land here, since that is the point both halves are true.

## Testing

New `node --test` coverage:

- `resolveNeo4jHome` / bin resolution, including the missing-install case
- marker write on give-up; marker absent on the happy path
- `prompt-submit.js`: no-op when marker absent; injection + marker deletion when
  present and bolt is up; marker retained when bolt is down; bounded retry
  expiry
- **a guard that `prompt-submit.js` does not statically import `neo4j-driver`**
  — this is the per-prompt cost regression, and it is invisible to any
  functional test

Existing `tests/launcher-path.test.sh` covers the two-step path resolution and
the `.claude-plugin/plugin.json` assertion; `lib-neo4j.sh` and the two new
scripts must satisfy the same guard.

## Out of scope

- systemd/launchd service units (explicitly rejected in favour of lazy-load)
- Podman or any other container engine
- JDK management — Java 17/21 is a documented prerequisite, checked with a clear
  error, not installed by the plugin
- Changes to `mode: remote`

## Consequences

- Local mode loses its Docker dependency; macOS users no longer need Docker
  Desktop.
- The plugin now owns ~200 MB under `~/.claude-neo4j/` and the lifecycle of a
  JVM it starts.
- First session after a reboot pays a cold start; its injection arrives one
  prompt late rather than never.
- Existing marketplace users on `mode: local` need `migrate-from-docker.sh`.
  This is a breaking change to local mode and must be called out in
  `CHANGELOG.md` and gated behind a version bump — per `CLAUDE.md`, an unbumped
  version means other projects silently keep running the old snapshot.
