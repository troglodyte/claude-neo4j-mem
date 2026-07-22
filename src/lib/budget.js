// Every read path here used to be bounded by row count alone, while the text on
// each row was unbounded. That combination is what made reads expensive: 300
// timeline rows is a fixed number, but 300 rows of imported claude-mem
// narrative is ~60k tokens, and the same call on natively-captured
// observations (5x shorter on average) is ~11k. Row counts don't predict cost,
// so every read path also carries a character budget, and anything trimmed says
// so in-band rather than silently vanishing.

export const BUDGETS = {
  // Timeline feeds narrative summarization, which needs the gist of each entry
  // rather than its full text - by far the cheapest place to trim.
  timelineTextChars: 200,
  timelineTotalChars: 40_000,
  // Search results are read closely, so they keep more of each observation.
  searchTextChars: 400,
  searchTotalChars: 24_000,
  // Injected into every single session, so this is the tightest budget.
  recentTextChars: 300,
  recentTotalChars: 12_000,
  // A deliberate "show me everything about X" call; generous but still bounded.
  entityTextChars: 1_000,
  entityTotalChars: 40_000,
  // Write-side backstop. Native captures average ~120 chars and peak ~550, so
  // this never fires in normal use; it exists so one pathological observation
  // can't inflate every future read that touches its entity.
  writeTextChars: 4_000,
  // Injected verbatim into every session alongside the subsystem map. Sized to
  // fit the largest real pinned set whole - 28 observations at ~138 chars each
  // is ~3.9k - because a standing preference the model never sees may as well
  // not exist. An earlier 2_000 silently dropped half the standing facts on
  // three of four live projects; the ceiling stays only as a backstop against a
  // project that accumulates far more, and getPinnedFacts reports when it bites.
  pinnedTextChars: 300,
  pinnedTotalChars: 4_000,
};

/**
 * Trims text to a character budget, stating how much was removed so the reader
 * can tell truncated content from content that was simply short.
 */
export function truncateText(text, maxChars) {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)} …[+${text.length - maxChars} chars]`;
}

/**
 * Keeps items in order until the serialized payload would exceed maxChars.
 * Always keeps at least one item, so a single oversized entry still comes back
 * (truncated by truncateText) instead of yielding an empty, confusing result.
 */
export function fitToBudget(items, maxChars, sizeOf = (item) => JSON.stringify(item).length) {
  const kept = [];
  let used = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (kept.length > 0 && used + size > maxChars) break;
    kept.push(item);
    used += size;
  }
  return { kept, dropped: items.length - kept.length, chars: used };
}
