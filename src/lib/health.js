import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { integrityReport } from "./sqliteDb.js";

/**
 * PASS/FAIL facts about the SQLite memory store. Read-only: opening with
 * openMemoryDb would create or upgrade the file, and a health check must not.
 */
export function healthChecks(file) {
  const checks = [{ name: "node", ok: true, detail: process.versions.node }];
  if (!fs.existsSync(file)) {
    checks.push({ name: "store", ok: false, detail: `${file} does not exist (start a session, or run npm run migrate-to-sqlite)` });
    return checks;
  }
  checks.push({ name: "store", ok: true, detail: file });
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const report = integrityReport(db);
    checks.push({
      name: "integrity",
      ok: report.ok,
      detail: `schema v${report.userVersion}, integrity ${report.integrity.join("; ")}, ${report.foreignKeyViolations} foreign-key violation(s)`,
    });
    if (report.ok) {
      const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      checks.push({ name: "contents", ok: true, detail: `${count("entities")} entities, ${count("observations")} observations` });
      const last = db.prepare("SELECT result, finished_at FROM migrations ORDER BY id DESC LIMIT 1").get();
      checks.push({ name: "migration", ok: true, detail: last ? `last ${last.result} at ${new Date(last.finished_at).toISOString()}` : "none recorded" });
    }
  } catch (error) {
    checks.push({ name: "integrity", ok: false, detail: error.message });
  } finally {
    db?.close();
  }
  return checks;
}
