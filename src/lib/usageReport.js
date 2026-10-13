import { PINNED_ENTITY_SQL } from "./graph.js";
import { isCatchAllTag } from "./subsystem.js";

// Cross-project usage report (`npm run usage`): every project in the store with
// its entity/observation counts and activity window, totals, and hygiene
// warnings. Reads the whole store, not just the current project. Global
// entities are stored with project '' and count as unscoped, not as a project.

const DAY_MS = 86_400_000;
const FAT_ENTITY_OBSERVATIONS = 100;
const LISTED_ENTITIES = 10;

/** Gathers the report from an open memory database. Pure apart from the reads. */
export function buildUsageReport(db, { now = Date.now() } = {}) {
  const projects = projectRows(db, now);
  const tags = tagCounts(db);
  const warnings = [
    splitProjects(projects),
    fatEntities(db),
    emptyEntities(db),
    costlyMaps(tags),
    catchAllTags(tags),
    collapsedMaps(tags),
    unclassifiedHistory(db),
    selfNamedTags(tags),
  ].filter((w) => w.lines.length > 0);
  return { projects, totals: totals(db), warnings };
}

function projectRows(db, now) {
  return db
    .prepare(
      `SELECT e.project AS project,
              count(DISTINCT e.id) AS entities,
              count(o.id) AS observations,
              count(CASE WHEN o.created_at >= :since THEN 1 END) AS last7d,
              min(o.created_at) AS firstAt,
              max(o.created_at) AS lastAt
         FROM entities e LEFT JOIN observations o ON o.entity_id = e.id
        WHERE e.project != ''
        GROUP BY e.project
        ORDER BY lastAt IS NULL, lastAt DESC, e.project`,
    )
    .all({ since: now - 7 * DAY_MS })
    .map((row) => ({
      ...row,
      firstAt: formatTime(row.firstAt, 10),
      lastAt: formatTime(row.lastAt, 16),
    }));
}

function formatTime(ms, length) {
  return ms == null ? "-" : new Date(ms).toISOString().slice(0, length).replace("T", " ");
}

function totals(db) {
  const row = db
    .prepare(
      `SELECT count(DISTINCT CASE WHEN project != '' THEN project END) AS projects,
              count(*) AS entities,
              (SELECT count(*) FROM observations) AS observations,
              (SELECT count(*) FROM relations) AS relations,
              count(CASE WHEN project = '' THEN 1 END) AS unscoped
         FROM entities`,
    )
    .get();
  return { ...row };
}

/** Observation counts per (project, tag), smallest first, for the map checks. */
function tagCounts(db) {
  return db
    .prepare(
      `SELECT e.project AS project, o.subsystem AS tag, count(*) AS n
         FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE o.subsystem IS NOT NULL
        GROUP BY e.project, o.subsystem
        ORDER BY n, tag`,
    )
    .all();
}

function groupByProject(rows) {
  const groups = new Map();
  for (const row of rows) {
    groups.set(row.project, [...(groups.get(row.project) ?? []), row]);
  }
  return groups;
}

function projectLabel(project) {
  return project === "" ? "no project" : project;
}

function percent(part, whole) {
  return Math.trunc((100 * part) / whole);
}

// Near-duplicate project names: same trailing path segment recorded under two
// different identifiers (e.g. "foo" and "github.com/someone/foo"), which means
// the same repo's memory is split in two and neither session sees the other.
function splitProjects(projects) {
  const byBase = groupByProject(projects.map(({ project }) => ({ project: project.split("/").at(-1), name: project })));
  const lines = [...byBase]
    .filter(([, rows]) => rows.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([base, rows]) => `${base}: ${rows.map((r) => r.name).join(", ")}`);
  return { heading: "Projects recorded under more than one name (memory is split between them):", lines };
}

// Entities hoarding observations, usually a sign of a bulk import or an
// over-broad entity that should have been split up.
function fatEntities(db) {
  const lines = db
    .prepare(
      `SELECT e.name, e.project, count(*) AS n
         FROM observations o JOIN entities e ON e.id = o.entity_id
        GROUP BY e.id HAVING n >= :min
        ORDER BY n DESC LIMIT :limit`,
    )
    .all({ min: FAT_ENTITY_OBSERVATIONS, limit: LISTED_ENTITIES })
    .map((r) => `${r.name} (${projectLabel(r.project)}): ${r.n} observations`);
  return { heading: "Entities with 100+ observations (consider splitting or pruning):", lines };
}

