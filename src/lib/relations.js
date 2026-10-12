// A search result used to carry every relation an entity had. About half of a
// typical memory_search payload was edges, and a few hub entities hold hundreds
// of them, so the cost of a call tracked graph density rather than how well
// the query matched. Capping is safe because memory_get_entity still returns
// every relation, and relationCount says when a list was cut.

export const DEFAULT_RELATION_CAP = 8;

const CAP_ENV = "CLAUDE_NEO4J_SEARCH_RELATIONS_CAP";

/**
 * Unset or blank -> the default. "0" or "off" -> no cap. An unparseable value
 * falls back to the default instead of silently disabling the cap.
 */
export function resolveRelationCap(env = process.env) {
  const raw = env[CAP_ENV]?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_RELATION_CAP;
  }
  if (raw === "0" || raw === "off") {
    return Infinity;
  }
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : DEFAULT_RELATION_CAP;
}

/** Lowercased words longer than two characters, minus a leading `type:` prefix. */
function terms(text) {
  return text
    .toLowerCase()
    .replace(/^[a-z-]+:/, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * Trims each entity's relations to `cap`, keeping first the targets that are
 * also in this result set (already-visible pointers), then targets whose name
 * shares a word with the query, then the rest in their original order.
 * Every entity gains `relationCount`, the true total before trimming.
 */
export function capRelations(results, query, cap = DEFAULT_RELATION_CAP) {
  const visible = new Set(results.map((r) => r.name));
  const queryTerms = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));

  const priority = (relation) => {
    const inResults = visible.has(relation.entity) ? 2 : 0;
    const matchesQuery = terms(relation.entity).some((t) => queryTerms.has(t)) ? 1 : 0;
    return inResults + matchesQuery;
  };

  return results.map((result) => {
    const relations = result.relations ?? [];
    const kept = relations.length <= cap ? relations : [...relations].sort((a, b) => priority(b) - priority(a)).slice(0, cap);
    return { ...result, relations: kept, relationCount: relations.length };
  });
}
