// Bridges the otherwise-invisible background capture (SessionEnd's detached
// worker has no attached stdout, PreCompact's confirmation only shows up if
// that exact session survives to see it) to the next SessionStart banner, so
// "auto-capture ran and saved N things" is never silent.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { STATE_DIR, ensureStateDir } from "./config.js";

function digestFile(project) {
  const key = createHash("sha256").update(project ?? "global").digest("hex").slice(0, 16);
  return path.join(STATE_DIR, `capture-digest-${key}.json`);
}

export function recordCapture(project, added) {
  if (!added) return;
  ensureStateDir();
  const file = digestFile(project);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // no digest yet
  }
  state.pending = (state.pending ?? 0) + added;
  state.lastCaptureAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(state));
}

/** Reads and clears any pending count - each SessionStart banner reports it once. */
export function consumeCaptureDigest(project) {
  const file = digestFile(project);
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!state.pending) return null;
    fs.writeFileSync(file, JSON.stringify({ pending: 0, lastCaptureAt: state.lastCaptureAt }));
    return { added: state.pending, lastCaptureAt: state.lastCaptureAt };
  } catch {
    return null;
  }
}
