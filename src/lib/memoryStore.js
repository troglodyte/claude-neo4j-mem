import { openMemoryDb } from "./sqliteDb.js";
import { memoryDbPath } from "./config.js";
import { storeState, offReason } from "./firstStart.js";

// One connection per process, opened on first use. Hooks and the memory server
// are separate processes, so concurrent writers meet in SQLite's WAL and busy
// timeout, not here. The path is resolved when the store opens and stays fixed
// until closeDb(): config.json mid-rewrite reads as no config, and a running
// server that followed it would write into a different, empty store.
let open = null;

export function getDb() {
  if (!open) {
    const file = memoryDbPath();
    // A tool call or capture during the move must not create an empty store:
    // first start would then see a store and never migrate.
    const reason = offReason(storeState({ dbPath: file }));
    if (reason) {
      throw new Error(reason);
    }
    open = { file, db: openMemoryDb(file) };
  }
  return open.db;
}

export function closeDb() {
  if (open) {
    open.db.close();
    open = null;
  }
}

/** Whether memory can be used right now and, if not, why. Never throws. */
export function storeStatus() {
  try {
    getDb();
    return { ready: true, path: open.file };
  } catch (error) {
    return { ready: false, path: memoryDbPath(), reason: error.message };
  }
}

/** Runs `work` in one write transaction (BEGIN IMMEDIATE), rolling back on any error. */
export function inTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
