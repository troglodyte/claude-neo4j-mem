// Word overlap between two texts: the Jaccard index of their sets of lowercase
// ASCII words of three or more characters. The repeat thresholds that use it
// were measured with exactly this rule on 693 real standing facts (engine spec,
// "Fix 2"), so changing the word rule means measuring them again.
export function wordSet(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((word) => word.length > 2));
}

export function wordOverlap(a, b) {
  const left = wordSet(a);
  const right = wordSet(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}
