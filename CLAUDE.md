# claude-neo4j — project notes

Claude Code plugin (`neo4j-memory`) giving Claude persistent, graph-based
memory backed by Neo4j. Architecture and usage: `README.md`. Per-release
detail: `CHANGELOG.md`. Portable cross-project guardrails: `AGENTS.md`
(symlink). This file keeps only what those three, the code, and git history
can't tell you — the traps.

## Environment

- **Local Neo4j runs on this machine** in a container named
  `claude-neo4j-memory` (bolt `7687`, http `7474`), created by
  `scripts/setup-local.sh` via a plain `$ENGINE run` — no compose file.
  `scripts/lib-engine.sh` resolves `$ENGINE` by following the container (see
  below); `CLAUDE_NEO4J_ENGINE` pins either. Credentials live in
  `docker/.env` (gitignored) — the directory name predates Podman support and
  stays as-is.
- **This machine runs the graph under Podman**, migrated from Docker on
  2026-07-31 with a `systemd --user` unit (`claude-neo4j.service`) plus
  `Linger=yes` for reboot survival. The Docker container and its
  `docker_claude_neo4j_*` volumes are still there, stopped, deliberately: they
  are the rollback, and nothing reclaims them until someone runs the `docker
  rm`/`docker volume rm` pair that `migrate-to-podman.sh` prints. Both engines
  therefore have a container named `claude-neo4j-memory` here — which is
  exactly why `resolve_engine` scores running above stopped.
- **Plugin config**: `~/.claude-neo4j/config.json`, pointed at that container
  (mode: local).
- `origin` is `git@github.com:troglodyte/claude-neo4j-mem.git`; `main` tracks
  it. Commits happen only when explicitly requested.
- **Never record a SHA or a graph size in this file.** Both went stale within
  a day every time they were written here, and a stale number stated as
  current is worse than no claim. Run `git status -sb` and `npm run usage`;
  they are always right.
- Test and smoke-test data is deleted after verification, every time.

## Use `scripts/claude-with-memory.sh` to work on this repo

A bare `claude` here loads **no memory plugin at all**, and the only symptom
is a missing `SessionStart` banner — the session otherwise looks completely
normal. Several ran that way before it was noticed.

- A **marketplace install is a snapshot copy** under `~/.claude/plugins/cache/…`,
  pinned to a git SHA. It never tracks the working tree, whether it came from
  GitHub or from a `directory` source, so local edits stay invisible to it
  until it is reinstalled.
- **`--plugin-dir` is the only live mechanism.** `plugin.json`/`.mcp.json`
  resolve `${CLAUDE_PLUGIN_ROOT}`, so pointing it at this repo runs the
  working tree. `claude-with-memory.sh` derives that path from its own
  location, which is why nothing here hardcodes a path.
- **A bad `--plugin-dir` starts a memory-less session silently.** Claude Code
  accepts `--plugin-dir /` with no error or warning. The launcher used to
  degrade to exactly that: `cd "$(dirname X)/.."` collapses to `cd /..` → `/`
  whenever the inner substitution yields nothing, and `set -euo pipefail`
  cannot catch it — the substitution swallows the inner failure and `cd /`
  then succeeds. All five `scripts/*.sh` now resolve in two steps and assert
  the resolved root contains `.claude-plugin/plugin.json`, refusing to run
  otherwise; `npm test` (`tests/launcher-path.test.sh`) fails against the old
  form.
- To check a *running* session: `tr '\0' ' ' < /proc/<pid>/cmdline` shows the
  real argv, and `pgrep -P <pid>` should list an `src/mcp/server.js` child. If
  it doesn't, the plugin never loaded. Per-session MCP logs are in
  `~/.cache/claude-cli-nodejs/<escaped-cwd>/mcp-logs-plugin-neo4j-memory-neo4j-memory/`.
- `~/.claude/settings.json` (user scope) registers the *same marketplace name*
  `claude-neo4j-local` from **GitHub** with `autoUpdate: true`, and user scope
  wins over the project-level entry — which is how a stale snapshot silently
  shadowed local work here. `.claude/settings.json` therefore just **disables**
  that installed copy for this repo, leaving the `--plugin-dir` copy as the
  only one loaded so no second MCP server registers under the same name. It
  deliberately contains no paths: a `directory` marketplace source is
  normalized to an absolute path (`./` is accepted then rewritten; `.` and
  `${CLAUDE_PROJECT_DIR}` are rejected outright), so it can never be portable.
