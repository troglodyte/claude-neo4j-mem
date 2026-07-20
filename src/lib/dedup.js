// Safety net against near-duplicate entity names slipping past the extraction
// prompt (typo, "project:foo" vs "project-foo", pluralization, casing). Not a
// substitute for the LLM reusing known names semantically - just catches
// lexical drift on otherwise-the-same name.
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 1; j < cols; j++) dist[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
    }
  }
  return dist[rows - 1][cols - 1];
}

function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

const SIMILARITY_THRESHOLD = 0.82;

/**
 * Maps a candidate entity name onto an existing one from the same project if
 * it's a close lexical match (exact match short-circuits first). Otherwise
 * returns the candidate unchanged so a new entity gets created.
 */
export function resolveCanonicalName(candidate, existingNames) {
  if (existingNames.includes(candidate)) return candidate;
  const normCandidate = normalize(candidate);
  let best = null;
  let bestScore = 0;
  for (const name of existingNames) {
    const score = similarity(normCandidate, normalize(name));
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return bestScore >= SIMILARITY_THRESHOLD ? best : candidate;
}
