import { createHash } from "node:crypto";

/**
 * The migration's record shapes: plain objects keyed by natural keys, never by
 * Neo4j or SQLite ids. Timestamps are epoch milliseconds (UTC); a global
 * entity's project is "".
 *
 * @typedef {{ name: string, project: string, type: string|null, createdAt: number, updatedAt: number|null }} EntityRecord
 * @typedef {{ id: string, entityName: string, entityProject: string, text: string, subsystem: string|null,
 *             sessionId: string|null, createdAt: number, seq: number }} ObservationRecord
 * @typedef {{ fromName: string, fromProject: string, type: string, toName: string, toProject: string,
 *             createdAt: number|null }} RelationRecord
 * @typedef {{ id: string, cwd: string|null, project: string|null, startedAt: number }} SessionRecord
 * @typedef {{ sessionId: string, observationId: string }} SessionLinkRecord
 * @typedef {{ entities: EntityRecord[], observations: ObservationRecord[], relations: RelationRecord[],
 *             sessions: SessionRecord[], sessionLinks: SessionLinkRecord[] }} GraphRecords
 */

// Every comparison and fingerprint reads fields through these lists, so a field
// cannot be carried on one side and silently skipped by the check. `seq`
// (Neo4j's internal id, SQLite's rowid) orders same-millisecond observations;
// it is metadata, not data, and is deliberately absent.
export const FIELDS = {
  entities: ["name", "project", "type", "createdAt", "updatedAt"],
  observations: ["id", "entityName", "entityProject", "text", "subsystem", "source", "sessionId", "createdAt"],
  relations: ["fromName", "fromProject", "type", "toName", "toProject", "createdAt"],
  sessions: ["id", "cwd", "project", "startedAt"],
  sessionLinks: ["sessionId", "observationId"],
};

export const KEY_FIELDS = {
  entities: ["name", "project"],
  observations: ["id"],
  relations: ["fromName", "fromProject", "type", "toName", "toProject"],
  sessions: ["id"],
  sessionLinks: ["sessionId", "observationId"],
};

export const RECORD_TYPES = Object.keys(FIELDS);

/**
 * The value a field is compared by. UTF-8 cannot hold an unpaired UTF-16
 * surrogate (truncateText can leave one when it cuts through an emoji), so text
 * is compared in its well-formed form: the form the writer stores.
 */
export function normaliseField(field, value) {
  if (value === undefined) {
    return null;
  }
  return field === "text" && typeof value === "string" ? value.toWellFormed() : value;
}

/** A record's natural key, as a string usable in a Map. */
export function keyOf(type, record) {
  return JSON.stringify(KEY_FIELDS[type].map((field) => normaliseField(field, record[field])));
}

/** The record's compared fields in a fixed order; JSON keeps null distinct from "". */
export function canonicalRow(type, record) {
  return JSON.stringify(FIELDS[type].map((field) => normaliseField(field, record[field])));
}

/** Per-type row counts and a SHA-256 over the sorted canonical rows. */
export function fingerprint(records) {
  const result = { counts: {}, hashes: {} };
  for (const type of RECORD_TYPES) {
    const rows = records[type].map((record) => canonicalRow(type, record)).sort();
    result.counts[type] = rows.length;
    result.hashes[type] = createHash("sha256").update(rows.join("\n")).digest("hex");
  }
  return result;
}

function sameFingerprint(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Neo4j reads are read-committed, not a snapshot, so a capture landing mid-read
 * would tear the copy. Two back-to-back reads with identical fingerprints prove
 * nothing changed in between; each mismatch costs one more read.
 */
export async function readConsistentGraph(readOnce, { maxAttempts = 5 } = {}) {
  let previous = await readOnce();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await readOnce();
    if (sameFingerprint(fingerprint(previous), fingerprint(current))) {
      return { consistent: true, records: current, reads: attempt + 1 };
    }
    previous = current;
  }
  return { consistent: false, records: null, reads: maxAttempts + 1 };
}
