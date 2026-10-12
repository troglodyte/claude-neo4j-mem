import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { runMigration, formatSummary, EXIT } from "../src/lib/migrate/runMigration.js";
import { fixtureRecords } from "./helpers/graphFixture.js";

function target() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-run-")), "memory.sqlite");
}

const quiet = () => {};
const run = (out, options = {}) =>
  runMigration({ readOnce: async () => fixtureRecords(), out, sourceLabel: "fixture", log: quiet, ...options });
const mode = (file) => fs.statSync(file).mode & 0o777;
const NONE = { entities: 0, sessions: 0, observations: 0, relations: 0 };

test("a first run builds the file, passes, and logs itself", async () => {
  const out = target();
  const { exitCode, report, reportFile } = await run(out);
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(report.newFile, true);
  assert.equal(fs.existsSync(`${out}.tmp`), false);
  assert.equal(mode(out), 0o600);
  assert.equal(mode(reportFile), 0o600);
  const db = new DatabaseSync(out, { readOnly: true });
  assert.deepEqual(
    db.prepare("SELECT result FROM migrations").all().map((row) => row.result),
    ["passed"]
  );
  db.close();
});

test("a second run inserts nothing and still passes", async () => {
  const out = target();
  await run(out);
  const { exitCode, report } = await run(out);
  assert.equal(exitCode, EXIT.PASSED);
  assert.deepEqual(report.write.inserted, NONE);
});

test("rows written to the source after a copy are added by the next run", async () => {
  const out = target();
  await run(out);
  const later = fixtureRecords();
  later.observations.push({ ...later.observations[4], id: "obs-late", seq: 200 });
  const { exitCode, report } = await run(out, { readOnce: async () => later });
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(report.write.inserted.observations, 1);
});

test("a graph that never holds still writes nothing and exits 2", async () => {
  const out = target();
  let reads = 0;
  const { exitCode } = await run(out, {
    readOnce: async () => {
      const records = fixtureRecords();
      records.observations.push({ ...records.observations[0], id: `late-${++reads}` });
      return records;
    },
  });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.equal(fs.existsSync(out), false);
});

test("a source read that throws exits 2 with its message", async () => {
  const lines = [];
  const { exitCode } = await run(target(), {
    readOnce: async () => {
      throw new Error("entity e createdAt is not a zoned datetime: x");
    },
    log: (line) => lines.push(line),
  });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.match(lines.join("\n"), /not a zoned datetime/);
});

test("a source graph SQLite cannot represent exits 2 before writing", async () => {
  const out = target();
  const records = fixtureRecords();
  records.entities.push({ ...records.entities[3] }); // a second global "user"
  const { exitCode, problems } = await run(out, { readOnce: async () => records });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.deepEqual(problems, ['duplicate entities ["user",""]']);
  assert.equal(fs.existsSync(out), false);
});

test("a corrupted file fails the check, exits 1 and is kept", async () => {
  const out = target();
  await run(out);
  const db = new DatabaseSync(out);
  db.exec("UPDATE observations SET text = 'tampered' WHERE id = 'obs-1'");
  db.close();
  const { exitCode, report } = await run(out, { checkOnly: true });
  assert.equal(exitCode, EXIT.CHECK_FAILED);
  assert.deepEqual(report.comparison.types.observations.changed, [{ key: '["obs-1"]', fields: ["text"] }]);
  assert.equal(fs.existsSync(out), true);
});

test("--check-only writes nothing to the database", async () => {
  const out = target();
  await run(out);
  await run(out, { checkOnly: true });
  const db = new DatabaseSync(out, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM migrations").get().n, 1);
  db.close();
});

test("--check-only without a file exits 2", async () => {
  const out = target();
  const { exitCode } = await run(out, { checkOnly: true });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.equal(fs.existsSync(out), false);
});

test("a temp file left by an interrupted run is replaced", async () => {
  const out = target();
  fs.writeFileSync(`${out}.tmp`, "not a database");
  const { exitCode } = await run(out);
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(fs.existsSync(`${out}.tmp`), false);
});

test("a target directory that does not exist yet is created", async () => {
  const out = path.join(path.dirname(target()), "fresh", "machine", "memory.sqlite");
  const { exitCode } = await run(out);
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(mode(path.dirname(out)), 0o700);
});

test(
  "a write that fails leaves no temp file and exits 2",
  { skip: process.getuid?.() === 0 && "root ignores directory permissions" },
  async () => {
    const dir = path.join(path.dirname(target()), "locked");
    fs.mkdirSync(dir, { mode: 0o500 });
    const { exitCode } = await run(path.join(dir, "memory.sqlite"));
    fs.chmodSync(dir, 0o700);
    assert.equal(exitCode, EXIT.COULD_NOT_RUN);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
);

test("a top-up waits for another process's write instead of failing", async () => {
  const out = target();
  await run(out);
  // A second process takes the write lock and holds it for 300 ms: the shape
  // of the new engine writing while a late top-up runs.
  const holder = spawn(process.execPath, [
    "--no-warnings",
    "--input-type=module",
    "-e",
    `import { DatabaseSync } from "node:sqlite";
     const db = new DatabaseSync(${JSON.stringify(out)});
     db.exec("BEGIN IMMEDIATE");
     console.log("locked");
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
     db.exec("COMMIT");
     db.close();`,
  ]);
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const later = fixtureRecords();
  later.observations.push({ ...later.observations[4], id: "obs-while-locked", seq: 300 });
  const { exitCode, report } = await run(out, { readOnce: async () => later });
  await new Promise((resolve) => holder.once("exit", resolve));
  assert.equal(exitCode, EXIT.PASSED);
  assert.equal(report.write.inserted.observations, 1);
});

test("the summary shows a row per type and the verdict", async () => {
  const { report, reportFile } = await run(target());
  const summary = formatSummary(report, reportFile);
  assert.match(summary, /^observations\s+6\s+6\s+0\s+0\s+0$/m);
  assert.match(summary, /^session links\s+4\s+-\s+0\s+-\s+0$/m);
  assert.match(summary, /^PASS {3}report: /m);
});

test("a graph with content the migration does not carry exits 2 before writing", async () => {
  const out = target();
  const records = fixtureRecords();
  records.unmapped = ["Observation.mood on 2 node(s) is not migrated"];
  const { exitCode, problems } = await run(out, { readOnce: async () => records });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.deepEqual(problems, ["Observation.mood on 2 node(s) is not migrated"]);
  assert.equal(fs.existsSync(out), false);
});

test("a leftover -wal without its database stops a first run and is kept", async () => {
  const out = target();
  fs.writeFileSync(`${out}-wal`, "unsaved writes from a killed process");
  const lines = [];
  const { exitCode } = await run(out, { log: (line) => lines.push(line) });
  assert.equal(exitCode, EXIT.COULD_NOT_RUN);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(`${out}-wal`), true);
  assert.match(lines.join("\n"), /memory\.sqlite-wal/);
});