// Entities that carry no observations at all are leftover stubs.
function emptyEntities(db) {
  const lines = db
    .prepare(
      `SELECT e.name, e.project FROM entities e
        WHERE NOT EXISTS (SELECT 1 FROM observations o WHERE o.entity_id = e.id)
        ORDER BY e.name LIMIT :limit`,
    )
    .all({ limit: LISTED_ENTITIES })
    .map((r) => `${r.name} (${projectLabel(r.project)})`);
  return { heading: "Entities with zero observations (empty stubs):", lines };
}

// A fragmented map is one that has stopped being a table of contents, usually
// because of near-synonyms ("capture" and "auto-capture") the lexical deduper
// can't merge. Counting distinct tags measures project size instead: a real
// 818-observation product carried 15 subsystems, none holding fewer than 9
// observations, and tripped a `tags > 12` rule that a half-empty project with
// three one-observation slivers slipped under.
//
// So this measures what the map costs to read, the same way every path in
// budget.js is bounded by characters rather than by rows - the map is injected
// into every session, and a tag's name length matters as much as the tag count.
// Cells are sized as injection.js renders them: "<tag> (<n>, MM-DD)" joined by
// " . ", i.e. tag + digits + 10, plus 3 per gap. Live maps measure 170-336
// chars, so 800 is roughly 30 average tags: past that the map is both expensive
// per session and too long to skim. The smallest tags are named because they
// are the merge candidates.
const MAP_CHAR_LIMIT = 800;

function costlyMaps(tags) {
  const lines = [...groupByProject(tags)]
    .map(([project, rows]) => ({
      project,
      rows,
      chars: rows.reduce((sum, r) => sum + r.tag.length + String(r.n).length + 10, 0) + 3 * (rows.length - 1),
    }))
    .filter((m) => m.chars > MAP_CHAR_LIMIT)
    .sort((a, b) => b.chars - a.chars)
    .map(
      (m) =>
        `${projectLabel(m.project)}: ${m.chars} chars across ${m.rows.length} subsystems; smallest are ` +
        m.rows.slice(0, 3).map((r) => `${r.tag} (${r.n})`).join(", "),
    );
  return {
    heading: "Projects whose subsystem map is costly to inject every session (merge near-synonyms):",
    lines,
  };
}

// The opposite failure to fragmentation, and invisible to the check above: one
// tag that isn't a subsystem at all. A mandatory `subsystem` field in the
// backfill's schema once left the model no way to say "cross-cutting", so its
// prompt named an escape hatch and 20% of every project's history ended up
// behind it - 85% of that not cross-cutting, merely unclassified. Cross-cutting
// facts are stored with no subsystem now (they are surfaced by the pinned-facts
// block instead), so any of these names in the store is pre-fix data or a
// hand-written update.
function catchAllTags(tags) {
  const lines = tags
    .filter((r) => isCatchAllTag(r.tag))
    .sort((a, b) => b.n - a.n)
    .map((r) => `${projectLabel(r.project)}: ${r.tag} holds ${r.n} observation(s)`);
  return { heading: "Catch-all subsystem tags (reclassify: npm run backfill-subsystems -- --retag TAG):", lines };
}

// Concentration, the mirror image of the fragmentation check above - and equally
// invisible to it. A project whose tags have collapsed into one bucket has a
// *small* map: five tags render well under 800 chars while telling the reader
// almost nothing. The reported case was 133 of 202 tagged observations under
// "infrastructure" in an OAuth authorization server whose `oauth` tag held 8.
//
// The catch-all check can't see this either: it matches tag names that admit to
// being junk drawers, and "infrastructure" is a plausible domain word. It then
// compounds, because both extraction prompts seed their vocabulary from
// listSubsystems with "prefer one of these" - the biggest tag is offered first
// to every later batch.
//
// Calibrated against nine projects, which is enough to see the band but not to
// call it universal: healthy projects span 16-36%, the one flagged sat at 44%,
// and the reported case was 66%. So 40 clears every healthy project by only
// four points - re-measure before trusting it on differently shaped projects.
//
// The 40-observation floor is load-bearing, not a rounding guard: without it
// the smallest projects (12-22 observations) trip at 33-55% purely on sample
// size - five observations in one bucket out of nine tagged.
const SHARE_FLOOR = 40;
const DOMINANT_PCT = 40;

function collapsedMaps(tags) {
  const lines = [...groupByProject(tags)]
    .map(([project, rows]) => {
      const top = rows.at(-1);
      const tagged = rows.reduce((sum, r) => sum + r.n, 0);
      return { project, top, tagged, pct: percent(top.n, tagged) };
    })
    .filter((m) => m.tagged >= SHARE_FLOOR && m.pct > DOMINANT_PCT)
    .sort((a, b) => b.pct - a.pct)
    .map(
      (m) =>
        `${projectLabel(m.project)}: ${m.top.tag} holds ${m.top.n} of ${m.tagged} tagged observation(s) (${m.pct}%)`,
    );
  return {
    heading:
      "Subsystem maps that have collapsed into one bucket (split it: npm run backfill-subsystems -- --retag TAG):",
    lines,
  };
}

