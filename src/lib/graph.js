import { randomUUID } from "node:crypto";
import { withSession, int } from "./neo4jClient.js";

async function upsertEntity(session, name, type, project) {
  await session.run(
    `MERGE (e:Entity {name: $name})
     ON CREATE SET e.type = $type, e.project = $project, e.createdAt = datetime()
     ON MATCH SET e.type = coalesce($type, e.type), e.updatedAt = datetime()`,
    { name, type: type ?? null, project: project ?? null }
  );
}

export async function upsertSession({ id, cwd, project }) {
  return withSession(async (session) => {
    await session.run(
      `MERGE (s:Session {id: $id})
       ON CREATE SET s.startedAt = datetime(), s.cwd = $cwd, s.project = $project`,
      { id, cwd: cwd ?? null, project: project ?? null }
    );
  });
}

export async function addObservations({ entity, entityType, observations, sessionId, project }) {
  const rows = observations.map((text) => ({ id: randomUUID(), text }));
  await withSession(async (session) => {
    await upsertEntity(session, entity, entityType, project);
    await session.run(
      `MATCH (e:Entity {name: $entity})
       UNWIND $rows AS row
       CREATE (o:Observation {id: row.id, text: row.text, createdAt: datetime(), sessionId: $sessionId})
       CREATE (o)-[:ABOUT]->(e)
       WITH o
       CALL {
         WITH o
         OPTIONAL MATCH (s:Session {id: $sessionId})
         WITH o, s WHERE s IS NOT NULL
         CREATE (s)-[:PRODUCED]->(o)
       }`,
      { entity, rows, sessionId: sessionId ?? null }
    );
  });
  return rows.map((r) => r.id);
}

export async function createRelation({ from, to, type, project }) {
  return withSession(async (session) => {
    await upsertEntity(session, from, null, project);
    await upsertEntity(session, to, null, project);
    await session.run(
      `MATCH (a:Entity {name: $from}), (b:Entity {name: $to})
       MERGE (a)-[r:RELATES_TO {type: $type}]->(b)
       ON CREATE SET r.createdAt = datetime()`,
      { from, to, type }
    );
  });
}

export async function searchMemory(query, limit = 10) {
  return withSession(async (session) => {
    const result = await session.run(
      `CALL {
         CALL db.index.fulltext.queryNodes('entityNameFulltext', $query) YIELD node, score
         RETURN node AS entity, score
         UNION
         CALL db.index.fulltext.queryNodes('observationTextFulltext', $query) YIELD node, score
         MATCH (node)-[:ABOUT]->(entity)
         RETURN entity, score
       }
       WITH entity, max(score) AS score
       ORDER BY score DESC
       LIMIT $limit
       OPTIONAL MATCH (o:Observation)-[:ABOUT]->(entity)
       WITH entity, score, o
       ORDER BY o.createdAt DESC
       WITH entity, score, collect(o.text)[0..5] AS observations
       OPTIONAL MATCH (entity)-[r:RELATES_TO]-(other)
       WITH entity, score, observations, collect(DISTINCT CASE WHEN r IS NULL THEN NULL ELSE {type: r.type, entity: other.name} END) AS relationsRaw
       WITH entity, score, observations, [x IN relationsRaw WHERE x IS NOT NULL] AS relations
       RETURN entity.name AS name, entity.type AS type, score, observations, relations
       ORDER BY score DESC`,
      { query, limit: int(limit) }
    );
    return result.records.map((r) => r.toObject());
  });
}

export async function getEntity(name) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (e:Entity {name: $name})
       OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
       WITH e, o ORDER BY o.createdAt DESC
       WITH e, collect(CASE WHEN o IS NULL THEN NULL ELSE {id: o.id, text: o.text, createdAt: toString(o.createdAt)} END) AS observationsRaw
       WITH e, [x IN observationsRaw WHERE x IS NOT NULL] AS observations
       OPTIONAL MATCH (e)-[r:RELATES_TO]->(out)
       WITH e, observations, collect(DISTINCT CASE WHEN r IS NULL THEN NULL ELSE {type: r.type, entity: out.name} END) AS outgoingRaw
       WITH e, observations, [x IN outgoingRaw WHERE x IS NOT NULL] AS outgoing
       OPTIONAL MATCH (e)<-[r2:RELATES_TO]-(in)
       WITH e, observations, outgoing, collect(DISTINCT CASE WHEN r2 IS NULL THEN NULL ELSE {type: r2.type, entity: in.name} END) AS incomingRaw
       WITH e, observations, outgoing, [x IN incomingRaw WHERE x IS NOT NULL] AS incoming
       RETURN e.name AS name, e.type AS type, e.project AS project, observations, outgoing, incoming`,
      { name }
    );
    return result.records[0]?.toObject() ?? null;
  });
}

export async function getRecentContext({ project, limit = 15 }) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE $project IS NULL OR e.project = $project OR e.project IS NULL
       WITH e, o ORDER BY o.createdAt DESC
       WITH e, collect(o.text)[0..3] AS observations, max(o.createdAt) AS lastSeen
       ORDER BY lastSeen DESC
       LIMIT $limit
       RETURN e.name AS name, e.type AS type, observations
       ORDER BY lastSeen DESC`,
      { project: project ?? null, limit: int(limit) }
    );
    return result.records.map((r) => r.toObject());
  });
}

export async function deleteObservations(entity, observationIds) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (e:Entity {name: $entity})<-[:ABOUT]-(o:Observation)
       WHERE o.id IN $observationIds
       DETACH DELETE o
       RETURN count(o) AS deleted`,
      { entity, observationIds }
    );
    return result.records[0]?.get("deleted").toNumber() ?? 0;
  });
}

export async function deleteEntity(entity) {
  return withSession(async (session) => {
    await session.run(
      `MATCH (e:Entity {name: $entity})
       OPTIONAL MATCH (e)<-[:ABOUT]-(o:Observation)
       DETACH DELETE e, o`,
      { entity }
    );
  });
}

export async function getStatus({ project }) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (e:Entity) WHERE $project IS NULL OR e.project = $project OR e.project IS NULL
       WITH count(e) AS entityCount
       MATCH (o:Observation)
       RETURN entityCount, count(o) AS observationCount`,
      { project: project ?? null }
    );
    const record = result.records[0];
    return {
      entityCount: record?.get("entityCount")?.toNumber() ?? 0,
      observationCount: record?.get("observationCount")?.toNumber() ?? 0,
    };
  });
}
