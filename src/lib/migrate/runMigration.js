import fs from "node:fs";
import path from "node:path";
import { openMemoryDb, integrityReport } from "../sqliteDb.js";
import { fingerprint, readConsistentGraph } from "./fingerprint.js";
import { validateRecords, writeGraph } from "./writeSqlite.js";
import { readSqliteGraph } from "./readSqlite.js";
import { compareGraph } from "./compareGraph.js";

export const EXIT = Object.freeze({ PASSED: 0, CHECK_FAILED: 1, COULD_NOT_RUN: 2 });

/**
 * One migration run: a consistent read of the source, validation, the write (a
 * new file built under a temporary name, or a top-up of an existing one), the
 * check, the run log, the report and the summary. `readOnce` returns
 * GraphRecords; the CLI passes a Neo4j reader, tests pass fixtures.
 */
export async function runMigration({
  readOnce,
  out,
  checkOnly = false,
  reportPath,
  sourceLabel = "unknown source",
  log = console.log,
  now = Date.now,
}) {
  const startedAt = now();
  let read;
  try {
    read = await readConsistentGraph(readOnce);
  } catch (error) {
    log(`Reading the source graph failed; nothing was written: ${error.message}`);
    return { exitCode: EXIT.COULD_NOT_RUN };
  }
  if (!read.consistent) {
    log(`The graph changed between every pair of reads (${read.reads} reads); nothing was written. Try again at a quieter moment.`);
    return { exitCode: EXIT.COULD_NOT_RUN };
  }
  const problems = validateRecords(read.records);
  if (problems.length > 0) {
    log(
      `The source graph has ${problems.length} problem(s) SQLite cannot represent; nothing was written:\n  ` +
        problems.slice(0, 20).join("\n  ")
    );
    return { exitCode: EXIT.COULD_NOT_RUN, problems };
  }

  const existed = fs.existsSync(out);
  if (checkOnly && !existed) {
    log(`Nothing to check: ${out} does not exist.`);
    return { exitCode: EXIT.COULD_NOT_RUN };
  }
  let write = null;
  if (!checkOnly) {
    try {
      write = existed ? topUp(out, read.records) : buildNew(out, read.records);
    } catch (error) {
      log(`Writing ${out} failed; nothing was changed: ${error.message}`);
      return { exitCode: EXIT.COULD_NOT_RUN };
    }
  }

  const db = openMemoryDb(out, { readOnly: checkOnly });
  try {
    const comparison = compareGraph(read.records, readSqliteGraph(db));
    const integrity = integrityReport(db);
    const report = {
      source: sourceLabel,
      target: out,
      startedAt,
      finishedAt: now(),
      reads: read.reads,
      newFile: !existed,
      checkOnly,
      write,
      comparison,
      integrity,
      sourceFingerprint: fingerprint(read.records),
      ok: comparison.ok && integrity.ok,
    };
    if (!checkOnly) {
      logRun(db, report);
    }
    const reportFile = reportPath ?? defaultReportPath(out, report.finishedAt);
    writeReport(reportFile, report);
    log(formatSummary(report, reportFile));
    return { exitCode: report.ok ? EXIT.PASSED : EXIT.CHECK_FAILED, report, reportFile };
  } finally {
    db.close();
  }
}

// A first run builds the whole file under a temporary name and renames it into
// place only after every row is written, so the target path never holds a
// half-built database. A temp file left by an interrupted run is replaced.
//
// A -wal or -shm left beside a missing database is refused, not removed: SQLite
// would replay that WAL's pages into the renamed file, and it may hold writes
// nobody has seen. Moving it aside is the user's call.
function buildNew(out, records) {
  for (const leftover of [`${out}-wal`, `${out}-shm`]) {
    if (fs.existsSync(leftover)) {
      throw new Error(`${leftover} exists without its database and may hold unsaved writes; move it aside and run again`);
    }
  }
  const tmp = `${out}.tmp`;
  removeDbFiles(tmp);
  try {
    const db = openMemoryDb(tmp);
    let result;
    try {
      result = writeGraph(db, records);
    } finally {
      db.close();
    }
    // Closing the last connection checkpoints the WAL into the main file; a WAL
    // still on disk would hold rows the rename would leave behind.
    if (fs.existsSync(`${tmp}-wal`)) {
      throw new Error(`${tmp}-wal survived close; refusing to rename`);
    }
    fs.renameSync(tmp, out);
    return result;
  } catch (error) {
    removeDbFiles(tmp);
    throw error;
  }
}

