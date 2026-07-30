# Run the local Neo4j under Podman instead of Docker

**Status**: approved design, not yet implemented
**Date**: 2026-07-30

Make the shell tooling engine-agnostic, prefer Podman when present, teach
`setup-local.sh` to install Podman with consent, and move this machine's graph
from Docker's volume to Podman's.

Supersedes `2026-07-30-native-neo4j-design.md`.

## Why

Docker is the plugin's only hard external dependency for local mode. On macOS
that means Docker Desktop and its commercial licensing; on Linux, a root daemon
and group membership. Podman is daemonless, rootless by default, and free of
that licensing.

Podman is **not** a smaller footprint on macOS: `podman machine` runs a Linux VM
under Apple's virtualization framework, the same shape as Docker Desktop. The
wins there are licensing and the absence of a daemon, not resources.

## Decisions

| question | decision |
| --- | --- |
| Docker after this | **Still supported.** Scripts resolve an `$ENGINE`, preferring `podman`, falling back to `docker`. |
| Who migrates | **Only this machine.** Because both engines stay supported, existing users are untouched and nothing breaks. |
| Installing Podman | `setup-local.sh` offers to, **prompting before any `sudo`**. |
| Compose | Replaced by a plain `$ENGINE run` — one service does not justify a compose dependency that Podman does not satisfy natively. |
| Migration mechanism | **Offline dump → load**, reusing the artifact `backup.sh` already produces. |
| Old Docker container | **Never destroyed automatically.** Copy-not-move; the reclaim command is printed. |
| Lifecycle | `--restart=unless-stopped` as today, **plus** an opt-in systemd user unit — rootless Podman does not survive reboot on its own. See below. |

`mode: remote` (Aura) is unaffected throughout.

## Why migration is unavoidable

Docker's volume is at `/var/lib/docker/volumes/docker_claude_neo4j_data/_data`;
rootless Podman uses `~/.local/share/containers/storage/volumes/`. Separate
storage backends by design — **Podman cannot see Docker's named volumes**, so
the graph does not come along on its own.

It is a fraction of the native migration, though. Both sides run the identical
`neo4j:5-community` image at 5.26.28, so dump/load is version-neutral, and the
new container takes its password from `NEO4J_AUTH` on first start. That last
point erases the worst trap in the superseded design: there, credentials lived
in the `system` database and a graph-only dump would have landed silently on the
default password.

## Architecture

No JS changes. `config.json` is untouched — Podman publishes `7687`/`7474` just
as Docker did, so `bolt://localhost:7687` keeps resolving.

Every verb the scripts use is identical across both engines: `info`, `inspect`,
`start`, `stop`, `exec -i`, `run --rm [-i] --volumes-from`. Only `compose`
differs.

### Engine resolution

A single helper, sourced by every script:

```
resolve_engine():
  $CLAUDE_NEO4J_ENGINE if set   (explicit override, validated)
  else podman  if on PATH and its socket/daemon-less check passes
  else docker  if on PATH and its daemon is reachable
  else         actionable error naming both
```

Preferring Podman means this machine switches over automatically once Podman is
installed, with no config edit. The override exists so a machine with both can
pin one.

### Components

| piece | change |
| --- | --- |
| `scripts/lib-engine.sh` | **new.** `resolve_engine`, plus the `require_engine` / `container_running` / `container_image` helpers currently hardcoded to `docker` in `lib-backup.sh`. |
| `scripts/lib-backup.sh` | `require_docker` → `require_engine`; all `docker` literals become `"$ENGINE"`. |
| `scripts/backup.sh`, `restore.sh` | `docker run --rm --volumes-from` → `"$ENGINE" run …`. No other change; both already stream via stdout/stdin, so no bind mounts and no rootless-uid ownership problem. |
| `scripts/setup-local.sh` | Engine detection, consent-gated install, `$ENGINE run` in place of `compose up -d`. |
| `scripts/cypher.sh` | `docker exec` → `"$ENGINE" exec`. Remote-mode path unchanged. |
| `scripts/check-health.sh` | `docker inspect` → `"$ENGINE" inspect`; report which engine was resolved. |
| `scripts/migrate-to-podman.sh` | **new, one-shot.** |
| `docker/docker-compose.yml` | **deleted**, replaced by the `run` invocation in `setup-local.sh`. |
| `docker/.env` | **path kept deliberately**, despite now being engine-neutral. It is gitignored and already on the user's disk, and `cypher.sh:63` reads it as a last-resort credential source; renaming the directory would break both for a cosmetic gain. Noted here so it does not read as an oversight. |
| `README.md`, `CLAUDE.md`, `.claude-plugin/plugin.json` | Docker-specific wording. |

### Compose

`podman compose` in 5.7 is a shim that delegates to a `docker-compose` or
`podman-compose` binary which must already be installed, so "install Podman"
alone does not make `compose up -d` work. Rather than add a second install step
or branch per engine, `setup-local.sh` issues a plain `$ENGINE run` with the
ports, volumes, env and healthcheck inline. The compose file describes exactly
one service, so this removes a dependency rather than adding a branch.

## Lifecycle: the one real regression

Docker's `restart: unless-stopped` is enforced by a root daemon that starts at
boot, so the container comes back on its own. **Rootless Podman has no daemon**,
so a restart policy only applies while the user's Podman session is alive. After
a reboot, nothing brings the container back until something asks — and the
symptom is the one this project already knows is dangerous: a session that comes
up without memory.

Podman's answer is a systemd *user* unit (`podman generate systemd`, or a
Quadlet `.container` file) plus `loginctl enable-linger $USER` so the unit runs
without an active login.

