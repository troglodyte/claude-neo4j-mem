import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { writeGraph } from "../src/lib/migrate/writeSqlite.js";
import { readSqliteGraph } from "../src/lib/migrate/readSqlite.js";
import { compareGraph } from "../src/lib/migrate/compareGraph.js";
import { fixtureRecords, FIXTURE_PROJECT as P } from "./helpers/graphFixture.js";

// Each case damages one stored field the way a buggy writer or a damaged file
// could, then names the row the check must report: as changed (with that
// field) or, when the damage alters the row's key, as missing.
const CASES = [
  { name: "entity type", sql: "UPDATE entities SET type = 'changed' WHERE name = 'decision:storage-layout' AND project = ?", params: [P], type: "entities", key: ["decision:storage-layout", P], changed: "type" },
  { name: "entity createdAt", sql: "UPDATE entities SET created_at = created_at + 1 WHERE name = 'ticket:APP-1'", type: "entities", key: ["ticket:APP-1", P], changed: "createdAt" },
  { name: "entity updatedAt", sql: "UPDATE entities SET updated_at = NULL WHERE name = 'decision:storage-layout' AND project = ?", params: [P], type: "entities", key: ["decision:storage-layout", P], changed: "updatedAt" },
  { name: "observation text", sql: "UPDATE observations SET text = replace(text, 'two', 'twO') WHERE id = 'obs-1'", type: "observations", key: ["obs-1"], changed: "text" },
  { name: "observation owner", sql: "UPDATE observations SET entity_id = (SELECT id FROM entities WHERE name = 'service:billing') WHERE id = 'obs-4'", type: "observations", key: ["obs-4"], changed: "entityName" },
  { name: "observation subsystem", sql: "UPDATE observations SET subsystem = NULL WHERE id = 'obs-1'", type: "observations", key: ["obs-1"], changed: "subsystem" },
  { name: "observation source", sql: "UPDATE observations SET source = NULL WHERE id = 'obs-5'", type: "observations", key: ["obs-5"], changed: "source" },
  { name: "observation session id", sql: "UPDATE observations SET session_id = 'sess-2' WHERE id = 'obs-5'", type: "observations", key: ["obs-5"], changed: "sessionId" },
  { name: "observation createdAt", sql: "UPDATE observations SET created_at = created_at - 1 WHERE id = 'obs-2'", type: "observations", key: ["obs-2"], changed: "createdAt" },
  { name: "relation createdAt", sql: "UPDATE relations SET created_at = 1 WHERE type = 'depends-on'", type: "relations", key: ["ticket:APP-1", P, "depends-on", "service:billing", P], changed: "createdAt" },
  { name: "relation type", sql: "UPDATE relations SET type = 'replaces' WHERE type = 'implements'", type: "relations", key: ["decision:storage-layout", P, "implements", "ticket:APP-1", P], missing: true },
  { name: "relation endpoint", sql: "UPDATE relations SET to_id = (SELECT id FROM entities WHERE name = 'user') WHERE type = 'depends-on'", type: "relations", key: ["ticket:APP-1", P, "depends-on", "service:billing", P], missing: true },
  { name: "session cwd", sql: "UPDATE sessions SET cwd = '/elsewhere' WHERE id = 'sess-1'", type: "sessions", key: ["sess-1"], changed: "cwd" },
  { name: "session project", sql: "UPDATE sessions SET project = 'other' WHERE id = 'sess-2'", type: "sessions", key: ["sess-2"], changed: "project" },
  { name: "session startedAt", sql: "UPDATE sessions SET started_at = started_at + 1 WHERE id = 'sess-2'", type: "sessions", key: ["sess-2"], changed: "startedAt" },
  { name: "dropped session link", sql: "UPDATE observations SET session_id = NULL WHERE id = 'obs-6'", type: "sessionLinks", key: ["sess-2", "obs-6"], missing: true },
  { name: "deleted observation", sql: "DELETE FROM observations WHERE id = 'obs-3'", type: "observations", key: ["obs-3"], missing: true },
  { name: "deleted session", sql: "DELETE FROM sessions WHERE id = 'sess-1'", type: "sessions", key: ["sess-1"], missing: true },
];

for (const c of CASES) {
  test(`the check catches a corrupted ${c.name}`, () => {
    const db = openMemoryDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-sabotage-")), "memory.sqlite"));
    writeGraph(db, fixtureRecords());
    db.prepare(c.sql).run(...(c.params ?? []));
    const report = compareGraph(fixtureRecords(), readSqliteGraph(db));
    db.close();
    const key = JSON.stringify(c.key);
    assert.equal(report.ok, false, "the corruption must fail the check");
    if (c.missing) {
      assert.ok(report.types[c.type].missing.includes(key), `${key} must be reported missing`);
    } else {
      assert.deepEqual(report.types[c.type].changed.find((row) => row.key === key)?.fields, [c.changed]);
    }
  });
}
