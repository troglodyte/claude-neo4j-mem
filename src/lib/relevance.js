/**
 * How much to trust a full-text search result.
 *
 * Row count alone can't say. The Lucene index tokenizes on hyphens, so a query
 * like `zzz-nonexistent-term-qqq` matches the token `term`, returns one real
 * entity, and reads exactly like a hit - the "wrong-but-plausible search
 * result" this project has a recorded lesson about. The score separates them
 * where the count can't, but only once it's calibrated: a bare number in the
 * payload means nothing to a reader who doesn't know this index's range.
 *
 * Lives in its own module because two unrelated callers need the same
 * calibration - `graph.searchMemory` to annotate what it returns, and
 * `telemetry` to count misses honestly. One definition, one place to re-derive
 * it if the corpus changes.
 */

// Measured 2026-08-03 against this graph (3.2k observations): genuine queries
// top out at 3.35-9.28, a pure-junk fragment match scored 1.61, and true misses
// return no rows at all. Re-measure with known-good and known-junk queries
// before trusting this number against a different corpus.
export const WEAK_SCORE = 2.0;

/** Best score in a result set, or null if nothing carries one. */
export function topScore(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : null;
  if (!rows || rows.length === 0) return null;
  const scores = rows.map((row) => row?.score).filter((s) => typeof s === "number");
  return scores.length ? Math.max(...scores) : null;
}

/**
 * "none" | "weak" | "strong" | "unscored".
 *
 * `unscored` is deliberately distinct from `weak`: a payload with no scores at
 * all hasn't been judged, and calling that weak would invent a finding.
 */
export function classifyRelevance(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : [];
  if (rows.length === 0) return "none";
  const score = topScore(rows);
  if (score === null) return "unscored";
  return score < WEAK_SCORE ? "weak" : "strong";
}

/**
 * The in-band explanation, or null when the result speaks for itself.
 *
 * Only weak and empty results get a note. Annotating a good result too would
 * train a reader to skip the field, which is how the one case that matters
 * gets missed.
 */
export function describeRelevance(relevance, score) {
  if (relevance === "none") return "No match in memory for this query.";
  if (relevance !== "weak") return null;
  return (
    `Weak match: best score ${score.toFixed(2)}, below the ${WEAK_SCORE} relevance floor for this index - ` +
    `these rows likely matched a fragment of the query rather than its meaning, ` +
    `so memory may not hold what was asked for. Say so rather than summarizing these as the answer.`
  );
}