`setup-local.sh` therefore offers to install that unit on Linux, the same
consent-gated shape as the Podman install itself. Declining is fine and
supported; the container then simply needs `setup-local.sh` re-run after a
reboot, and `check-health.sh` says so explicitly rather than leaving it to be
inferred.

This is the single behavioural regression against Docker, and it is worth being
explicit that it exists rather than discovering it after the first reboot.

## Installing Podman

Ubuntu 26.04 carries podman **5.7.0** in apt. macOS has it in Homebrew.

`setup-local.sh`, when no engine resolves:

1. Detect platform and package manager (`apt-get`, `dnf`, `pacman`, `brew`).
2. Print the exact command it intends to run and **ask for confirmation**. Never
   escalate silently.
3. On decline, or when non-interactive, or when no known package manager is
   found: print the command and exit non-zero. Do not half-install.
4. macOS additionally needs `podman machine init && podman machine start`; this
   is a VM provision and can take minutes, so it is announced, not silent.

`sudo` is required on Linux — Podman has no supported user-local tarball, unlike
the Neo4j install in the superseded design. This is the one place the Podman
route is *less* self-contained than the native one.

## Migration

### Mechanism

Offline dump → load, reusing `backup.sh`'s artifact and `restore.sh`'s loader,
both already tested. Rejected: **raw volume copy** — it would carry mid-flight
transaction logs and store lock files, and rootless Podman shifts uids through
the subuid range, so the container's uid 7474 does not survive the trip
meaningfully.

### Steps

Both engines would bind `7687` and cannot coexist, so the rehearsal runs the
Podman container on **7688** while Docker keeps serving `7687`. The new stack is
proven before the old one gives up the port.

- **Step 0 — safety net, and the migration source.** `npm run backup` against
  Docker. Yields a `.dump` + `.sha256` sidecar; its trap restarts the container
  on failure and Ctrl-C.

  **Step 2 loads this same artifact** rather than taking a second dump: the
  container stops once, and the thing verified in rehearsal is byte-identical
  (via the sidecar) to the thing kept as the safety net. Two separate dumps
  would leave the emergency artifact untested.
- **Step 1 — baseline fingerprint.** Against the still-running Docker container.
  Counts alone can match while content is wrong, so capture all three:
  - totals and per-project table from `npm run usage`
  - `SHOW CONSTRAINTS` / `SHOW INDEXES` — the composite `(name, project)`
    constraint and the full-text index `memory_search` runs on
  - sha256 over sorted `(name, project)` pairs, sorted observation ids, sorted
    relation triples
- **Step 2 — rehearse on 7688.** Verify the sidecar, start a Podman container on
  7688 with `NEO4J_AUTH` set from `docker/.env`, load the dump, re-run every
  Step 1 probe. All three fingerprints must match exactly. Docker is untouched,
  so failure costs nothing and the attempt is one `podman rm -v`.
- **Step 3 — cut over.** Only if Step 2 is clean. Stop the Docker container,
  recreate the Podman one on 7687. `config.json` never changes — that is the
  only reason rehearsal needed a different port.
- **Step 4 — functional proof.** Counts prove the store loaded, not that the
  plugin works:
  - `scripts/check-health.sh` end to end, confirming it reports `podman`
  - a real `memory_search` through MCP — exercises the full-text index
    specifically, which a Cypher-level import would have silently dropped
  - a write + read-back through `memory_add_observations`
  - `npm run backup` **under Podman**, then `--info` on the result: proves
    `--volumes-from` works rootless, the one verb with a plausible engine
    difference
  - test data deleted after verification, per the repo rule
- **Step 5 — regression gates.** `npm test` and `npm run token-cost`. No
  read-path shapes change, so `token-cost` should be flat; movement means
  something unintended happened.

### Rollback

The Docker container and its volume are never written to at any step. Until the
reclaim command is run by hand, rollback is `stop podman → docker start
claude-neo4j-memory`. The migration script fails closed: any fingerprint
mismatch leaves Docker running and refuses to take the port.

## Testing

New `node --test` / shell coverage:

- `resolve_engine`: prefers podman; falls back to docker; honours
  `CLAUDE_NEO4J_ENGINE`; rejects an unknown value; actionable error when neither
  is present
- `setup-local.sh` never runs `sudo` without an affirmative answer — assert on a
  declined prompt and on a non-interactive invocation
- `setup-local.sh` never installs the systemd unit without an affirmative answer,
  and reports honestly when it was declined
- the existing `tests/launcher-path.test.sh` guard must extend to
  `lib-engine.sh` and `migrate-to-podman.sh`: two-step path resolution, and the
  `.claude-plugin/plugin.json` assertion that stops a script resolving the
  plugin root to `/`

## Out of scope

- **The deferred-injection fix** (`UserPromptSubmit` recovering an injection
  skipped because Neo4j was down at session start). Engine-independent, fixes a
  bug that exists today, measured at ~10ms per prompt. Deliberately not bundled
  here; see the superseded design for the measurements.
- Natively-installed Neo4j (superseded).
- Any change to `mode: remote`, or to the JS.

## Consequences

- Local mode runs on either engine; macOS users can drop Docker Desktop.
- Linux install of Podman needs `sudo`, gated behind an explicit prompt.
- **Reboot no longer restores the container unless the systemd user unit was
  accepted.** The only behavioural regression against Docker.
- The compose file goes away; `setup-local.sh` owns the container definition.
- Existing users are unaffected, so the version bump is routine rather than
  load-bearing — nothing silently breaks if a marketplace snapshot lags.
