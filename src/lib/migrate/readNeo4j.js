import neo4j from "neo4j-driver";

// One query per element type. `id(o)` is Neo4j's internal creation order, used
// only to keep same-millisecond observations in the order they were written
// (deprecated in Neo4j 5 but still served; elementId's format is not ordered).
const QUERIES = {
  entities: `MATCH (e:Entity)
    RETURN e.name AS name, e.project AS project, e.type AS type, e.createdAt AS createdAt, e.updatedAt AS updatedAt`,
  observations: `MATCH (o:Observation)
    OPTIONAL MATCH (o)-[:ABOUT]->(e:Entity)
    RETURN o.id AS id, e.name AS entityName, e.project AS entityProject, o.text AS text, o.subsystem AS subsystem,
           o.source AS source, o.sessionId AS sessionId, o.createdAt AS createdAt, id(o) AS seq`,
  relations: `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
    RETURN a.name AS fromName, a.project AS fromProject, r.type AS type,
           b.name AS toName, b.project AS toProject, r.createdAt AS createdAt`,
  sessions: `MATCH (s:Session)
    RETURN s.id AS id, s.cwd AS cwd, s.project AS project, s.startedAt AS startedAt`,
  sessionLinks: `MATCH (s:Session)-[:PRODUCED]->(o:Observation)
    RETURN s.id AS sessionId, o.id AS observationId`,
};

// Everything the migration carries. The queries above read exactly these
// labels, relationship shapes and properties, so anything else in the graph
// would be left behind with no trace in the row check. The inventory below
// finds it, and validation stops the run before anything is written.
// `source` is set by migrate-from-claude-mem on every observation it imports.
export const MAPPED = {
  nodes: {
    Entity: ["name", "project", "type", "createdAt", "updatedAt"],
    Observation: ["id", "text", "subsystem", "source", "sessionId", "createdAt"],
    Session: ["id", "cwd", "project", "startedAt"],
  },
  relationships: {
    ABOUT: { from: "Observation", to: "Entity", keys: [] },
    PRODUCED: { from: "Session", to: "Observation", keys: [] },
    RELATES_TO: { from: "Entity", to: "Entity", keys: ["type", "createdAt"] },
  },
};

const INVENTORY = {
  nodeLabels: "MATCH (n) RETURN labels(n) AS labels, count(*) AS count",
  nodeKeys: "MATCH (n) UNWIND keys(n) AS key RETURN labels(n) AS labels, key, count(*) AS count",
  relationshipPatterns: "MATCH (a)-[r]->(b) RETURN labels(a) AS from, type(r) AS type, labels(b) AS to, count(*) AS count",
  relationshipKeys: "MATCH ()-[r]->() UNWIND keys(r) AS key RETURN type(r) AS type, key, count(*) AS count",
};

/**
 * The whole graph as migration records, read in one read transaction. Neo4j
 * refuses any write inside executeRead, so this cannot modify the source.
 */
export async function readGraph(session) {
  const raw = await session.executeRead(async (tx) => {
    const rows = { inventory: {} };
    for (const [type, query] of Object.entries(QUERIES)) {
      rows[type] = (await tx.run(query)).records.map((record) => record.toObject());
    }
    for (const [part, query] of Object.entries(INVENTORY)) {
      rows.inventory[part] = (await tx.run(query)).records.map((record) => record.toObject());
    }
    return rows;
  });
  return toRecords(raw);
}

/**
 * Raw Neo4j rows to migration records, plus `unmapped`: what the graph holds
 * that the records cannot carry. No I/O; exported for tests.
 */
