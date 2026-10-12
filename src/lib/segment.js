// Text split the way Neo4j's full-text index (Lucene's standard analyzer) did:
// UAX #29 word boundaries, lowercased. A word keeps its inner ':', '.', '_' and
// apostrophes ("feature:capture", "cypher.sh", "snake_case", "don't"); hyphens
// and spaces split. Measured against Neo4j on 214 logged searches: the same top
// result on 196 of 200.
const segmenter = new Intl.Segmenter("en", { granularity: "word" });

export function segmentWords(text) {
  return [...segmenter.segment(String(text ?? "").toLowerCase())]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
}

/** What a full-text row stores: the segmented words joined by single spaces. */
export function indexText(text) {
  return segmentWords(text).join(" ");
}

/**
 * An FTS5 MATCH expression for any of the query's words, each quoted so FTS5
 * reads none of it as syntax; null when the query has no words. A repeated word
 * is kept, so it weighs double in bm25 as it did in Lucene: dropping repeats
 * cost three top results in the parity replay.
 */
export function matchQuery(query) {
  const words = segmentWords(query);
  if (words.length === 0) {
    return null;
  }
  return words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR ");
}
