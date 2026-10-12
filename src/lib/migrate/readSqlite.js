/**
 * A SQLite memory file as migration records: the same shape readNeo4j
 * produces, so the two sides compare field for field. Session links are
 * derived (a session id with no session row has no link), exactly as
 * PRODUCED edges existed only where the Session node did.
 */
export function readSqliteGraph(db) {
  return {
    entities: db
      .prepare("SELECT name, project, type, created_at AS createdAt, updated_at AS updatedAt FROM entities")
      .all(),
    observations: db
      .prepare(
        `SELECT o.id, e.name AS entityName, e.project AS entityProject, o.text, o.subsystem, o.source,
                o.session_id AS sessionId, o.created_at AS createdAt, o.rowid AS seq
         FROM observations o JOIN entities e ON e.id = o.entity_id`
      )
      .all(),
    relations: db
      .prepare(
        `SELECT a.name AS fromName, a.project AS fromProject, r.type, b.name AS toName, b.project AS toProject,
                r.created_at AS createdAt
         FROM relations r JOIN entities a ON a.id = r.from_id JOIN entities b ON b.id = r.to_id`
      )
      .all(),
    sessions: db.prepare("SELECT id, cwd, project, started_at AS startedAt FROM sessions").all(),
    sessionLinks: db
      .prepare(
        `SELECT s.id AS sessionId, o.id AS observationId
         FROM observations o JOIN sessions s ON s.id = o.session_id`
      )
      .all(),
  };
}
