import { matchQuery } from "./segment.js";
import { BUDGETS, truncateText } from "./budget.js";
import { queryWords } from "./relevance.js";

// Ranks entities for a query as the Neo4j engine did:
// - the best bm25 match across entity names and observation text (negated,
//   since FTS5 ranks lower as better);
// - scoped to the project plus global entities;
// - decayed by the age of the entity's newest observation: 1 / (1 + days / 30).
// Then each entity gets its best-matching observations topped up with its
// newest, its relations with their direction, and how many of the query's
// words it holds (relevance.js decides "weak" from that).

const DAY_MS = 86_400_000;
const OBSERVATIONS_PER_RESULT = 5;
const SUBSYSTEM_FILTER = "(:subsystem IS NULL OR o.subsystem = :subsystem) AND (:untaggedOnly = 0 OR o.subsystem IS NULL)";

const RANK_SQL = `
  WITH hits(entity_id, score) AS (
    SELECT e.id, -bm25(entity_name_fts)
    FROM entity_name_fts JOIN entities e ON e.id = entity_name_fts.rowid
    WHERE entity_name_fts MATCH :match
      AND ((:subsystem IS NULL AND :untaggedOnly = 0)
           OR EXISTS (SELECT 1 FROM observations o WHERE o.entity_id = e.id AND ${SUBSYSTEM_FILTER}))
    UNION ALL
    SELECT o.entity_id, -bm25(observation_text_fts)
    FROM observation_text_fts JOIN observations o ON o.rowid = observation_text_fts.rowid
    WHERE observation_text_fts MATCH :match AND ${SUBSYSTEM_FILTER}
  )
  SELECT e.id AS id, e.name AS name, e.type AS type, e.project AS project, max(h.score) AS score,
         (SELECT max(created_at) FROM observations WHERE entity_id = e.id) AS lastSeen
  FROM hits h JOIN entities e ON e.id = h.entity_id
  WHERE (:project IS NULL OR e.project = :project OR e.project = '')
  GROUP BY e.id`;

const MATCHED_SQL = `
  SELECT o.text AS text, o.subsystem AS subsystem
  FROM observation_text_fts JOIN observations o ON o.rowid = observation_text_fts.rowid
  WHERE observation_text_fts MATCH :match AND o.entity_id = :id AND ${SUBSYSTEM_FILTER}
  ORDER BY bm25(observation_text_fts), o.rowid
  LIMIT ${OBSERVATIONS_PER_RESULT}`;

const NEWEST_SQL = `
  SELECT o.text AS text, o.subsystem AS subsystem FROM observations o
  WHERE o.entity_id = :id AND ${SUBSYSTEM_FILTER}
  ORDER BY o.created_at DESC, o.rowid DESC
  LIMIT ${OBSERVATIONS_PER_RESULT * 2}`;

const RELATIONS_SQL = `
  SELECT r.type AS type, other.name AS entity,
         CASE WHEN r.from_id = :id AND r.to_id = :id THEN 'self'
              WHEN r.from_id = :id THEN 'out' ELSE 'in' END AS direction
  FROM relations r
  JOIN entities other ON other.id = CASE WHEN r.from_id = :id THEN r.to_id ELSE r.from_id END
  WHERE r.from_id = :id OR r.to_id = :id
  ORDER BY r.type, other.name`;

const decayed = (score, lastSeen, now) =>
  lastSeen === null ? score : score / (1 + Math.floor((now - lastSeen) / DAY_MS) / 30);

export function searchRows(db, { query, limit, project, filter, now = Date.now() }) {
  const match = matchQuery(query);
  if (match === null) {
    return [];
  }
  const subsystem = { subsystem: filter.subsystem, untaggedOnly: filter.untaggedOnly ? 1 : 0 };
  const ranked = db
    .prepare(RANK_SQL)
    .all({ match, project: project ?? null, ...subsystem })
    .map((row) => ({ ...row, rankScore: decayed(row.score, row.lastSeen, now) }))
    .sort((a, b) => b.rankScore - a.rankScore || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit);
  const wanted = queryWords(query);
  return ranked.map((row) => describeEntity(db, row, { match, subsystem, wanted }));
}

function describeEntity(db, row, { match, subsystem, wanted }) {
  const matched = db.prepare(MATCHED_SQL).all({ match, id: row.id, ...subsystem });
  const matchedTexts = new Set(matched.map((o) => o.text));
  const newest = db.prepare(NEWEST_SQL).all({ id: row.id, ...subsystem }).filter((o) => !matchedTexts.has(o.text));
  const observations = [...matched, ...newest]
    .slice(0, OBSERVATIONS_PER_RESULT)
    .map((o) => ({ text: truncateText(o.text, BUDGETS.searchTextChars), subsystem: o.subsystem }));
  const relations = db
    .prepare(RELATIONS_SQL)
    .all({ id: row.id })
    .map((r) => ({ type: r.type, entity: r.entity, direction: r.direction }));
  return {
    name: row.name,
    type: row.type,
    project: row.project,
    score: row.rankScore,
    observations,
    relations,
    matchedQueryWords: countHeldWords(db, row, wanted),
  };
}

// How many of the query's words the entity holds anywhere: its name or any observation.
function countHeldWords(db, row, wanted) {
  const { text } = db.prepare("SELECT group_concat(text, ' ') AS text FROM observations WHERE entity_id = ?").get(row.id);
  const held = queryWords(`${row.name} ${text ?? ""}`);
  return [...wanted].filter((word) => held.has(word)).length;
}
