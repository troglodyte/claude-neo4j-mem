/**
 * How much to trust a search result, in-band, so a caller can say "memory
 * doesn't have that" instead of summarizing noise. Two unrelated callers need
 * the same judgement: graph.searchMemory, to annotate what it returns, and the
 * cross-project fallback, to decide what counts as an answer elsewhere.
 *
 * The SQLite engine judges by words, not scores. A result is weak when the
 * query has two or more words and its best entity holds only one of them
 * anywhere in its name or observations: a fragment match, like
 * "zzz-nonexistent-term-qqq" finding "term". Measured on 214 logged searches
 * (2026-10-09), this agrees with the Lucene-era labels on 208. Five of the six
 * disagreements were Lucene calling a lone word "strong" just above its floor
 * ("ABC-1463" matching only "abc"); the sixth was a Lucene "weak" whose best
 * result held 8 of its 9 words. bm25 scores cannot make the call: strong
 * matches scored from 3.47 and the weak one up to 10.84.
 */

/** Lowercase words longer than two characters: the unit relevance and the fallback count. */
export function queryWords(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
  );
}

// The Lucene-era score floor. Only telemetry logged by the Neo4j engine, which
// carries a score but no label, is still judged by it.
export const WEAK_SCORE = 2.0;

const rowsOf = (value) => (Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : []);

/** Best score in a result set, or null if nothing carries one. */
export function topScore(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : null;
  if (!rows || rows.length === 0) {
    return null;
  }
  const scores = rows.map((row) => row?.score).filter((s) => typeof s === "number");
  return scores.length ? Math.max(...scores) : null;
}

/**
 * "none" | "weak" | "strong" | "unscored". Rows are ranked best first and carry
 * `matchedQueryWords`: how many of the query's words the entity holds.
 */
export function classifyRelevance(value, query) {
  const rows = rowsOf(value);
  if (rows.length === 0) {
    return "none";
  }
  const matched = rows[0].matchedQueryWords;
  if (typeof matched !== "number") {
    return "unscored";
  }
  return queryWords(query).size >= 2 && matched <= 1 ? "weak" : "strong";
}

/**
 * The in-band explanation, or null when the result speaks for itself. Only weak
 * and empty results get a note; annotating good ones too would train a reader
 * to skip the field.
 */
export function describeRelevance(relevance) {
  if (relevance === "none") {
    return "No match in memory for this query.";
  }
  if (relevance !== "weak") {
    return null;
  }
  return (
    "Weak match: the best result holds only one of your query's words, so it likely matched a fragment " +
    "rather than the meaning, and memory may not hold what was asked for. " +
    "Say so rather than summarizing these rows as the answer."
  );
}
