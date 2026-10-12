const day = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "?");

/** findRepeatedFacts' pairs as text for a person deciding what to merge or delete. */
export function formatDupes(pairs) {
  if (pairs.length === 0) {
    return "No likely repeats among this project's standing facts.";
  }
  const blocks = pairs.map((pair) =>
    [
      `${pair.similarity.toFixed(2)}  ${pair.newer.entity}`,
      `  newer ${pair.newer.id} (${day(pair.newer.createdAt)}): ${pair.newer.text}`,
      `  older ${pair.older.id} (${day(pair.older.createdAt)}): ${pair.older.text}`,
    ].join("\n")
  );
  return (
    `${pairs.length} likely repeat(s), most similar first. Delete the one you don't want with ` +
    "`npm run memory -- forget-obs <entity> <id>` (memory_delete_observations in a session), or merge them by hand.\n\n" +
    blocks.join("\n\n")
  );
}