function topUp(out, records) {
  const db = openMemoryDb(out);
  try {
    return writeGraph(db, records);
  } finally {
    db.close();
  }
}

function removeDbFiles(file) {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

function logRun(db, report) {
  const counts = Object.fromEntries(
    Object.entries(report.comparison.types).map(([type, t]) => [
      type,
      {
        source: t.source,
        inserted: report.write?.inserted[type] ?? null,
        missing: t.missing.length,
        changed: t.changed.length,
        extra: t.extra.length,
      },
    ])
  );
  db.prepare("INSERT INTO migrations (source, started_at, finished_at, counts, result) VALUES (?, ?, ?, ?, ?)").run(
    report.source,
    report.startedAt,
    report.finishedAt,
    JSON.stringify(counts),
    report.ok ? "passed" : "failed"
  );
}

function defaultReportPath(out, finishedAt) {
  const stamp = new Date(finishedAt).toISOString().replace(/:/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.join(path.dirname(out), `migration-report-${stamp}.json`);
}

// The report quotes observation text, so it gets the database's permissions.
function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const LABELS = {
  entities: "entities",
  observations: "observations",
  relations: "relations",
  sessions: "sessions",
  sessionLinks: "session links",
};
const HEADINGS = ["source", "inserted", "missing", "changed", "extra"];

/** The human summary printed at the end of a run. */
export function formatSummary(report, reportFile) {
  const cell = (value) => (value === null || value === undefined ? "-" : value.toLocaleString("en-US")).padStart(10);
  const { comparison, integrity } = report;
  const lines = [
    `Neo4j   ${report.source}   ${report.reads} reads, consistent`,
    `SQLite  ${report.target}   ${report.checkOnly ? "check only" : report.newFile ? "new file" : "existing file"}`,
    "",
    `${"".padEnd(14)}${HEADINGS.map((heading) => heading.padStart(10)).join("")}`,
  ];
  for (const [type, label] of Object.entries(LABELS)) {
    const t = comparison.types[type];
    const inserted = type === "sessionLinks" ? null : (report.write?.inserted[type] ?? null);
    const changed = type === "sessionLinks" ? null : t.changed.length;
    lines.push(`${label.padEnd(14)}${[t.source, inserted, t.missing.length, changed, t.extra.length].map(cell).join("")}`);
  }
  const matching = comparison.projects.filter(
    (p) => p.sourceEntities === p.targetEntities && p.sourceObservations === p.targetObservations
  ).length;
  const foreignKeys = integrity.foreignKeyViolations === 0 ? "ok" : `${integrity.foreignKeyViolations} violation(s)`;
  lines.push(
    "",
    `integrity ${integrity.integrity.join("; ")}   foreign keys ${foreignKeys}   ` +
      `per-project counts match in ${matching} of ${comparison.projects.length} projects`
  );
  if (comparison.notWellFormedText > 0) {
    lines.push(`${comparison.notWellFormedText} observation text(s) held a broken character, stored as U+FFFD`);
  }
  for (const [type, t] of Object.entries(comparison.types)) {
    for (const key of t.missing.slice(0, 20)) {
      lines.push(`  missing  ${LABELS[type]} ${key}`);
    }
    for (const row of t.changed.slice(0, 20)) {
      lines.push(`  changed  ${LABELS[type]} ${row.key}: ${row.fields.join(", ")}`);
    }
  }
  lines.push(`${report.ok ? "PASS" : "FAIL"}   report: ${reportFile}`);
  return lines.join("\n");
}