- Verify with `claude plugin list`: inside this repo it should read
  `disabled`; outside it, `enabled`.

## Useful commands

- `scripts/claude-with-memory.sh` — launch Claude Code with this plugin loaded.
- `npm test` — `node --test` plus the guard that keeps `scripts/*.sh` from
  silently resolving the plugin directory to `/` (see above).
- `scripts/setup-local.sh` — idempotent: starts the local container if needed,
  waits for health, and (re)runs the configure wizard against it.
- `npm run configure` / `node scripts/configure.mjs --mode ... --uri ...` —
  reconfigure or switch between local/remote (e.g. Neo4j Aura) manually.
- `scripts/check-health.sh` — verifies the whole stack end to end (container
  health, config, Neo4j auth, MCP handshake); prints PASS/FAIL per check.
- `npm run usage` (or `scripts/memory-usage.sh`) — cross-project usage report:
  every project in the db with entity/observation counts, first-seen, obs in
  last 7 days, last activity, plus totals and hygiene warnings (duplicate
  project names, oversized entities, empty stubs, expensive subsystem maps,
  and — the opposite failure — a map collapsed into one dominant tag or a
  large unclassified history). `--quiet` for table only.
- `npm run token-cost [-- --all]` — measures every read path against a
  per-call ceiling and exits non-zero on regression.
- `npm run telemetry [-- --days N]` — access patterns from
  `~/.claude-neo4j/telemetry.jsonl`: read/write ratio per project, chars
  served, miss rate (empty *and* weak-match, see below), and the searches that
  found nothing. `--json` for raw, `--file PATH` to read another log.
- `npm run backup` / `npm run restore -- --latest` — snapshot and reinstate the
  whole database via `neo4j-admin database dump`/`load`, run in a sibling
  container against the stopped container's volume (`--volumes-from`). Local
  mode only; both stop and restart the container, via a trap that fires on
  failure and Ctrl-C too. `--keep N` prunes old backups, `--info` inspects an
  archive, restore requires typing the database name unless `--force`.
  **Compression is deliberately off**: the `.dump` is already zstd-compressed,
  and xz measured 0.9% on the real graph — `--xz` exists but is near-pointless.
  Each backup gets a `.sha256` sidecar because `load --info` reads only the
  archive header and passes a truncated dump as valid (verified). Shared
  plumbing is in `scripts/lib-backup.sh`.
- `scripts/cypher.sh "<query>"` — run arbitrary Cypher. Resolves credentials
  automatically and borrows `cypher-shell` from inside the container in local
  mode, so **no install is needed**; only remote-mode hosts need the binary.
- `npm run memory -- <command>` (or `node scripts/memory-cli.mjs <command>`) —
  query/edit the graph from a terminal, outside a Claude session. Commands:
  `status`, `search`, `recent`, `get`, `add`, `relate`, `timeline`,
  `forget-obs`, `forget`. Run with no args for usage.
- `npm run backfill-subsystems` — tag pre-existing observations.
- `scripts/statusline.mjs` — shows `<model> · 🧠 <entities>e/<observations>o`,
  scoped to the current project. Wired via `statusLine` in
  `.claude/settings.local.json` (gitignored, personal), which is why it isn't
  visible in the repo. Fails open to `🧠 offline`, hard-capped at a 1.5s
  lookup, never blocks the UI.

## Design decisions and traps

- **Entity identity is `(name, project)`, never `name` alone.** A global
  unique constraint let two unrelated repos writing `"user"` collide silently:
  the second writer's facts attached to the first project's node, and the
  second project couldn't see its own writes. Every `MATCH`/`MERGE` in
  `graph.js` now keys off both, and by-name lookups prefer an exact-project
  match, falling back to a global/`project IS NULL` entity. Neo4j Community
  supports composite uniqueness constraints, just not `NODE KEY`.
- **Search queries are Lucene-escaped** (`escapeLuceneQuery` in `graph.js`).
  Entity names like `feature:capture-visibility` otherwise parse as a field
  separator plus a negation and match nothing — searching for an entity by its
  own name returned zero hits. The trade is losing wildcard support.
- **Read paths are budgeted in characters, not rows** (`src/lib/budget.js`,
  applied in `graph.js`). Observation length varies 5x by source (claude-mem
  imports average 649 chars vs 122 for native capture), so row counts don't
  predict spend. Anything trimmed says so in-band (`…[+N chars]`, or
  `{total, returned, truncated}`) so a caller never summarizes a silently
  shortened history. **Run `npm run token-cost` after changing anything that
  shapes a read payload.**