// Untagged history, which the map reports as an honest count but no rule acts
// on. Pinned entities are excluded deliberately: a preference or project-wide
// constraint has no subsystem by design and reaches the model through the
// pinned-facts block, so counting it as unclassified would indict correct
// behaviour. The predicate is graph.js's own. Same calibration caveat as above,
// and thinner: healthy projects measured 0-25%, the flagged one 34%, the
// reported case 41%, so this is the likelier of the two to cry wolf on a
// project that simply hasn't been backfilled yet.
const UNCLASSIFIED_PCT = 30;

function unclassifiedHistory(db) {
  const lines = db
    .prepare(
      `SELECT e.project AS project, count(*) AS total,
              sum(CASE WHEN o.subsystem IS NULL AND NOT ${PINNED_ENTITY_SQL} THEN 1 ELSE 0 END) AS unclassified
         FROM observations o JOIN entities e ON e.id = o.entity_id
        GROUP BY e.project HAVING total >= :floor`,
    )
    .all({ floor: SHARE_FLOOR })
    .map((r) => ({ ...r, pct: percent(r.unclassified, r.total) }))
    .filter((r) => r.pct > UNCLASSIFIED_PCT)
    .sort((a, b) => b.pct - a.pct)
    .map(
      (r) =>
        `${projectLabel(r.project)}: ${r.unclassified} of ${r.total} observation(s) carry no subsystem (${r.pct}%), ` +
        "excluding cross-cutting facts where null is correct",
    );
  return {
    heading: "Projects with a large unclassified history (tag it: npm run backfill-subsystems -- --dry-run):",
    lines,
  };
}

// A tag named after the project itself. Every observation in a project is about
// that project, so such a tag partitions nothing by construction - a junk
// drawer whichever share it holds, which the two checks above cannot see.
// Measured live: context-watch-plugin's biggest tag was "context-watch", and
// once its untagged history was backfilled the share check went quiet while the
// tag went on meaning exactly as little as before.
//
// Matched on tokens rather than as a substring, because a substring test fires
// on accidents: 'malleus' contains "alle". Tokens are compared against the last
// path segment only, so 'github' and a user name can never be a tag's whole
// meaning.
function selfNamedTags(tags) {
  const lines = tags
    .filter((r) => r.project !== "")
    .filter((r) => {
      const base = new Set(r.project.split("/").at(-1).replaceAll("_", "-").split("-"));
      return r.tag.split("-").every((token) => base.has(token));
    })
    .sort((a, b) => b.n - a.n)
    .map((r) => `${r.project}: ${r.tag} (${r.n} observation(s)) repeats the project name`);
  return {
    heading:
      "Subsystem tags named after their own project, which separate nothing (npm run backfill-subsystems -- --retag TAG):",
    lines,
  };
}

/** Renders the report as the terminal text `npm run usage` prints. */
export function renderUsageReport({ projects, totals: t, warnings }, { quiet = false } = {}) {
  if (projects.length === 0) {
    return "No projects tracked in the memory store yet.\n";
  }
  const row = (cells) =>
    `${cells[0].padEnd(42)} ${cells[1].padStart(8)} ${cells[2].padStart(8)} ${cells[3].padStart(8)} ${cells[4].padEnd(12)} ${cells[5]}`.trimEnd();
  const table = [
    row(["PROJECT", "ENTITIES", "OBS", "OBS/7D", "FIRST", "LAST ACTIVITY"]),
    ...projects.map((p) =>
      row([p.project, String(p.entities), String(p.observations), String(p.last7d), p.firstAt, p.lastAt]),
    ),
  ];
  const unscoped = t.unscoped > 0 ? ` (${t.unscoped} entity/entities have no project)` : "";
  const out = [
    "Projects in the memory store",
    "",
    ...table,
    "",
    `Totals: ${t.projects} project(s), ${t.entities} entities, ${t.observations} observations, ${t.relations} relations${unscoped}`,
  ];
  if (!quiet && warnings.length > 0) {
    out.push("", ...warnings.flatMap((w) => [w.heading, ...w.lines.map((l) => `  ${l}`), ""]));
    out.push("Clean up with: npm run memory -- prune --dry-run   (or 'forget <entity>' to drop one)");
  }
  return `${out.join("\n")}\n`;
}
