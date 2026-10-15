// Statistics for one project's memory, or the whole store (`npm run stats`):
// what it holds, how it grew, and how it is shaped. `npm run usage` is the
// cross-project table and hygiene warnings; this is the per-project trend view.
// A null project means the whole store, global entities (project '') included.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
// 1970-01-05, the first Monday after the epoch: weeks start on UTC Mondays.
const FIRST_MONDAY_MS = 4 * DAY_MS;
// The report lists this many entity types, tags and relation types, then says how many it
// left out. Types and relation types are free text the extraction model invents, so their
// tails run to hundreds of singletons.
const LISTED_ROWS = 8;
const LISTED_RELATION_TYPES = 5;

// Every query filters entities through this, binding :project.
const IN_SCOPE = "(:project IS NULL OR e.project = :project)";

/** Gathers the report from an open memory database. Pure apart from the reads. */
export function buildStatsReport(db, { project = null, now = Date.now(), weeks = 12 } = {}) {
  const scope = { project };
  return {
    project,
    summary: summary(db, scope),
    weekly: weekly(db, scope, now, weeks),
    sessionYield: sessionYield(db, scope),
    lengths: lengths(db, scope),
    subsystems: subsystems(db, scope),
    relations: relations(db, scope),
  };
}

function summary(db, scope) {
  const counts = db
    .prepare(
      `SELECT count(*) AS observations,
              count(DISTINCT o.session_id) AS sessions,
              min(o.created_at) AS firstAt,
              max(o.created_at) AS lastAt
         FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE ${IN_SCOPE}`,
    )
    .get(scope);
  const types = db
    .prepare(
      `SELECT e.type AS type, count(*) AS n FROM entities e
        WHERE ${IN_SCOPE} GROUP BY e.type ORDER BY n DESC, e.type`,
    )
    .all(scope)
    .map((row) => ({ ...row }));
  return {
    entities: types.reduce((sum, t) => sum + t.n, 0),
    observations: counts.observations,
    relations: relationCount(db, scope),
    sessions: counts.sessions,
    firstAt: formatDay(counts.firstAt),
    lastAt: formatDay(counts.lastAt),
    types,
  };
}

// A relation belongs to the project when either end does.
const SCOPED_RELATIONS = `
  SELECT r.* FROM relations r
   WHERE r.from_id IN (SELECT e.id FROM entities e WHERE ${IN_SCOPE})
      OR r.to_id   IN (SELECT e.id FROM entities e WHERE ${IN_SCOPE})`;

function relationCount(db, scope) {
  return db.prepare(`SELECT count(*) AS n FROM (${SCOPED_RELATIONS})`).get(scope).n;
}

/** New observations and entities per week for the last `weeks` weeks, oldest first. */
function weekly(db, scope, now, weeks) {
  const thisWeek = now - ((now - FIRST_MONDAY_MS) % WEEK_MS);
  const since = thisWeek - (weeks - 1) * WEEK_MS;
  const rows = Array.from({ length: weeks }, (_, i) => ({
    week: formatDay(since + i * WEEK_MS),
    observations: 0,
    entities: 0,
  }));
  const count = (from, column) =>
    db
      .prepare(
        `SELECT CAST((${column} - :since) / ${WEEK_MS} AS INTEGER) AS i, count(*) AS n
           FROM ${from}
          WHERE ${IN_SCOPE} AND ${column} >= :since AND ${column} < :until
          GROUP BY i`,
      )
      .all({ ...scope, since, until: thisWeek + WEEK_MS });
  for (const { i, n } of count("observations o JOIN entities e ON e.id = o.entity_id", "o.created_at")) {
    rows[i].observations = n;
  }
  for (const { i, n } of count("entities e", "e.created_at")) {
    rows[i].entities = n;
  }
  return rows;
}

/** How many observations each capturing session left behind. */
function sessionYield(db, scope) {
  const yields = db
    .prepare(
      `SELECT count(*) AS n
         FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE ${IN_SCOPE} AND o.session_id IS NOT NULL
        GROUP BY o.session_id
        ORDER BY n`,
    )
    .all(scope)
    .map((row) => row.n);
  const unsessioned = db
    .prepare(
      `SELECT count(*) AS n
         FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE ${IN_SCOPE} AND o.session_id IS NULL`,
    )
    .get(scope).n;
  return { ...spread(yields), unsessioned };
}

// Read paths are budgeted in characters, so long observations are what crowd a payload.
const LONG_OBSERVATION_CHARS = 1000;

function lengths(db, scope) {
  const sorted = db
    .prepare(
      `SELECT length(o.text) AS n
         FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE ${IN_SCOPE}
        ORDER BY n`,
    )
    .all(scope)
    .map((row) => row.n);
  return { ...spread(sorted), over1000: sorted.filter((n) => n > LONG_OBSERVATION_CHARS).length };
}

/** How observations spread over subsystem tags; `npm run usage` owns the hygiene checks. */
function subsystems(db, scope) {
  const counts = db
    .prepare(
      `SELECT o.subsystem AS tag, count(*) AS n
         FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE ${IN_SCOPE}
        GROUP BY o.subsystem
        ORDER BY n DESC, tag`,
    )
    .all(scope)
    .map((row) => ({ ...row }));
  const tagged = counts.filter((c) => c.tag !== null);
  return {
    tagged: tagged.reduce((sum, c) => sum + c.n, 0),
    untagged: counts.find((c) => c.tag === null)?.n ?? 0,
    tags: tagged,
  };
}

const MOST_CONNECTED = 5;

