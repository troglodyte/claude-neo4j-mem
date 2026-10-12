// Agreement between two search engines over the same queries and data. Each
// pair is { query, project, before: { names, relevance }, after: { names, relevance } },
// names best first. Acceptance: engine spec, "Search".
export const PARITY_GATES = { top1: 0.95, relevance: 0.95 };

const overlapAt5 = (pair) => {
  const before = new Set(pair.before.names.slice(0, 5));
  const shared = pair.after.names.slice(0, 5).filter((name) => before.has(name)).length;
  return shared / Math.min(5, Math.max(pair.before.names.length, pair.after.names.length));
};

export function parityReport(pairs) {
  const answered = pairs.filter((p) => p.before.names.length > 0 || p.after.names.length > 0);
  const disagreements = pairs.filter((p) => p.before.relevance !== p.after.relevance);
  const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 1);
  return {
    queries: pairs.length,
    answered: answered.length,
    top1: mean(answered.map((p) => (p.before.names[0] === p.after.names[0] ? 1 : 0))),
    overlapAt5: mean(answered.map(overlapAt5)),
    emptyMismatches: pairs.filter((p) => (p.before.names.length === 0) !== (p.after.names.length === 0)).map((p) => p.query),
    relevance: pairs.length ? (pairs.length - disagreements.length) / pairs.length : 1,
    relevanceDisagreements: disagreements.map((p) => ({ query: p.query, before: p.before.relevance, after: p.after.relevance })),
  };
}

export function passesGates(report) {
  return report.top1 >= PARITY_GATES.top1 && report.relevance >= PARITY_GATES.relevance && report.emptyMismatches.length === 0;
}
