import { randomUUID } from "node:crypto";
import { withSession, int } from "./neo4jClient.js";
import { resolveCanonicalName } from "./dedup.js";
import { BUDGETS, truncateText, fitToBudget } from "./budget.js";

// Callers search with plain phrases and with entity names, and this plugin's
// naming convention puts Lucene syntax characters right in those names
// ("feature:capture-visibility"). Unescaped, Lucene reads the colon as a field
// separator and the hyphen as negation, so searching for an entity by its own
// name parsed as a query against a nonexistent field and silently returned
// nothing. Escaping trades wildcard support for queries that mean what they say.
const LUCENE_SPECIAL = /([+\-!(){}[\]^"~*?:\\/&|])/g;

function escapeLuceneQuery(query) {
  return query.replace(LUCENE_SPECIAL, "\\$1");
}

// Cypher can't match a literal `null` in a property map (MERGE {project: null}
// never finds an existing node, since equality against null is always
// unknown) - every project-scoped MATCH/MERGE below spells the comparison out
// as "(project IS NOT NULL AND x.project = $project) OR (project IS NULL AND
// x.project IS NULL)" instead of relying on map-literal equality.

async function upsertEntity(session, name, type, project) {
  await session.run(
    `OPTIONAL MATCH (existing:Entity {name: $name})
       WHERE ($project IS NOT NULL AND existing.project = $project) OR ($project IS NULL AND existing.project IS NULL)
     FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
       CREATE (new:Entity {name: $name, project: $project, type: $type, createdAt: datetime()})
     )
     WITH existing
     WHERE existing IS NOT NULL
     SET existing.type = coalesce($type, existing.type), existing.updatedAt = datetime()`,
    { name, type: type ?? null, project: project ?? null }
  );
}

export async function listEntityNames(project) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (e:Entity) WHERE $project IS NULL OR e.project = $project OR e.project IS NULL
       RETURN e.name AS name`,
      { project: project ?? null }
    );
    return result.records.map((r) => r.get("name"));
  });
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

// `existingNames` lets a caller writing several entities in a row fetch the
// name list once instead of per call. It used to be fetched inside the session
// below - a nested session acquisition plus a full re-scan of every entity name
// on each call, so one 8-entity capture opened 16 sessions and ran the same
// scan 8 times.
export async function addObservations({ entity, entityType, observations, sessionId, project, existingNames }) {
  // Bounded on the way in, so one runaway observation can't inflate every
  // future read that touches this entity.
  const rows = observations.map((text) => ({
    id: randomUUID(),
    text: truncateText(text, BUDGETS.writeTextChars),
  }));
  const names = existingNames ?? (await listEntityNames(project));
  entity = resolveCanonicalName(entity, names);
  await withSession(async (session) => {
    await upsertEntity(session, entity, entityType, project);
    await session.run(
      `MATCH (e:Entity {name: $entity})
       WHERE ($project IS NOT NULL AND e.project = $project) OR ($project IS NULL AND e.project IS NULL)
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
      { entity, rows, sessionId: sessionId ?? null, project: project ?? null }
    );
  });
  return rows.map((r) => r.id);
}

export async function createRelation({ from, to, type, project }) {
  return withSession(async (session) => {
    const existingNames = await listEntityNames(project);
    from = resolveCanonicalName(from, existingNames);
    to = resolveCanonicalName(to, existingNames);
    await upsertEntity(session, from, null, project);
    await upsertEntity(session, to, null, project);
    await session.run(
      `MATCH (a:Entity {name: $from}), (b:Entity {name: $to})
       WHERE (($project IS NOT NULL AND a.project = $project) OR ($project IS NULL AND a.project IS NULL))
         AND (($project IS NOT NULL AND b.project = $project) OR ($project IS NULL AND b.project IS NULL))
       MERGE (a)-[r:RELATES_TO {type: $type}]->(b)
       ON CREATE SET r.createdAt = datetime()`,
      { from, to, type, project: project ?? null }
    );
  });
}

