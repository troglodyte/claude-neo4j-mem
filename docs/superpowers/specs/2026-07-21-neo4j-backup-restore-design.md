# Neo4j backup/restore helpers — design

Date: 2026-07-21

## Problem

The memory graph in the local Neo4j container is the only copy of this
plugin's accumulated history. There is no way to snapshot it before a risky
change (a schema migration, a `memory_prune`, a bad merge), and no way to get
it back if the Docker volume is lost. `scripts/cypher.sh` can read the graph
but nothing captures or reinstates it wholesale.

## Approach

Use Neo4j's official `neo4j-admin database dump` / `database load`, which
produce and consume a full-fidelity single-file archive. Chosen over a logical
JSON export because it captures the store exactly — indexes, constraints, and
any node the memory schema doesn't know about — rather than only the entities
and observations the plugin happens to model today.

The cost of that choice is that the archive is file-level, so:

- **Local mode only.** A dump cannot reach a remote instance such as Aura.
  Both scripts refuse in remote mode and name the alternative instead of
  failing obscurely.
- **The database must be unmounted.** `neo4j-admin` refuses to dump or load a
  database that a running server holds. Both scripts stop the container and
  restart it afterwards.

Neither script needs Neo4j credentials for the dump itself — it operates on
the store files. Credentials are only used for the restore pre-flight counts,
via the existing `scripts/cypher.sh`.

## Shared mechanics

Both scripts follow the conventions already established in `scripts/`:

- Two-step repo-root resolution followed by a `.claude-plugin/plugin.json`
  assertion, so neither can operate on a bogus root (see
  `tests/launcher-path.test.sh` and the 2026-07-21 `--plugin-dir /` incident).
- `mode` and `database` read from `~/.claude-neo4j/config.json` with `jq`,
  matching `cypher.sh`'s resolution order.
- `set -o pipefail`, so a failure inside a pipeline is not masked by the exit
  status of the last command.

The dump and load both run in a **one-shot sibling container** that borrows the
data volume:

```
docker run --rm --volumes-from claude-neo4j-memory neo4j:5-community neo4j-admin ...
```

This works while the main container is stopped, and avoids needing a bind
mount or an in-container temp file. Archives stream over stdout/stdin
(`--to-stdout` / `--from-stdin`), so the host filesystem is the only place a
backup is ever written.

**Container lifecycle.** Each script records whether the container was running,
then installs a `trap` that restarts it on *any* exit path — success, dump
failure, or Ctrl-C. A backup that fails must not leave the memory graph
offline.

## `scripts/backup.sh` (`npm run backup`)

1. Resolve root and config; refuse if mode is remote.
2. Record running state, install the restart trap, stop the container.
3. Dump: `neo4j-admin database dump <db> --to-stdout > "$OUT"`, optionally
   piped through `xz -T0 -c` when `--xz` is given. neo4j-admin's stderr is
   captured to a temp file rather than discarded — stdout carries the archive,
   so its diagnostics are the only clue when a dump fails.
4. Write a `.sha256` sidecar next to the archive.
5. Restart the container and wait for health, then print the path and size.

Output defaults to `~/.claude-neo4j/backups/neo4j-YYYYMMDD-HHMMSS.dump`.

Flags: `--out PATH`, `--keep N` (prune all but the N newest backups in the
backups directory after a successful run; never prunes on failure, and never
touches files outside that directory), `--list`, `--help`.

**On xz — measured, then dropped as the default.** The `.dump` format reports
itself as `Neo4j ZSTD Dump`, i.e. already compressed. On the real graph (78
entities, 1187 observations) xz took 897,959 bytes to 890,004 — a 0.9% saving.
That is far under the 10% bar this design set for itself, so compression is
**off by default** and `--xz` is an opt-in for shipping archives over metered
links. `restore.sh` sniffs the input by magic bytes, so both forms restore.

## `scripts/restore.sh` (`npm run restore`)

1. Resolve root and config; refuse if mode is remote.
2. Take a backup path, or `--latest` to select the newest file in the backups
   directory.
3. **Verify before destroying**, in two steps. `neo4j-admin database load
   --info --from-stdin` reports the archive's format and byte count without
   loading it, which rejects a non-Neo4j or garbage file. It is **not**
   sufficient on its own: it parses only the archive header, and a 5KB head of
   an 877KB dump still reported the full 60 files / 271,985,669 bytes as valid.
   So `backup.sh` also writes a `.sha256` sidecar and `restore.sh` checks it
   first — that is what actually catches truncation, before the load has
   overwritten anything. A missing sidecar is a warning, not an error.
4. **Pre-flight.** Query the current entity and observation counts through
   `scripts/cypher.sh` and display exactly what is about to be destroyed —
   `--overwrite-destination` is unrecoverable without another backup.
5. **Confirm.** Require the user to type the target database name (e.g.
   `neo4j`) to proceed. A bare `y` is too easy to hit reflexively for an
   operation that discards the graph. `--force` skips the prompt for
   scripting.
6. Stop the container (restart trap installed first), then pipe the archive
   into `neo4j-admin database load <db> --from-stdin --overwrite-destination`,
   decompressing first if the magic bytes say it is xz. Sniffing by content
   rather than extension means a renamed or hand-decompressed archive works.
7. Restart, wait for health, and print the post-restore counts so the round
   trip is verified in-band rather than assumed.

## Testing

- Both scripts are added to the script list in `tests/launcher-path.test.sh`,
  so `npm test` covers their root resolution against the `--plugin-dir /`
  class of failure.
- A real round trip, run manually during implementation: record counts, back
  up, add a throwaway observation, restore, then confirm the counts return to
  their pre-backup values and the throwaway observation is gone. Delete the
  throwaway data afterwards, per the existing convention.
- Confirm the container is restarted after an *induced* dump failure, not only
  after a successful one — the trap is the part most likely to be wrong.

## Documentation

`README.md` and `CLAUDE.md` gain the two commands under their existing command
lists, including the remote-mode limitation.
