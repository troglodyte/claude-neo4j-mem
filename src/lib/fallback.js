import { queryWords } from "./relevance.js";

// A search is scoped to the current project so unrelated repos don't leak into
// each other. That scoping also hides real answers: replayed over every logged
// search that came back weak or empty, all of them had a strong match in another
// project's namespace (a sub-project under another name, a worktree recorded as
// its own project, a question asked from the wrong repo). So when, and only
// when, the scoped search misses, look wider, and keep the wider results apart,
// labelled, so they are never mistaken for facts about this repo.
//
// What counts as an answer elsewhere is how much of the query a match shows:
// measured 2026-10-07, real rescues covered 50-100% of the query's words and
// junk 25-33%. The Lucene-era score floors that also guarded this are gone: the
// SQLite engine's bm25 scores are on another scale, and strong and weak matches
// overlap in it.

export const MAX_OTHER_PROJECT_RESULTS = 3;
const OBSERVATIONS_PER_RESULT = 2;

const FALLBACK_ENV = "CLAUDE_NEO4J_SEARCH_FALLBACK";

/** On unless CLAUDE_NEO4J_SEARCH_FALLBACK is `off` or `0`. */
export function fallbackEnabled(env = process.env) {
  const raw = env[FALLBACK_ENV]?.trim().toLowerCase();
  return raw !== "off" && raw !== "0";
}

/** Only a project-scoped search that came back none or weak is worth widening. */
export function shouldFallBack({ project, relevance, env = process.env }) {
  return project !== null && (relevance === "none" || relevance === "weak") && fallbackEnabled(env);
}

/**
 * Does what the reader would see of the entity (its name and first two
 * observations, the best matches) contain enough of the query's words to be an
 * answer rather than a fragment match? At least half of them, and never fewer
 * than two once the query has two or more.
 */
export function coversQuery(query, row) {
  const wanted = queryWords(query);
  if (wanted.size === 0) {
    return false;
  }
  const shown = row.observations.slice(0, OBSERVATIONS_PER_RESULT);
  const have = queryWords(`${row.name} ${shown.map((o) => o.text).join(" ")}`);
  const matched = [...wanted].filter((w) => have.has(w)).length;
  return matched >= Math.max(Math.ceil(wanted.size / 2), Math.min(wanted.size, 2));
}

/**
 * Compact, labelled matches from projects other than `currentProject`, or null.
 * `rows` come from an unscoped search and carry `project`. Global entities
 * (project '' or null) were already visible to the scoped search.
 */
export function otherProjectResults(rows, currentProject, query) {
  const strong = rows
    .filter((r) => r.project && r.project !== currentProject)
    .filter((r) => coversQuery(query, r))
    .slice(0, MAX_OTHER_PROJECT_RESULTS)
    .map((r) => ({
      project: r.project,
      name: r.name,
      type: r.type,
      score: r.score,
      observations: r.observations.slice(0, OBSERVATIONS_PER_RESULT),
      relationCount: r.relations?.length ?? 0,
    }));
  if (strong.length === 0) {
    return null;
  }
  return {
    note:
      "Nothing strong in this project's memory. These matches come from OTHER projects: " +
      "context that may help, not facts about this repo. Say which project they came from, " +
      "and call memory_get_entity only for entities in this project.",
    results: strong,
  };
}