- **A search "hit" is not evidence the search worked.** The full-text index
  tokenizes on hyphens, so `zzz-nonexistent-term-qqq` matches the token `term`
  and returns a real, plausible-looking entity — a total miss that reports as
  one hit. Counting rows therefore flatters recall, and any metric built on
  "did it return anything" will read healthier than the graph is. Measured on
  this repo: genuine queries top out at 3.3–9.3, that fragment match scored
  1.61, and true misses return 0 rows — so the Lucene score separates them
  where the count can't. `WEAK_SCORE` in `src/lib/relevance.js` is that floor
  (2.0) and it is **calibrated against this graph's content**; re-measure it
  with a handful of known-good and known-junk queries before trusting it
  elsewhere. Note the score was *always* in the payload and that wasn't
  enough — a bare number means nothing to a reader with no sense of the
  index's range, which is why `searchMemory` now returns a `relevance` verdict
  and a `note` rather than expecting the caller to judge. **A raw metric a
  caller can't calibrate is not an answer.**
- **Read-side usage is measured in `~/.claude-neo4j/telemetry.jsonl`, not in
  the graph.** Deliberately: access patterns are a different question from
  contents, they'd distort the `usage` hygiene report, and keeping them out of
  Neo4j means the log can be written when the database is the thing that's
  broken. Written by `registerTool` in `src/mcp/server.js`, which is the only
  seam every tool passes through — add a tool via `server.tool` directly and it
  becomes invisible to `npm run telemetry` with nothing to warn you.
- **Subsystem tags live on the observation, not the entity.** The entities
  most in need of slicing are exactly the ones already spanning several
  subsystems — `plugin:neo4j-memory` alone covers auto-capture, search,
  backup, and marketplace installs. Tagging the entity separates none of that.
- **"No subsystem" is `null`, and there is exactly one way to say it.** A
  cross-cutting fact (a preference, a project-wide constraint) has no
  subsystem; it reaches the model through the pinned-facts block, not the
  index. Naming that state instead — `general`, `misc` — turns it into a tag,
  and a tag gets offered back to the next extraction as a preferred option.
  That happened: the backfill's JSON schema marked `subsystem` **required**,
  leaving the model no way to express "none", so its prompt named `general` as
  an escape hatch and 315 observations (20% of the graph) fell into it, 85% of
  them not cross-cutting at all but merely unclassified. Both prompts seed
  their vocabulary from `listSubsystems` with "prefer one of these", so it
  compounded — within the backfill run *and* into every later live capture.
  `resolveSubsystem` now folds any catch-all name to `null` at the single
  write-side chokepoint, so a model reaching for a junk drawer gets the null it
  meant whatever prompt it read. **If you add a field an extraction model must
  fill, check it can express the empty case** — the prompt will invent
  something if the schema won't allow silence.
- **A wrong-but-specific tag is accepted.** Reclassification is ~90% accurate
  on the tags it assigns (measured on this repo, where the content is known);
  the rest land under a plausible neighbour. That's tolerable because the
  subsystem is a navigation aid, not ground truth — `memory_search` is
  full-text across everything and the `subsystem` filter is always optional.
- **`npm run usage` measures a subsystem map in characters as
  `injection.js` renders it**, firing above 800 (live maps run 170–336, so
  roughly 30 average tags). The original `> 12 distinct tags` rule measured
  project size, not fragmentation: it flagged only the project whose 15
  subsystems each held 9+ observations, and stayed silent on the one with
  three three-observation slivers. The row names the three smallest tags,
  since those are the merge candidates. Near-synonyms (`capture` vs.
  `auto-capture`) are the usual cause — the lexical deduper can't merge them
  because they aren't lexically close.
- **Auto-capture needs no `ANTHROPIC_API_KEY`.** `src/hooks/capture.js` shells
  out to a locked-down one-shot headless `claude -p` (no tools, no MCP
  servers, no settings/CLAUDE.md inheritance, `--json-schema` for structured
  output), riding the user's logged-in CLI session rather than a raw API key.
  Opt out with `CLAUDE_NEO4J_DISABLE_CAPTURE=1`; window and chunk count are
  `CLAUDE_NEO4J_CAPTURE_WINDOW` / `CLAUDE_NEO4J_CAPTURE_MAX_CHUNKS`.
