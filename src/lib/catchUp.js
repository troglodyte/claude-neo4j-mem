import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_DIR, memoryDbPath } from "./config.js";
import { openMemoryDb } from "./sqliteDb.js";
import { acquireLock, releaseLock } from "./firstStart.js";
import { readConsistentGraph, keyOf } from "./migrate/fingerprint.js";
import { writeGraph } from "./migrate/writeSqlite.js";
import { readSqliteGraph } from "./migrate/readSqlite.js";

// Sessions open when the plugin switched keep writing to Neo4j until they end.
// For 7 days, session start copies what they wrote: insert-only, never touching
// anything created before the switch, so a row the new engine deleted cannot come back.
// Spec: docs/superpowers/specs/2026-10-09-sqlite-engine-design.md, "Catch-up after the switch".

export const CATCH_UP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const WORKER = fileURLToPath(new URL("../../scripts/catch-up.mjs", import.meta.url));
const statePath = (stateDir) => path.join(stateDir, "catch-up.json");

/** When this store switched to SQLite: the first passed migration's finished_at, or null. */
export function switchedAt(db) {
  return db.prepare("SELECT min(finished_at) AS at FROM migrations WHERE result = 'passed'").get()?.at ?? null;
}

export function catchUpDue(db, { now = Date.now() } = {}) {
  const at = switchedAt(db);
  return at !== null && now - at < CATCH_UP_DAYS * DAY_MS;
}

const entityKey = (name, project) => keyOf("entities", { name, project });

/**
 * The part of a Neo4j read to copy: rows created after `since`, plus the entities
 * they need. An entity created before the switch is only ever referenced: if
 * SQLite no longer has it, it was deleted there, and its new rows are dropped.
 */
export function rowsToCopy(records, { since, switchAt, existing }) {
  const byKey = new Map(records.entities.map((e) => [entityKey(e.name, e.project), e]));
  const usable = (name, project) => {
    const key = entityKey(name, project);
    return existing.has(key) || (byKey.get(key)?.createdAt ?? -Infinity) > switchAt;
  };
  const observations = records.observations.filter((o) => o.createdAt > since && usable(o.entityName, o.entityProject));
  const relations = records.relations.filter(
    (r) => (r.createdAt ?? -Infinity) > since && usable(r.fromName, r.fromProject) && usable(r.toName, r.toProject)
  );
  const sessions = records.sessions.filter((s) => s.startedAt > since);
  const needed = new Set([
    ...observations.map((o) => entityKey(o.entityName, o.entityProject)),
    ...relations.flatMap((r) => [entityKey(r.fromName, r.fromProject), entityKey(r.toName, r.toProject)]),
  ]);
  const copied = new Set(observations.map((o) => o.id));
  return {
    entities: [...needed].map((key) => byKey.get(key)).filter(Boolean),
    observations,
    relations,
    sessions,
    sessionLinks: (records.sessionLinks ?? []).filter((link) => copied.has(link.observationId)),
    unmapped: [],
  };
}

// The check, limited to the copied rows: each must now be in the store.
function missingAfterCopy(rows, target) {
  const missing = [];
  for (const type of ["entities", "observations", "relations", "sessions"]) {
    const have = new Set(target[type].map((record) => keyOf(type, record)));
    for (const record of rows[type]) {
      if (!have.has(keyOf(type, record))) {
        missing.push(`${type} ${keyOf(type, record)}`);
      }
    }
  }
  return missing;
}

function readState(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(stateDir), "utf8"));
  } catch {
    return null;
  }
}

function writeState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath(stateDir), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

/**
 * One catch-up run. Each run copies only rows newer than the last run's newest
 * copied row (the watermark), so a copied row deleted in SQLite later is not copied again.
 */
export async function runCatchUp({ dbPath = memoryDbPath(), stateDir = STATE_DIR, readOnce, now = Date.now(), log = console.log }) {
  if (!acquireLock({ stateDir })) {
    return { skipped: "locked" };
  }
  try {
    const db = openMemoryDb(dbPath);
    try {
      const switchAt = switchedAt(db);
      if (switchAt === null || now - switchAt >= CATCH_UP_DAYS * DAY_MS) {
        return { skipped: "outside the catch-up window" };
      }
      const since = Math.max(switchAt, readState(stateDir)?.watermark ?? switchAt);
      let read;
      try {
        read = await readConsistentGraph(readOnce);
      } catch (error) {
        log(`catch-up: skipped: ${error.message}`);
        return { skipped: "neo4j unreachable" };
      }
      if (!read.consistent) {
        log("catch-up: skipped: Neo4j kept changing between reads");
        return { skipped: "inconsistent" };
      }
      const existing = new Set(db.prepare("SELECT name, project FROM entities").all().map((e) => entityKey(e.name, e.project)));
      const rows = rowsToCopy(read.records, { since, switchAt, existing });
      const write = writeGraph(db, rows);
      const missing = missingAfterCopy(rows, readSqliteGraph(db));
      if (missing.length > 0) {
        log(`catch-up: check failed: ${missing.slice(0, 5).join("; ")}`);
        return { failed: missing };
      }
      const watermark = Math.max(
        since,
        ...rows.observations.map((o) => o.createdAt),
        ...rows.relations.map((r) => r.createdAt ?? since),
        ...rows.sessions.map((s) => s.startedAt)
      );
      writeState(stateDir, { watermark, lastRun: now, copied: write.inserted });
      log(`catch-up: copied ${JSON.stringify(write.inserted)} created after ${new Date(since).toISOString()}`);
      return { copied: write.inserted, watermark };
    } finally {
      db.close();
    }
  } finally {
    releaseLock({ stateDir });
  }
}

/** Detaches scripts/catch-up.mjs; its output goes to state/catch-up.log. */
export function spawnCatchUp({ stateDir = STATE_DIR, nodePath = process.execPath } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(stateDir, "catch-up.log"), "a", 0o600);
  try {
    const child = spawn(nodePath, ["--disable-warning=ExperimentalWarning", WORKER], { detached: true, stdio: ["ignore", log, log] });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}
