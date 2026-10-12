import { randomUUID } from "node:crypto";
import { getDb, inTransaction } from "./memoryStore.js";
import { indexText } from "./segment.js";
import { resolveCanonicalName } from "./dedup.js";
import { resolveSubsystem, parseSubsystemFilter, UNTAGGED } from "./subsystem.js";
import { BUDGETS, truncateText, fitToBudget } from "./budget.js";
import { wordOverlap } from "./similarity.js";
import { classifyRelevance, topScore, describeRelevance } from "./relevance.js";
import { capRelations, resolveRelationCap } from "./relations.js";
import { shouldFallBack, otherProjectResults } from "./fallback.js";
import { searchRows } from "./search.js";

// The SQLite engine: the same exported functions as the Neo4j engine it
// replaces, over the schema in sqliteDb.js.
// Spec: docs/superpowers/specs/2026-10-09-sqlite-engine-design.md.

// A read for a project sees that project's entities and the global ones
// (stored as project ''); a read with no project sees everything. Binds :project.
const IN_SCOPE = "(:project IS NULL OR e.project = :project OR e.project = '')";

// The subsystem filter's three states (see parseSubsystemFilter): both
// conjuncts are always present and one is always trivially true. Binds
// :subsystem and :untaggedOnly (1 or 0: SQLite has no booleans).
const SUBSYSTEM_FILTER = "(:subsystem IS NULL OR o.subsystem = :subsystem) AND (:untaggedOnly = 0 OR o.subsystem IS NULL)";

const filterParams = (subsystem) => {
  const filter = parseSubsystemFilter(subsystem);
  return { subsystem: filter.subsystem, untaggedOnly: filter.untaggedOnly ? 1 : 0 };
};

// Callers name a global entity with a null project; storage uses ''...
const storedProject = (project) => project ?? "";
// ...and reads hand null back for it, as the Neo4j engine did.
const shownProject = (project) => (project === "" ? null : project);
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export async function listEntityNames(project) {
  return getDb()
    .prepare(`SELECT e.name AS name FROM entities e WHERE ${IN_SCOPE}`)
    .all({ project: project ?? null })
    .map((row) => row.name);
}

/**
 * The project's existing subsystem vocabulary, most-used first. Fed to the
 * extraction prompt and to the write path so new tags converge on the ones
 * already in use instead of fragmenting.
 */
export async function listSubsystems(project) {
  return getDb()
    .prepare(
      `SELECT o.subsystem AS subsystem, count(*) AS observations
       FROM observations o JOIN entities e ON e.id = o.entity_id
       WHERE ${IN_SCOPE} AND o.subsystem IS NOT NULL
       GROUP BY o.subsystem
       ORDER BY observations DESC, subsystem ASC`
    )
    .all({ project: project ?? null })
    .map((row) => ({ subsystem: row.subsystem, observations: row.observations }));
}

/**
 * A table of contents for the project's memory: one row per subsystem tag with
 * counts and recency, untagged observations in their own row. Bounded by tag
 * cardinality, so the SessionStart injection does not grow with the store.
 */
export async function getSubsystemMap(project) {
  return getDb()
    .prepare(
      `SELECT coalesce(o.subsystem, :untagged) AS subsystem, count(*) AS observations,
              count(DISTINCT o.entity_id) AS entities, max(o.created_at) AS lastSeen
       FROM observations o JOIN entities e ON e.id = o.entity_id
       WHERE ${IN_SCOPE}
       GROUP BY coalesce(o.subsystem, :untagged)
       ORDER BY lastSeen DESC`
    )
    .all({ project: project ?? null, untagged: UNTAGGED })
    .map((row) => ({ subsystem: row.subsystem, observations: row.observations, entities: row.entities, lastSeen: iso(row.lastSeen) }));
}

