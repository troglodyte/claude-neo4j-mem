import { inTransaction } from "./memoryStore.js";

// The store side of `npm run backfill-subsystems`: which observations to
// classify, and writing the result back. The classification itself lives in
// scripts/backfill-subsystems.mjs.

/**
 * Untagged observations by default, so a re-run after an interruption picks up
 * exactly what is left. With `retag`, the observations already carrying that
 * tag instead, which is how a junk drawer an earlier run created gets emptied.
 * Grouped by entity, largest first: the big entities establish the vocabulary
 * every smaller one then reuses.
 */
export function pendingEntities(db, { project = null, retag = null } = {}) {
  const rows = db
    .prepare(
      `SELECT e.id AS entityId, e.name, e.type, e.project, o.id, o.text
         FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE (:project IS NULL OR e.project = :project)
          AND ((:retag IS NULL AND o.subsystem IS NULL) OR o.subsystem = :retag)
        ORDER BY o.rowid`,
    )
    .all({ project, retag });
  const byEntity = new Map();
  for (const { entityId, name, type, project: entityProject, id, text } of rows) {
    const entity = byEntity.get(entityId) ?? { name, type, project: entityProject, observations: [] };
    entity.observations.push({ id, text });
    byEntity.set(entityId, entity);
  }
  return [...byEntity.values()]
    .map((entity) => ({ ...entity, pending: entity.observations.length }))
    .sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name));
}

/**
 * Sets each row's subsystem; null clears it, which is what lets `--retag
 * general` empty the junk drawer rather than merely relabel it. Duplicate ids
 * resolve to the last assignment, and the count is of distinct observations.
 */
export function writeTags(db, rows) {
  const latest = new Map(rows.map((row) => [row.id, row.subsystem]));
  const update = db.prepare("UPDATE observations SET subsystem = ? WHERE id = ?");
  return inTransaction(db, () =>
    [...latest].reduce((updated, [id, subsystem]) => updated + Number(update.run(subsystem, id).changes), 0),
  );
}
