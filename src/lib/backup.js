import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { integrityReport } from "./sqliteDb.js";

const BACKUP_NAME = /^memory-\d{8}T\d{6}Z\.sqlite$/;

// 2026-10-12T17:15:00.123Z -> 20261012T171500Z
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * Online backup: VACUUM INTO a new file. Safe while sessions write, because a
 * WAL reader copies one consistent snapshot. Shares ~/.claude-neo4j/backups
 * with the legacy Neo4j dumps; --keep only ever prunes memory-*.sqlite files.
 */
export function backupStore({ source, dir, keep = null, now = new Date() }) {
  if (!fs.existsSync(source)) {
    throw new Error(`no memory store at ${source}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `memory-${stamp(now)}.sqlite`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(file);
  } finally {
    db.close();
  }
  fs.chmodSync(file, 0o600);
  const pruned = keep === null ? [] : listBackups(dir).slice(keep);
  for (const old of pruned) {
    fs.rmSync(old);
  }
  return { file, pruned };
}

export function listBackups(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .reverse()
    .map((name) => path.join(dir, name));
}

/** Pids holding `file` open, from lsof. Without lsof the guard cannot see anyone. */
export function openHolders(file) {
  const result = spawnSync("lsof", ["-t", file], { encoding: "utf8" });
  if (result.error || !result.stdout) {
    return [];
  }
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * Replaces the store with a backup. The current store (and its -wal/-shm) is
 * renamed aside, never deleted. Refuses while a process holds the store, because
 * a session writing through an open handle would keep writing into the renamed file.
 */
export function restoreStore({ backup, target, force = false, holders = openHolders(target), now = new Date() }) {
  const check = new DatabaseSync(backup, { readOnly: true });
  let report;
  try {
    report = integrityReport(check);
  } finally {
    check.close();
  }
  if (!report.ok) {
    throw new Error(`${backup} is not a healthy memory store: ${report.integrity.join("; ")} (schema version ${report.userVersion})`);
  }
  if (holders.length > 0 && !force) {
    throw new Error(`processes ${holders.join(", ")} have ${target} open; close Claude Code sessions first, or pass --force`);
  }
  let movedAside = null;
  if (fs.existsSync(target)) {
    movedAside = `${target}.pre-restore-${stamp(now)}`;
    fs.renameSync(target, movedAside);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(target + suffix)) {
        fs.renameSync(target + suffix, movedAside + suffix);
      }
    }
  }
  fs.copyFileSync(backup, target);
  fs.chmodSync(target, 0o600);
  return { target, movedAside };
}