- **`SessionEnd` capture runs detached; `PreCompact` stays synchronous.** A
  real `SessionEnd` firing was cancelled by Code because extraction outlives
  the process-exit teardown window, so the hook re-spawns itself detached and
  unref'd (input handed off via a temp file in `~/.claude-neo4j/state/`,
  progress logged to `~/.claude-neo4j/capture.log` since stdio is ignored) and
  returns immediately. Extraction measures ~11s for a full 50k window, so the
  timeouts are outlier headroom, not expected duration: 180s detached, 80s
  inline. **The tail is much longer than 11s suggests** — `capture.log` records
  timeouts firing at 90s, 80s, and once at the detached path's full 180s. Why
  is not yet known; treat the ~11s as a median, not a bound, and don't raise a
  timeout without evidence from the message itself (below).
- **Every failed capture is queued for retry, whichever hook it came from.**
  Only `SessionEnd` used to leave a pending input behind, so a failed
  `PreCompact` had nothing to re-trigger it. That looked survivable — `lastLine`
  advances only on success (`runCapture`), so the next `SessionEnd` re-reads the
  same range — but the re-read only covers it while it fits under the
  `50k × 3` chunk ceiling, and chunks are taken from the *end*. A session long
  enough to compact is exactly the one that outgrows the ceiling, dropping the
  oldest content first. Pending inputs are `*.pending.json`; the sweep still
  accepts the older `*.sessionend.json` name, since a file written by an
  earlier version is still retryable.
- **The dominant capture failure is the container going away at night, not
  the timeout mystery.** Measured 2026-08-03 over `capture.log`'s first 355
  lines: 149 successes, 26 failures — and 18 of the 26 are `Connection was
  closed by server` / `ECONNREFUSED 127.0.0.1:7687`, clustered at 00–03 UTC
  (13 of them at 02:xx alone), which is 19:00–22:00 local. That is the machine
  shutting down while a detached `SessionEnd` worker is still connecting.
  Every one recovered on the next boot's sweep — on 2026-08-03 the unit came
  up at 11:06 UTC and the retry landed at 11:07 — so **the retry queue, not
  the timeout headroom, is what keeps the capture rate up**; effective loss
  after retry is ~3/149 (~2%). Don't read a cluster of connection failures as
  a capture bug: check whether the sweep already closed them.
- **A capture timeout carries the killed child's output** (`extract.js`).
  It used to reject with the duration alone, discarding the stdout/stderr
  collected right up to the `SIGKILL` — which made every timeout in the log
  permanently unexplainable, since the tail is too rare to reproduce on demand.
  Silence and noise are reported differently: a child that never wrote a byte
  stalled before reaching the API, one that wrote and stopped did not.
- **Both capture paths log both outcomes.** `PreCompact` used to write its
  success only as a `systemMessage` on stdout and nothing to `capture.log`, so
  the operator record of that path was failures-only — which is why it read for
  weeks as a path that had never fired at all, when it had in fact both
  succeeded (07-22) and failed (07-28). A path whose successes are invisible
  will be mistaken for a path that never runs.
- **`capture.js` exports `sweepPendingCaptures`/`pruneStaleState` for
  `session-start.js`**, so its hook body is guarded by an entry-point check.
  Importing it must not fire a capture.
- **The claude-mem migration maps project scope, it doesn't copy it.**
  claude-mem scopes by bare directory name, this plugin by git-remote
  identifier, so importing under claude-mem's name splits one repo's memory
  across two scopes that can never see each other. Resolution order: `--as ID`
  > git remote of cwd (only when the cwd basename matches the claude-mem
  project) > bare name, and the bare-name fallback warns with the exact fix.
  Re-running is self-healing: observation ids are content hashes, and
  re-attaching deletes stale `ABOUT` edges.
- **Deliberately not built**: a custom web viewer (Neo4j Browser at
  `http://localhost:7474` already is one) and a background transcript-watcher
  daemon (the `PreCompact`/`SessionEnd` hooks already cover it).
- **Podman and Docker are both supported; `scripts/lib-engine.sh` picks one.**
  Podman **cannot see Docker's named volumes** — separate storage backends — so
  switching engines moves data by dump/load, not by pointing at the same
  volume. `CLAUDE_NEO4J_ENGINE` pins either.