export async function searchMemory(query, limit = 10, project = null) {
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
       WHERE $project IS NULL OR entity.project = $project OR entity.project IS NULL
       OPTIONAL MATCH (recentObs:Observation)-[:ABOUT]->(entity)
       WITH entity, score, max(recentObs.createdAt) AS lastSeen
       WITH entity, score,
         CASE WHEN lastSeen IS NULL THEN score
              ELSE score * (1.0 / (1.0 + duration.inDays(lastSeen, datetime()).days / 30.0))
         END AS rankScore
       ORDER BY rankScore DESC
       LIMIT $limit
       // Pull the observations that actually matched the query, best first.
       // Without this the entity's newest observations were returned instead,
       // so a hit buried in a large entity's history was scored but never shown.
       CALL {
         WITH entity
         CALL db.index.fulltext.queryNodes('observationTextFulltext', $query) YIELD node, score AS obsScore
         MATCH (node)-[:ABOUT]->(entity)
         RETURN node.text AS text
         ORDER BY obsScore DESC
         LIMIT 5
       }
       WITH entity, rankScore, collect(text) AS matched
       // Top up with recent observations so an entity matched only by name
       // (or by fewer than five observations) still comes back with context.
       OPTIONAL MATCH (o:Observation)-[:ABOUT]->(entity)
       WITH entity, rankScore, matched, o
       ORDER BY o.createdAt DESC
       WITH entity, rankScore, matched, collect(o.text) AS recent
       WITH entity, rankScore,
            (matched + [t IN recent WHERE NOT t IN matched])[0..5] AS observations
       OPTIONAL MATCH (entity)-[r:RELATES_TO]-(other)
       WITH entity, rankScore, observations, collect(DISTINCT CASE WHEN r IS NULL THEN NULL ELSE {type: r.type, entity: other.name} END) AS relationsRaw
       WITH entity, rankScore, observations, [x IN relationsRaw WHERE x IS NOT NULL] AS relations
       RETURN entity.name AS name, entity.type AS type, rankScore AS score, observations, relations
       ORDER BY rankScore DESC`,
      { query: escapeLuceneQuery(query), limit: int(limit), project: project ?? null }
    );
    const rows = result.records.map((r) => {
      const row = r.toObject();
      return { ...row, observations: row.observations.map((t) => truncateText(t, BUDGETS.searchTextChars)) };
    });
    return fitToBudget(rows, BUDGETS.searchTotalChars).kept;
  });
}

// Resolves a name to a single entity: prefers the exact-project match, falls
// back to a global (project IS NULL) entity of the same name. Shared
// resolution logic for the by-name lookup/delete tools below, so "get" and
// "delete" always agree on which same-named entity they mean once duplicate
// names across projects are possible.
const RESOLVE_ENTITY_MATCH = `MATCH (e:Entity {name: $name})
       WHERE $project IS NULL OR e.project = $project OR e.project IS NULL
       WITH e ORDER BY CASE WHEN e.project = $project THEN 0 ELSE 1 END
       LIMIT 1`;

// Observations are capped because an entity's history is unbounded: a bulk
// import left one entity holding 711 observations / ~460k characters, and
// returning all of them put ~115k tokens into the caller's context in a single
// call. The full count is always reported so callers can tell they're seeing a
// window, and `limit: null` still returns everything for deliberate exports.
export async function getEntity(name, project = null, { limit = 50 } = {}) {
  return withSession(async (session) => {
    const result = await session.run(
      `${RESOLVE_ENTITY_MATCH}
       OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
       WITH e, o ORDER BY o.createdAt DESC
       WITH e, collect(CASE WHEN o IS NULL THEN NULL ELSE {id: o.id, text: o.text, createdAt: toString(o.createdAt)} END) AS observationsRaw
       WITH e, [x IN observationsRaw WHERE x IS NOT NULL] AS allObservations
       WITH e, allObservations, size(allObservations) AS observationCount
       WITH e, observationCount,
            CASE WHEN $limit IS NULL THEN allObservations ELSE allObservations[0..$limit] END AS observations
       OPTIONAL MATCH (e)-[r:RELATES_TO]->(out)
       WITH e, observations, observationCount, collect(DISTINCT CASE WHEN r IS NULL THEN NULL ELSE {type: r.type, entity: out.name} END) AS outgoingRaw
       WITH e, observations, observationCount, [x IN outgoingRaw WHERE x IS NOT NULL] AS outgoing
       OPTIONAL MATCH (e)<-[r2:RELATES_TO]-(in)
       WITH e, observations, observationCount, outgoing, collect(DISTINCT CASE WHEN r2 IS NULL THEN NULL ELSE {type: r2.type, entity: in.name} END) AS incomingRaw
       WITH e, observations, observationCount, outgoing, [x IN incomingRaw WHERE x IS NOT NULL] AS incoming
       RETURN e.name AS name, e.type AS type, e.project AS project, observations, observationCount, outgoing, incoming`,
      { name, project: project ?? null, limit: limit === null ? null : int(limit) }
    );
    const entity = result.records[0]?.toObject() ?? null;
    if (!entity) return null;
    const observations = entity.observations.map((o) => ({
      ...o,
      text: truncateText(o.text, BUDGETS.entityTextChars),
    }));
    return { ...entity, observations: fitToBudget(observations, BUDGETS.entityTotalChars).kept };
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
    // This is the SessionStart injection, paid once per session on every
    // session, so it gets the tightest budget of any read path.
    const rows = result.records.map((r) => {
      const row = r.toObject();
      return { ...row, observations: row.observations.map((t) => truncateText(t, BUDGETS.recentTextChars)) };
    });
    return fitToBudget(rows, BUDGETS.recentTotalChars).kept;
  });
}

export async function deleteObservations(entity, observationIds, project = null) {
  return withSession(async (session) => {
    const result = await session.run(
      `${RESOLVE_ENTITY_MATCH.replace("$name", "$entity")}
       MATCH (e)<-[:ABOUT]-(o:Observation)
       WHERE o.id IN $observationIds
       DETACH DELETE o
       RETURN count(o) AS deleted`,
      { entity, observationIds, project: project ?? null }
    );
    return result.records[0]?.get("deleted").toNumber() ?? 0;
  });
}

export async function deleteEntity(entity, project = null) {
  return withSession(async (session) => {
    await session.run(
      `${RESOLVE_ENTITY_MATCH.replace("$name", "$entity")}
       OPTIONAL MATCH (e)<-[:ABOUT]-(o:Observation)
       DETACH DELETE e, o`,
      { entity, project: project ?? null }
    );
  });
}

/**
 * Chronological observation history. Returns {events, total, returned,
 * truncated} rather than a bare array: callers summarize the result, and
 * summarizing a silently-trimmed history produces a confidently incomplete
 * narrative. `total` is the true match count so the caller can page with
 * `since` instead of raising `limit` and paying for the whole history at once.
 */
export async function getTimeline({
  project,
  since,
  limit = 100,
  maxTextChars = BUDGETS.timelineTextChars,
  maxTotalChars = BUDGETS.timelineTotalChars,
} = {}) {
  return withSession(async (session) => {
    const countResult = await session.run(
      `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE ($project IS NULL OR e.project = $project OR e.project IS NULL)
         AND ($since IS NULL OR o.createdAt >= datetime($since))
       RETURN count(o) AS total`,
      { project: project ?? null, since: since ?? null }
    );
    const total = countResult.records[0]?.get("total")?.toNumber() ?? 0;

    const result = await session.run(
      `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE ($project IS NULL OR e.project = $project OR e.project IS NULL)
         AND ($since IS NULL OR o.createdAt >= datetime($since))
       RETURN e.name AS entity, e.type AS type, o.text AS text, toString(o.createdAt) AS createdAt
       ORDER BY o.createdAt ASC
       LIMIT $limit`,
      { project: project ?? null, since: since ?? null, limit: int(limit) }
    );

    const rows = result.records.map((r) => {
      const row = r.toObject();
      return { ...row, text: truncateText(row.text, maxTextChars) };
    });
    const { kept } = fitToBudget(rows, maxTotalChars);
    return { events: kept, total, returned: kept.length, truncated: kept.length < total };
  });
}

// Deletes observations older than `olderThanDays`, keeping the most recent
// `keepPerEntity` on every entity regardless of age (so an entity never gets
// wiped down to nothing just because nobody's touched it in a while).
export async function pruneObservations({ project, olderThanDays = 180, keepPerEntity = 3, dryRun = false }) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (o:Observation)-[:ABOUT]->(e:Entity)
       WHERE ($project IS NULL OR e.project = $project OR e.project IS NULL)
         AND o.createdAt < datetime() - duration({days: $olderThanDays})
       WITH e, o ORDER BY o.createdAt DESC
       WITH e, collect(o) AS obs
       WITH e, obs[$keepPerEntity..] AS stale
       UNWIND stale AS o
       WITH o, o.id AS id, o.text AS text
       ${dryRun ? "" : "DETACH DELETE o"}
       RETURN count(o) AS pruned, collect({id: id, text: text})[0..20] AS sample`,
      { project: project ?? null, olderThanDays, keepPerEntity: int(keepPerEntity) }
    );
    const record = result.records[0];
    return {
      pruned: record?.get("pruned")?.toNumber() ?? 0,
      sample: record?.get("sample") ?? [],
    };
  });
}

export async function listProjects() {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (e:Entity)
       WHERE e.project IS NOT NULL
       OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
       WITH e.project AS project, count(DISTINCT e) AS entityCount, count(o) AS observationCount, max(o.createdAt) AS lastActivity
       RETURN project, entityCount, observationCount, toString(lastActivity) AS lastActivity
       ORDER BY lastActivity DESC`
    );
    return result.records.map((r) => ({
      project: r.get("project"),
      entityCount: r.get("entityCount").toNumber(),
      observationCount: r.get("observationCount").toNumber(),
      lastActivity: r.get("lastActivity"),
    }));
  });
}

export async function getStatus({ project }) {
  return withSession(async (session) => {
    const result = await session.run(
      `MATCH (e:Entity) WHERE $project IS NULL OR e.project = $project OR e.project IS NULL
       OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
       RETURN count(DISTINCT e) AS entityCount, count(o) AS observationCount`,
      { project: project ?? null }
    );
    const record = result.records[0];
    return {
      entityCount: record?.get("entityCount")?.toNumber() ?? 0,
      observationCount: record?.get("observationCount")?.toNumber() ?? 0,
    };
  });
}