export function toRecords(raw) {
  return {
    entities: raw.entities.map((e) => ({
      name: e.name,
      project: e.project ?? "",
      type: e.type ?? null,
      createdAt: toEpochMs(e.createdAt, `entity ${e.name} createdAt`),
      updatedAt: toEpochMs(e.updatedAt, `entity ${e.name} updatedAt`),
    })),
    observations: raw.observations.map((o) => ({
      id: o.id,
      entityName: o.entityName ?? null,
      entityProject: o.entityProject ?? "",
      text: o.text ?? null,
      subsystem: o.subsystem ?? null,
      source: o.source ?? null,
      sessionId: o.sessionId ?? null,
      createdAt: toEpochMs(o.createdAt, `observation ${o.id} createdAt`),
      seq: neo4j.integer.toNumber(o.seq),
    })),
    relations: raw.relations.map((r) => ({
      fromName: r.fromName,
      fromProject: r.fromProject ?? "",
      type: r.type ?? null,
      toName: r.toName,
      toProject: r.toProject ?? "",
      createdAt: toEpochMs(r.createdAt, `relation ${r.fromName} -${r.type}-> ${r.toName} createdAt`),
    })),
    sessions: raw.sessions.map((s) => ({
      id: s.id,
      cwd: s.cwd ?? null,
      project: s.project ?? null,
      startedAt: toEpochMs(s.startedAt, `session ${s.id} startedAt`),
    })),
    sessionLinks: raw.sessionLinks.map((link) => ({ sessionId: link.sessionId, observationId: link.observationId })),
    unmapped: raw.inventory ? inventoryProblems(raw.inventory) : [],
  };
}

/** One line per label, relationship shape or property the migration would leave behind. */
export function inventoryProblems(inventory) {
  return [
    ...inventory.nodeLabels.filter((row) => !mappedNode(row.labels)).map(describeLabels),
    ...inventory.nodeKeys.filter(isUnmappedNodeKey).map((row) => `${row.labels[0]}.${row.key} on ${count(row)} node(s) is not migrated`),
    ...inventory.relationshipPatterns.filter(isUnmappedPattern).map(describePattern),
    ...inventory.relationshipKeys.filter(isUnmappedRelationshipKey).map((row) => `${row.type}.${row.key} on ${count(row)} relationship(s) is not migrated`),
  ];
}

const count = (row) => neo4j.integer.toNumber(row.count);
const shown = (labels) => labels.map((label) => `:${label}`).join("");

// A node is carried only when it has exactly one label and that label is mapped.
function mappedNode(labels) {
  return labels.length === 1 && Object.hasOwn(MAPPED.nodes, labels[0]) ? MAPPED.nodes[labels[0]] : null;
}

function mappedRelationship(type) {
  return Object.hasOwn(MAPPED.relationships, type) ? MAPPED.relationships[type] : null;
}

// Keys on a node whose labels are themselves unmapped are already reported by label.
function isUnmappedNodeKey(row) {
  const keys = mappedNode(row.labels);
  return keys !== null && !keys.includes(row.key);
}

function isUnmappedPattern(row) {
  const shape = mappedRelationship(row.type);
  return !shape || shown(row.from) !== `:${shape.from}` || shown(row.to) !== `:${shape.to}`;
}

function isUnmappedRelationshipKey(row) {
  const shape = mappedRelationship(row.type);
  return shape !== null && !shape.keys.includes(row.key);
}

function describeLabels(row) {
  return `${count(row)} node(s) labelled ${shown(row.labels) || "(no label)"} are not migrated`;
}

function describePattern(row) {
  return `${count(row)} :${row.type} relationship(s) from ${shown(row.from)} to ${shown(row.to)} are not migrated`;
}

/**
 * A Neo4j zoned datetime to epoch milliseconds. Every temporal value in the
 * live graph is a UTC zoned datetime at millisecond precision, so this is
 * exact. A local datetime, a string, or sub-millisecond precision throws
 * with `what` in the message rather than being guessed at.
 */
export function toEpochMs(value, what) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!neo4j.isDateTime(value)) {
    throw new Error(`${what} is not a zoned datetime: ${String(value)}`);
  }
  if (neo4j.integer.toNumber(value.nanosecond) % 1_000_000 !== 0) {
    throw new Error(`${what} has sub-millisecond precision: ${value.toString()}`);
  }
  return value.toStandardDate().getTime();
}