- **`resolve_engine` follows the container first, and only then prefers
  Podman.** Naming the wrong engine never errors; it opens a different, usually
  empty database, so a bare preference is the wrong shape of rule. Among
  engines that are installed *and* whose `info` succeeds (usability is a hard
  gate, checked before any container probe), it scores each: 2 for running
  `claude-neo4j-memory`, 1 for having it stopped, 0 for not having it — highest
  wins, `podman`-first loop order settling ties, and a 2 short-circuits the
  loop so the common case never pays for the second engine's `info`.
  **The preference therefore only ever decides a machine with no container on
  either side.** A bare preference used to be the whole rule, and the moment
  Podman was installed on this machine it moved every script onto a
  nonexistent Podman container while Docker was serving the graph — that is
  the bug the scoring exists to prevent, in either direction.
- **The running/stopped distinction in `resolve_engine` is load-bearing.**
  `migrate-to-podman.sh` **stops** the Docker container and keeps it for
  rollback, so after a migration *both* engines have a container named
  `claude-neo4j-memory` and presence alone cannot say which one holds the live
  graph — scoring stopped below running is what does. It also makes rollback
  just `docker start` with no `CLAUDE_NEO4J_ENGINE` to set or unset, which is
  what the script's closing message now says.
- **The two engines use different volume names, deliberately.** Docker's stay
  `docker_claude_neo4j_data`/`_logs` — compose created them with its directory
  as a prefix, and `setup-local.sh` must never rename them: doing so strands
  the existing graph in a detached volume and yields a silently empty
  database. Podman's are the plain `claude_neo4j_data`/`_logs` — it never went
  through compose, and `migrate-to-podman.sh` creates them fresh under that
  unprefixed name — so `setup-local.sh` selects the pair by `$ENGINE` rather
  than sharing one hardcoded name across both.
- **First Podman run on a machine that never migrated looks successful but
  starts empty — and so does a Podman run after the migrated container was
  removed.** Either way Podman finds no `claude_neo4j_data` volume and just
  auto-creates a fresh, empty one with that name; the container comes up
  healthy and nothing errors — the graph is just gone. `setup-local.sh` guards
  the second case (container missing under `$ENGINE` but present under the
  other engine) and refuses rather than create, but running it under Podman is
  still not a substitute for `npm run migrate-to-podman` on a first migration;
  only the latter actually moves the data across the boundary.
- **Container healthcheck state lives at a different path per engine.**
  `.State.Health.Status` vs `.State.Healthcheck.Status`, and a template
  matching neither is an **error with a non-zero exit** — not the empty
  string it might look like it'd return. An unguarded `inspect` of this shape
  aborts the caller under `set -e` with no explanation the moment the first
  guess misses; this already happened once. `container_health` in
  `lib-engine.sh` tries both paths and guards **each** call with `|| true` —
  any similar `inspect` call needs the same guard.
- **Rootless Podman does not survive a reboot.** No daemon means `--restart`
  only holds while the user's Podman session lives. `setup-local.sh` offers a
  systemd user unit plus `loginctl enable-linger`; `check-health.sh` can only
  report the unit is absent — it has no way to tell "declined" apart from
  "never offered" or "install failed". This is the one behavioural regression
  against Docker.
- **Boot persistence is platform-shaped, and the mapping lives in one place.**
  `boot_persistence_kind`/`_installed`/`_hint` in `lib-engine.sh` return
  `docker` | `systemd` | `launchagent` | `none`; `setup-local.sh`,
  `check-health.sh` and `migrate-to-podman.sh` all read it rather than each
  restating a rule. They used to each restate the **Linux** rule, which is how
  every one of them ended up telling macOS users to run `setup-local.sh` for
  reboot survival when its systemd path returns early on Darwin and installs
  nothing. `_installed` returns **2 for "nothing to install"**, distinct from
  1 for "missing" — collapsing them nags Docker hosts about a systemd unit.
- **On macOS the VM is the thing that doesn't come back, not the container.**
  Podman runs it inside `podman-machine-default`, so `--restart unless-stopped`
  never gets to fire until the VM is up and the fix after a reboot is always
  `podman machine start` — never a re-run of `migrate-to-podman.sh` (refused by
  the already-migrated guard) and never a re-`setup-local.sh` on its own. The
  optional LaunchAgent runs at **login**, not boot: macOS has no user-level
  pre-login start and no lingering equivalent, so this is not full parity with
  systemd and the prompt says so. It also can't be detected by absence —
  Podman Desktop's *Start Podman on login* does the same job invisibly, which
  is why `check-health.sh` **warns** there instead of failing.
- **A stopped `podman machine` reads as "no engine installed" unless checked
  for.** `podman info` fails while the VM is down — the exact post-reboot
  state — so `resolve_engine` fails and `setup-local.sh` used to announce "No
  container engine found" and offer to `brew install` an already-present
  podman. Both it and `migrate-to-podman.sh` now distinguish
  installed-but-unusable and point at `podman machine start`
  (`engine_hint podman`).

