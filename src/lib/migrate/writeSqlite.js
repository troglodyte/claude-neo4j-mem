import { keyOf } from "./fingerprint.js";
import { syncFullText } from "../sqliteDb.js";

export class InvalidRecordsError extends Error {
  constructor(problems) {
    super(
      `${problems.length} problem(s) in the source graph that SQLite cannot represent:\n  ` +
        problems.slice(0, 20).join("\n  ")
    );
    this.name = "InvalidRecordsError";
    this.problems = problems;
  }
}

const REQUIRED = {
  entities: ["name", "createdAt"],
  observations: ["id", "entityName", "text", "createdAt"],
  relations: ["type"],
  sessions: ["id", "startedAt"],
};

const TIMESTAMPS = {
  entities: ["createdAt", "updatedAt"],
  observations: ["createdAt"],
  relations: ["createdAt"],
  sessions: ["startedAt"],
};

/**
 * Everything the source holds that the schema cannot: duplicate natural keys
 * (Neo4j's uniqueness constraint ignores a null project, so two global entities
 * can share a name; an observation with two ABOUT edges reads as two rows),
 * observations without an entity, relation ends that are not entities, missing
 * required fields, and timestamps that are not whole milliseconds. Empty means
 * writable.
 */
export function validateRecords(records) {
  // Labels, relationship shapes and properties the records cannot carry
  // (readNeo4j's inventory): copying without them would lose data silently.
  const problems = [...(records.unmapped ?? [])];
  for (const type of Object.keys(REQUIRED)) {
    const seen = new Set();
    for (const record of records[type]) {
      const key = keyOf(type, record);
      if (seen.has(key)) {
        problems.push(`duplicate ${type} ${key}`);
      }
      seen.add(key);
      for (const field of REQUIRED[type]) {
        if (record[field] === null || record[field] === undefined) {
          problems.push(`${type} ${key} has no ${field}`);
        }
      }
      for (const field of TIMESTAMPS[type]) {
        const value = record[field];
        if (value !== null && value !== undefined && !Number.isSafeInteger(value)) {
          problems.push(`${type} ${key} has a ${field} that is not whole milliseconds`);
        }
      }
    }
  }
  const entityKey = (name, project) => keyOf("entities", { name, project });
  const entities = new Set(records.entities.map((entity) => keyOf("entities", entity)));
  for (const observation of records.observations) {
    if (!entities.has(entityKey(observation.entityName, observation.entityProject))) {
      problems.push(`observation ${observation.id} belongs to no entity`);
    }
  }
  for (const relation of records.relations) {
    for (const [name, project] of [
      [relation.fromName, relation.fromProject],
      [relation.toName, relation.toProject],
    ]) {
      if (!entities.has(entityKey(name, project))) {
        problems.push(`relation ${keyOf("relations", relation)} ends at ${entityKey(name, project)}, which is not an entity`);
      }
    }
  }
  return problems;
}

/**
 * Inserts every record whose natural key is not already in the file, in one
 * transaction, and never updates an existing row: a re-run adds only what is
 * missing. Throws InvalidRecordsError before writing anything if validation
 * fails; any SQLite error rolls the whole write back.
 */
export function writeGraph(db, records) {
  const problems = validateRecords(records);
  if (problems.length > 0) {
    throw new InvalidRecordsError(problems);
  }

  const inserted = { entities: 0, sessions: 0, observations: 0, relations: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertEntity = db.prepare(
      `INSERT INTO entities (name, project, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name, project) DO NOTHING`
    );
    for (const e of inCreationOrder(records.entities)) {
      inserted.entities += insertEntity.run(e.name, e.project, e.type ?? null, e.createdAt, e.updatedAt ?? null).changes;
    }

    const entityIds = new Map(
      db.prepare("SELECT id, name, project FROM entities").all().map((row) => [keyOf("entities", row), row.id])
    );
    const entityId = (name, project) => entityIds.get(keyOf("entities", { name, project }));

    const insertSession = db.prepare(
      "INSERT INTO sessions (id, cwd, project, started_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING"
    );
    for (const s of records.sessions) {
      inserted.sessions += insertSession.run(s.id, s.cwd ?? null, s.project ?? null, s.startedAt).changes;
    }

    const insertObservation = db.prepare(
      `INSERT INTO observations (id, entity_id, text, subsystem, source, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`
    );
    for (const o of inCreationOrder(records.observations)) {
      inserted.observations += insertObservation.run(
        o.id,
        entityId(o.entityName, o.entityProject),
        o.text.toWellFormed(),
        o.subsystem ?? null,
        o.source ?? null,
        o.sessionId ?? null,
        o.createdAt
      ).changes;
    }

    const insertRelation = db.prepare(
      `INSERT INTO relations (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (from_id, to_id, type) DO NOTHING`
    );
    for (const r of records.relations) {
      inserted.relations += insertRelation.run(
        entityId(r.fromName, r.fromProject),
        entityId(r.toName, r.toProject),
        r.type,
        r.createdAt ?? null
      ).changes;
    }
    syncFullText(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const skipped = Object.fromEntries(Object.keys(inserted).map((type) => [type, records[type].length - inserted[type]]));
  return { inserted, skipped };
}

// createdAt, then Neo4j's creation order (seq), then the natural key. Rows from
// one write batch share a timestamp, so rowid then preserves the order Neo4j
// created them in: the tie-breaker "newest first" relies on.
function inCreationOrder(rows) {
  const tieKey = (row) => row.id ?? keyOf("entities", row);
  return [...rows].sort(
    (a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0) || compare(tieKey(a), tieKey(b))
  );
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