function relations(db, scope) {
  const rows = (sql) =>
    db
      .prepare(sql)
      .all(scope)
      .map((row) => ({ ...row }));
  const types = rows(
    `SELECT type, count(*) AS n FROM (${SCOPED_RELATIONS})
      GROUP BY type ORDER BY n DESC, type`,
  );
  const connected = rows(
    `SELECT e.name AS name, e.project AS project, count(*) AS degree
       FROM (SELECT from_id AS id FROM relations UNION ALL SELECT to_id FROM relations) ends
       JOIN entities e ON e.id = ends.id
      WHERE ${IN_SCOPE}
      GROUP BY e.id ORDER BY degree DESC, e.name LIMIT ${MOST_CONNECTED}`,
  );
  const unrelated = db
    .prepare(
      `SELECT count(*) AS n FROM entities e
        WHERE ${IN_SCOPE}
          AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.from_id = e.id OR r.to_id = e.id)`,
    )
    .get(scope).n;
  return { types, connected, unrelated };
}

/** Median, p90 and max of ascending values, by nearest rank; null when there are none. */
function spread(sorted) {
  const rank = (p) => sorted[Math.ceil(p * sorted.length) - 1] ?? null;
  return { median: rank(0.5), p90: rank(0.9), max: sorted.at(-1) ?? null };
}

const BAR_WIDTH = 30;
const num = (n) => (n == null ? "-" : n.toLocaleString("en-US"));
const pct = (part, whole) => (whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`);

/** Renders a report from buildStatsReport as plain text for a terminal. */
export function renderStatsReport(report) {
  const { project, summary: s } = report;
  if (s.entities === 0) {
    return project === null
      ? "No memory recorded in this store.\n"
      : `No memory recorded for ${project}.\nRun with --all for the whole store, or \`npm run usage\` to list every project.\n`;
  }
  const label = (e) => (project === null ? `${e.name} (${e.project || "global"})` : e.name);
  return [
    `Memory stats: ${project ?? "all projects"}`,
    `  ${num(s.entities)} entities, ${num(s.observations)} observations, ${num(s.relations)} relations, ` +
      `${num(s.sessions)} sessions with captures · ${s.firstAt} → ${s.lastAt}`,
    `  types: ${listed(s.types, LISTED_ROWS, (t) => `${t.type ?? "(untyped)"} ${num(t.n)}`).join(", ")}`,
    "",
    ...renderWeekly(report.weekly),
    "",
    ...renderSpreads(report),
    "",
    ...renderSubsystems(report.subsystems),
    "",
    ...renderRelations(report.relations, label),
    "",
  ].join("\n");
}

/** The first `limit` items formatted, then "+N more" when any were left out, so a trimmed list says so. */
function listed(items, limit, format) {
  const rest = items.length - limit;
  return [...items.slice(0, limit).map(format), ...(rest > 0 ? [`+${num(rest)} more`] : [])];
}

function renderWeekly(weekly) {
  const busiest = Math.max(1, ...weekly.map((w) => w.observations));
  const width = (key, heading) => Math.max(heading.length, ...weekly.map((w) => num(w[key]).length));
  const obs = width("observations", "OBS");
  const ent = width("entities", "ENT");
  return [
    "Weekly growth (UTC weeks from Monday)",
    `  ${"WEEK".padEnd(10)}  ${"OBS".padStart(obs)}  ${"ENT".padStart(ent)}`,
    ...weekly.map(
      (w) =>
        `  ${w.week}  ${num(w.observations).padStart(obs)}  ${num(w.entities).padStart(ent)}  ` +
        "█".repeat(Math.round((w.observations / busiest) * BAR_WIDTH)),
    ),
  ].map((line) => line.trimEnd());
}

function renderSpreads({ sessionYield: y, lengths: l }) {
  return [
    `Observations per session: median ${num(y.median)} · p90 ${num(y.p90)} · max ${num(y.max)} · ` +
      `${num(y.unsessioned)} without a session`,
    `Observation length (chars): median ${num(l.median)} · p90 ${num(l.p90)} · max ${num(l.max)} · ` +
      `${num(l.over1000)} over 1,000`,
  ];
}

// Shares are of all observations, untagged included; `npm run usage`'s concentration
// check divides by tagged observations only, so its percentages run higher.
function renderSubsystems({ tagged, untagged, tags }) {
  const total = tagged + untagged;
  const shown = tags.slice(0, LISTED_ROWS);
  const width = Math.max(0, ...shown.map((t) => t.tag.length));
  const count = Math.max(0, ...shown.map((t) => num(t.n).length));
  return [
    `Subsystems: ${num(tagged)} tagged, ${num(untagged)} untagged (${pct(untagged, total)} of all observations)`,
    ...listed(
      tags,
      LISTED_ROWS,
      (t) => `${t.tag.padEnd(width)}  ${num(t.n).padStart(count)}  ${pct(t.n, total).padStart(4)}`,
    ).map((line) => `  ${line}`),
  ];
}

function renderRelations({ types, connected, unrelated }, label) {
  return [
    "Relations",
    `  types: ${listed(types, LISTED_RELATION_TYPES, (t) => `${t.type} ${num(t.n)}`).join(", ") || "none"}`,
    `  ${num(unrelated)} entities with no relations`,
    ...(connected.length > 0 ? ["  most connected (relations, entity):"] : []),
    ...connected.map((e) => `  ${num(e.degree).padStart(5)}  ${label(e)}`),
  ];
}

function formatDay(ms) {
  return ms == null ? "-" : new Date(ms).toISOString().slice(0, 10);
}