## Marketplace snapshots drift from the working tree

The `.claude/settings.json` disable only covers **this** repo. Everywhere
else, the user-scope marketplace install is enabled and can serve a copy that
predates the working tree. Three layers drift independently, and only the
middle one auto-updates:

| layer | path | how to read its state |
| --- | --- | --- |
| GitHub `origin/main` | — | `git ls-remote origin main` |
| marketplace clone | `~/.claude/plugins/marketplaces/claude-neo4j-local` | `git -C <path> rev-parse --short HEAD` |
| **installed snapshot** | `~/.claude/plugins/cache/claude-neo4j-local/neo4j-memory/<version>/` | `gitCommitSha` in `~/.claude/plugins/installed_plugins.json` |

**Check those three rather than trusting any SHA written down.** The layers
are expected to differ transiently: the clone only catches up when autoUpdate
next runs, so right after a push `origin/main` is ahead of the clone, which is
ahead of the snapshot. That's normal. What matters is whether the *snapshot*
is missing code you depend on.

`autoUpdate: true` refreshes the *clone*, and re-copies it into the cached
install **only when the version moved** — which is the whole mechanism behind
the bump rule below. Push within a version and `installed_plugins.json` keeps
its old `gitCommitSha` while every non-this-repo session loads the old code;
bump it and the next autoUpdate lands the new snapshot unattended, with no
`claude plugin update` run at all. The snapshot is a plain copy, not a git
checkout, so `git log` inside it fails — compare it with
`diff -rq <snapshot>/src <clone>/src` instead.

The snapshot path contains the **version**, so a version bump changes it and
orphans the old directory. Glob the version component rather than hardcoding
it, or you will grep a directory nothing loads from. Nothing prunes the
orphan — it is a full copy, tens of MB, and safe to delete once no
`installPath` in `installed_plugins.json` names it.

**`claude plugin update` is a no-op unless the version changed** — it compares
the `version` in `.claude-plugin/plugin.json`, and there is no `--force`. So
**bump `version` on every push other projects should pick up**
(`package.json` carries the same number; keep them together). Otherwise
nothing will even prompt you that the snapshot has drifted. The fallback, for
drift within a single version:

```
claude plugin uninstall neo4j-memory@claude-neo4j-local --scope user
claude plugin install   neo4j-memory@claude-neo4j-local --scope user
```

Verify by diffing, or by grepping the snapshot for a symbol you know only
exists in the new code — **never with `claude plugin list`**, which reports
the version either way and so cannot distinguish fresh from stale.

Stale-snapshot failures are hard to read as such: when captures in other repos
timed out, the message was indistinguishable from a genuine timeout except for
the *value* (`90000ms`, the snapshot's old constant, against a HEAD that had
moved to `180_000`). **Check the numbers in the error, not just the failure.**
**`claude plugin uninstall --scope project` rewrites `.claude/settings.json`
and takes the `enabledPlugins` disable with it.** This repo carried a stale
project-scope record from an early install, pinned to its own older
`gitCommitSha`; once the version bump gave it a separate `installPath` it was
no longer merely cosmetic, so it was uninstalled — and that silently
re-enabled the marketplace copy here, the one thing that file exists to
prevent. The file is tracked, so `git diff` catches it. Check the working
tree after any `claude plugin` command run inside this repo.

## Open

- **Why extraction sometimes takes minutes is unknown.** Five timeouts in
  ~300 log lines, at 90s/80s/180s — including the detached path's full
  headroom, so this is not simply "the inline budget is too tight". The code
  that would have explained it discarded the evidence; that's fixed, so the
  *next* occurrence should be diagnosable from `capture.log`. Until one lands,
  raising a timeout would be a symptom fix. (The old comment blaming
  "contention, not the size of the input" was never evidence-backed.)
- ~~`PreCompact` unverified against a real compaction~~ — **closed 2026-07-31.**
  A real `/compact` wrote `PreCompact: captured 0 observation(s) for session …
  (1 chunk(s))` to `capture.log`, a line that could not have existed before the
  same day's logging fix. It is also covered in `tests/capture-hook.test.js`
  through the real hook entry point (real Neo4j writes, faked model, both
  outcomes); that test skips itself where no container is reachable. Note the
  count was **0** — a legitimate result, but it means the write path itself is
  still only proven by the test, not by that run.