export async function upsertSession({ id, cwd, project }) {
  getDb()
    .prepare("INSERT INTO sessions (id, cwd, project, started_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
    .run(id, cwd ?? null, project ?? null, Date.now());
}

// Creates the entity, or bumps an existing one; returns its id. An existing
// entity keeps its type unless a new one is given.
function upsertEntity(db, name, type, project, now) {
  const scope = storedProject(project);
  const existing = db.prepare("SELECT id FROM entities WHERE name = ? AND project = ?").get(name, scope);
  if (existing) {
    db.prepare("UPDATE entities SET type = coalesce(?, type), updated_at = ? WHERE id = ?").run(type ?? null, now, existing.id);
    return existing.id;
  }
  const { lastInsertRowid } = db
    .prepare("INSERT INTO entities (name, project, type, created_at) VALUES (?, ?, ?, ?)")
    .run(name, scope, type ?? null, now);
  db.prepare("INSERT INTO entity_name_fts (rowid, words) VALUES (?, ?)").run(lastInsertRowid, indexText(name));
  return Number(lastInsertRowid);
}

// `existingNames`/`existingSubsystems` let a caller writing several entities in
// a row fetch these lists once instead of per call. One call's whole batch
// shares one created_at; rowid keeps the batch's order.
export async function addObservations({ entity, entityType, observations, sessionId, project, existingNames, existingSubsystems }) {
  const names = existingNames ?? (await listEntityNames(project));
  const knownSubsystems = existingSubsystems ?? (await listSubsystems(project)).map((s) => s.subsystem);
  // A plain string or {text, subsystem}; bounded on the way in, so one runaway
  // observation can't inflate every future read of this entity.
  const rows = observations.map((item) => {
    const { text, subsystem } = typeof item === "string" ? { text: item, subsystem: null } : item;
    return { id: randomUUID(), text: truncateText(text, BUDGETS.writeTextChars), subsystem: resolveSubsystem(subsystem, knownSubsystems) };
  });
  const name = resolveCanonicalName(entity, names);
  const db = getDb();
  const now = Date.now();
  inTransaction(db, () => {
    const entityId = upsertEntity(db, name, entityType, project, now);
    const insert = db.prepare("INSERT INTO observations (id, entity_id, text, subsystem, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const index = db.prepare("INSERT INTO observation_text_fts (rowid, words) VALUES (?, ?)");
    for (const row of rows) {
      const { lastInsertRowid } = insert.run(row.id, entityId, row.text, row.subsystem, sessionId ?? null, now);
      index.run(lastInsertRowid, indexText(row.text));
    }
  });
  return rows.map((row) => row.id);
}

export async function createRelation({ from, to, type, project }) {
  const names = await listEntityNames(project);
  const fromName = resolveCanonicalName(from, names);
  const toName = resolveCanonicalName(to, names);
  const db = getDb();
  const now = Date.now();
  inTransaction(db, () => {
    const fromId = upsertEntity(db, fromName, null, project, now);
    const toId = upsertEntity(db, toName, null, project, now);
    db.prepare(
      "INSERT INTO relations (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (from_id, to_id, type) DO NOTHING"
    ).run(fromId, toId, type, now);
  });
}

export async function getStatus({ project }) {
  const db = getDb();
  const params = { project: project ?? null };
  const { entityCount } = db.prepare(`SELECT count(*) AS entityCount FROM entities e WHERE ${IN_SCOPE}`).get(params);
  const { observationCount } = db
    .prepare(`SELECT count(*) AS observationCount FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${IN_SCOPE}`)
    .get(params);
  return { entityCount, observationCount };
}

export async function listProjects() {
  return getDb()
    .prepare(
      `SELECT e.project AS project, count(DISTINCT e.id) AS entityCount, count(o.rowid) AS observationCount,
              max(o.created_at) AS lastActivity
       FROM entities e LEFT JOIN observations o ON o.entity_id = e.id
       WHERE e.project != ''
       GROUP BY e.project
       ORDER BY lastActivity DESC`
    )
    .all()
    .map((row) => ({
      project: row.project,
      entityCount: row.entityCount,
      observationCount: row.observationCount,
      lastActivity: iso(row.lastActivity),
    }));
}

// Prefers the entity in this project, then a global one of the same name, so
// get and delete always agree on which same-named entity they mean.
function resolveEntity(db, name, project) {
  return db
    .prepare(
      `SELECT e.id AS id, e.name AS name, e.type AS type, e.project AS project
       FROM entities e WHERE e.name = :name AND ${IN_SCOPE}
       ORDER BY CASE WHEN e.project = :project THEN 0 ELSE 1 END, e.id
       LIMIT 1`
    )
    .get({ name, project: project ?? null });
}

const asRelation = (row) => ({ type: row.type, entity: row.entity });

// Observations are capped because an entity's history is unbounded; the full
// count is always reported, and `limit: null` still returns everything.
export async function getEntity(name, project = null, { limit = 50 } = {}) {
  const db = getDb();
  const entity = resolveEntity(db, name, project);
  if (!entity) {
    return null;
  }
  const all = db
    .prepare("SELECT id, text, subsystem, created_at FROM observations WHERE entity_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(entity.id);
  const shown = (limit === null ? all : all.slice(0, limit)).map((o) => ({
    id: o.id,
    text: truncateText(o.text, BUDGETS.entityTextChars),
    subsystem: o.subsystem,
    createdAt: iso(o.created_at),
  }));
  const outgoing = db
    .prepare("SELECT r.type AS type, b.name AS entity FROM relations r JOIN entities b ON b.id = r.to_id WHERE r.from_id = ? ORDER BY r.type, b.name")
    .all(entity.id)
    .map(asRelation);
  const incoming = db
    .prepare("SELECT r.type AS type, a.name AS entity FROM relations r JOIN entities a ON a.id = r.from_id WHERE r.to_id = ? ORDER BY r.type, a.name")
    .all(entity.id)
    .map(asRelation);
  return {
    name: entity.name,
    type: entity.type,
    project: shownProject(entity.project),
    observations: fitToBudget(shown, BUDGETS.entityTotalChars).kept,
    observationCount: all.length,
    outgoing,
    incoming,
  };
}

export async function getRecentContext({ project, limit = 15, subsystem = null }) {
  const db = getDb();
  const filter = filterParams(subsystem);
  const entities = db
    .prepare(
      `SELECT e.id AS id, e.name AS name, e.type AS type, max(o.created_at) AS lastSeen
       FROM observations o JOIN entities e ON e.id = o.entity_id
       WHERE ${IN_SCOPE} AND ${SUBSYSTEM_FILTER}
       GROUP BY e.id
       ORDER BY lastSeen DESC, e.id DESC
       LIMIT :limit`
    )
    .all({ project: project ?? null, ...filter, limit });
  const newest = db.prepare(
    `SELECT o.text AS text, o.subsystem AS subsystem FROM observations o
     WHERE o.entity_id = :id AND ${SUBSYSTEM_FILTER}
     ORDER BY o.created_at DESC, o.rowid DESC LIMIT 3`
  );
  const rows = entities.map((entity) => ({
    name: entity.name,
    type: entity.type,
    observations: newest
      .all({ id: entity.id, ...filter })
      .map((o) => ({ text: truncateText(o.text, BUDGETS.recentTextChars), subsystem: o.subsystem })),
  }));
  return fitToBudget(rows, BUDGETS.recentTotalChars).kept;
}

// Returns {events, total, returned, truncated}: callers summarize the result,
// and summarizing a silently trimmed history gives a confidently incomplete one.
export async function getTimeline({
  project,
  since,
  limit = 100,
  subsystem = null,
  maxTextChars = BUDGETS.timelineTextChars,
  maxTotalChars = BUDGETS.timelineTotalChars,
} = {}) {
  const sinceMs = since === null || since === undefined ? null : Date.parse(since);
  if (Number.isNaN(sinceMs)) {
    throw new Error(`since is not a date: ${since}`);
  }
  const db = getDb();
  const params = { project: project ?? null, since: sinceMs, ...filterParams(subsystem) };
  const where = `${IN_SCOPE} AND (:since IS NULL OR o.created_at >= :since) AND ${SUBSYSTEM_FILTER}`;
  const { total } = db
    .prepare(`SELECT count(*) AS total FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${where}`)
    .get(params);
  const events = db
    .prepare(
      `SELECT e.name AS entity, e.type AS type, o.text AS text, o.created_at AS createdAt
       FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${where}
       ORDER BY o.created_at ASC, o.rowid ASC LIMIT :limit`
    )
    .all({ ...params, limit })
    .map((row) => ({ entity: row.entity, type: row.type, text: truncateText(row.text, maxTextChars), createdAt: iso(row.createdAt) }));
  const { kept } = fitToBudget(events, maxTotalChars);
  return { events: kept, total, returned: kept.length, truncated: kept.length < total };
}

// Deletes observations by rowid together with their full-text rows.
function removeObservationRows(db, rowids) {
  const dropText = db.prepare("DELETE FROM observation_text_fts WHERE rowid = ?");
  const drop = db.prepare("DELETE FROM observations WHERE rowid = ?");
  for (const rowid of rowids) {
    dropText.run(rowid);
    drop.run(rowid);
  }
}

export async function deleteObservations(entity, observationIds, project = null) {
  const db = getDb();
  const target = resolveEntity(db, entity, project);
  if (!target || observationIds.length === 0) {
    return 0;
  }
  const marks = observationIds.map(() => "?").join(", ");
  return inTransaction(db, () => {
    const doomed = db
      .prepare(`SELECT rowid AS rid FROM observations WHERE entity_id = ? AND id IN (${marks})`)
      .all(target.id, ...observationIds);
    removeObservationRows(db, doomed.map((row) => row.rid));
    return doomed.length;
  });
}

// Its relations go with it through ON DELETE CASCADE.
export async function deleteEntity(entity, project = null) {
  const db = getDb();
  const target = resolveEntity(db, entity, project);
  if (!target) {
    return;
  }
  inTransaction(db, () => {
    const rowids = db.prepare("SELECT rowid AS rid FROM observations WHERE entity_id = ?").all(target.id).map((row) => row.rid);
    removeObservationRows(db, rowids);
    db.prepare("DELETE FROM entity_name_fts WHERE rowid = ?").run(target.id);
    db.prepare("DELETE FROM entities WHERE id = ?").run(target.id);
  });
}

// Deletes observations older than `olderThanDays`, keeping each entity's
// newest `keepPerEntity` of those old ones, so an entity is never wiped down to
// nothing just because nobody touched it in a while.
export async function pruneObservations({ project, olderThanDays = 180, keepPerEntity = 3, dryRun = false }) {
  const db = getDb();
  const stale = db
    .prepare(
      `WITH old AS (
         SELECT o.rowid AS rid, o.id AS id, o.text AS text,
                row_number() OVER (PARTITION BY o.entity_id ORDER BY o.created_at DESC, o.rowid DESC) AS position
         FROM observations o JOIN entities e ON e.id = o.entity_id
         WHERE ${IN_SCOPE} AND o.created_at < :cutoff
       )
       SELECT rid, id, text FROM old WHERE position > :keep ORDER BY rid`
    )
    .all({ project: project ?? null, cutoff: Date.now() - olderThanDays * 86_400_000, keep: keepPerEntity });
  if (!dryRun) {
    inTransaction(db, () => removeObservationRows(db, stale.map((row) => row.rid)));
  }
  return { pruned: stale.length, sample: stale.slice(0, 20).map((row) => ({ id: row.id, text: row.text })) };
}

// Entity types whose observations always apply, matched by prefix against
// `type` (one live entity is typed "Constraint Amendment"), plus the entity
// named "user".
const PINNED_TYPES = ["user", "preference", "constraint", "convention"];
const PINNED_WHERE = `${IN_SCOPE} AND (${PINNED_TYPES.map((type) => `lower(coalesce(e.type, '')) LIKE '${type}%'`).join(" OR ")} OR e.name = 'user')`;

// Measured on 693 standing facts (engine spec, "Fix 2"): every pair at 0.8 or
// more was a repeat, and the next pair down (0.73) was two different tickets.
// Reworded repeats score as low as 0.33, below pairs that genuinely differ, so
// they are only listed for review (0.3), never collapsed.
export const REPEAT_COLLAPSE_OVERLAP = 0.8;
export const REPEAT_REVIEW_OVERLAP = 0.3;

// Rows arrive newest first, so the newest of each group of repeats is kept.
function collapseRepeats(rows) {
  const facts = [];
  let collapsed = 0;
  for (const row of rows) {
    if (facts.some((kept) => wordOverlap(kept.text, row.text) >= REPEAT_COLLAPSE_OVERLAP)) {
      collapsed += 1;
    } else {
      facts.push(row);
    }
  }
  return { facts, collapsed };
}

/**
 * The standing facts injected verbatim at SessionStart, repeats collapsed.
 * `total` counts every eligible fact, `collapsed` the repeats hidden on purpose,
 * and `truncated` says whether the budget or `limit` cut any of the rest.
 */
export async function getPinnedFacts({ project, limit = 100 } = {}) {
  const db = getDb();
  const params = { project: project ?? null };
  const { total } = db
    .prepare(`SELECT count(*) AS total FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${PINNED_WHERE}`)
    .get(params);
  const rows = db
    .prepare(
      `SELECT e.name AS entity, e.type AS type, o.text AS text
       FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${PINNED_WHERE}
       ORDER BY o.created_at DESC, o.rowid DESC LIMIT :limit`
    )
    .all({ ...params, limit });
  const { facts, collapsed } = collapseRepeats(rows);
  const shown = facts.map((row) => ({ entity: row.entity, type: row.type, text: truncateText(row.text, BUDGETS.pinnedTextChars) }));
  const { kept } = fitToBudget(shown, BUDGETS.pinnedTotalChars);
  return { facts: kept, total, collapsed, returned: kept.length, truncated: kept.length < total - collapsed };
}

const shownFact = (row) => ({ entity: row.entity, project: shownProject(row.project), id: row.id, createdAt: iso(row.createdAt), text: row.text });

/**
 * Standing facts that are likely repeats of each other, most similar first,
 * for a person to merge or delete. With no project, only facts from the same
 * scope are paired: a fact repeated across projects is never seen twice.
 */
export async function findRepeatedFacts({ project = null, min = REPEAT_REVIEW_OVERLAP } = {}) {
  const facts = getDb()
    .prepare(
      `SELECT e.name AS entity, e.project AS project, o.id AS id, o.text AS text, o.created_at AS createdAt
       FROM observations o JOIN entities e ON e.id = o.entity_id WHERE ${PINNED_WHERE}
       ORDER BY o.created_at DESC, o.rowid DESC`
    )
    .all({ project: project ?? null });
  const pairs = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const sameScope = project !== null || facts[i].project === facts[j].project;
      const similarity = sameScope ? wordOverlap(facts[i].text, facts[j].text) : 0;
      if (sameScope && similarity >= min) {
        pairs.push({ similarity, newer: shownFact(facts[i]), older: shownFact(facts[j]) });
      }
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

const withoutProject = ({ project, ...row }) => row;
const withoutMatchCount = ({ matchedQueryWords, ...row }) => row;

function buildSearchEnvelope(rows, query) {
  // Capped before budgeting, so the budget sees the real payload size.
  const capped = capRelations(rows.map(withoutProject), query, resolveRelationCap());
  const kept = fitToBudget(capped, BUDGETS.searchTotalChars).kept;
  const relevance = classifyRelevance(kept, query);
  const results = kept.map(withoutMatchCount);
  const score = topScore(results);
  const envelope = { results, relevance, topScore: score };
  const note = describeRelevance(relevance);
  if (note) {
    envelope.note = note;
  }
  return envelope;
}

export async function searchMemory(query, limit = 10, project = null, { subsystem = null } = {}) {
  const filter = parseSubsystemFilter(subsystem);
  const db = getDb();
  const envelope = buildSearchEnvelope(searchRows(db, { query, limit, project, filter }), query);
  if (!shouldFallBack({ project, relevance: envelope.relevance })) {
    return envelope;
  }
  const other = otherProjectResults(searchRows(db, { query, limit, project: null, filter }), project, query);
  return other ? { ...envelope, otherProjects: other } : envelope;
}
