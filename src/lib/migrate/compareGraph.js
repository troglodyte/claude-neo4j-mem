import { FIELDS, RECORD_TYPES, canonicalRow, keyOf, normaliseField } from "./fingerprint.js";

/**
 * The source graph (Neo4j's snapshot) against the target (SQLite read back),
 * row by row on natural keys. Missing and changed rows fail the check; extra
 * rows, in SQLite only, are listed but pass, because after rollout they are new
 * writes or Neo4j-side deletes.
 */
export function compareGraph(source, target) {
  const types = Object.fromEntries(RECORD_TYPES.map((type) => [type, compareRows(type, source[type], target[type])]));
  return {
    ok: RECORD_TYPES.every((type) => types[type].missing.length === 0 && types[type].changed.length === 0),
    types,
    projects: projectCounts(source, target),
    notWellFormedText: source.observations.filter((o) => typeof o.text === "string" && !o.text.isWellFormed()).length,
  };
}

function compareRows(type, sourceRows, targetRows) {
  const targetByKey = new Map(targetRows.map((row) => [keyOf(type, row), row]));
  const sourceKeys = new Set();
  const missing = [];
  const changed = [];
  for (const row of sourceRows) {
    const key = keyOf(type, row);
    sourceKeys.add(key);
    const other = targetByKey.get(key);
    if (!other) {
      missing.push(key);
    } else if (canonicalRow(type, row) !== canonicalRow(type, other)) {
      changed.push({ key, fields: differingFields(type, row, other) });
    }
  }
  const extra = [...targetByKey.keys()].filter((key) => !sourceKeys.has(key));
  return { source: sourceRows.length, target: targetRows.length, missing, changed, extra };
}

function differingFields(type, a, b) {
  const value = (row, field) => JSON.stringify(normaliseField(field, row[field]));
  return FIELDS[type].filter((field) => value(a, field) !== value(b, field));
}

function projectCounts(source, target) {
  const projects = new Map();
  const bump = (project, field) => {
    const row = projects.get(project) ?? {
      project,
      sourceEntities: 0,
      targetEntities: 0,
      sourceObservations: 0,
      targetObservations: 0,
    };
    row[field] += 1;
    projects.set(project, row);
  };
  for (const e of source.entities) {
    bump(e.project, "sourceEntities");
  }
  for (const e of target.entities) {
    bump(e.project, "targetEntities");
  }
  for (const o of source.observations) {
    bump(o.entityProject, "sourceObservations");
  }
  for (const o of target.observations) {
    bump(o.entityProject, "targetObservations");
  }
  return [...projects.values()].sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
}
