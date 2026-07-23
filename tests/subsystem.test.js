import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSubsystem,
  resolveSubsystem,
  isCatchAllTag,
  filterVocabulary,
  UNTAGGED,
} from "../src/lib/subsystem.js";

test("normalizeSubsystem slugifies to lowercase kebab-case", () => {
  assert.equal(normalizeSubsystem("Auto Capture"), "auto-capture");
  assert.equal(normalizeSubsystem("  MCP_Server  "), "mcp-server");
  assert.equal(normalizeSubsystem("backup/restore"), "backup-restore");
});

test("normalizeSubsystem rejects anything that isn't a usable tag", () => {
  assert.equal(normalizeSubsystem(""), null);
  assert.equal(normalizeSubsystem("   "), null);
  assert.equal(normalizeSubsystem("---"), null);
  assert.equal(normalizeSubsystem(null), null);
  assert.equal(normalizeSubsystem(undefined), null);
  assert.equal(normalizeSubsystem(42), null);
});

test("resolveSubsystem snaps lexical drift onto an existing tag", () => {
  assert.equal(resolveSubsystem("captures", ["capture", "search"]), "capture");
  assert.equal(resolveSubsystem("Backup", ["backup"]), "backup");
  assert.equal(resolveSubsystem("capture-hooks", ["capture-hook"]), "capture-hook");
});

test("resolveSubsystem keeps a genuinely new tag", () => {
  assert.equal(resolveSubsystem("marketplace", ["capture", "search"]), "marketplace");
  assert.equal(resolveSubsystem("backup", []), "backup");
});

test("UNTAGGED is a value no real slug can collide with", () => {
  assert.equal(normalizeSubsystem(UNTAGGED), "untagged");
  assert.notEqual(UNTAGGED, "untagged");
});

test("isCatchAllTag spots junk-drawer names however they're written", () => {
  assert.equal(isCatchAllTag("general"), true);
  assert.equal(isCatchAllTag("General"), true);
  assert.equal(isCatchAllTag("  MISC  "), true);
  assert.equal(isCatchAllTag("N/A"), true);
  assert.equal(isCatchAllTag("uncategorised"), true);
  assert.equal(isCatchAllTag(UNTAGGED), true);
});

test("isCatchAllTag leaves real subsystems alone", () => {
  assert.equal(isCatchAllTag("auto-capture"), false);
  assert.equal(isCatchAllTag("general-ledger"), false);
  assert.equal(isCatchAllTag("othello"), false);
  assert.equal(isCatchAllTag(""), false);
  assert.equal(isCatchAllTag(null), false);
});

// A catch-all and an omitted field mean the same thing, so they must produce the
// same stored value - otherwise "no subsystem" has two representations and the
// injection map grows a row that can't narrow a search.
test("resolveSubsystem folds a catch-all to null, like an omitted tag", () => {
  assert.equal(resolveSubsystem("general", ["capture", "search"]), null);
  assert.equal(resolveSubsystem("Misc", []), null);
  assert.equal(resolveSubsystem(undefined, ["capture"]), null);
});

test("resolveSubsystem never snaps a real tag onto a catch-all in the vocabulary", () => {
  // "generals" is one edit from "general"; without filtering the vocabulary the
  // deduper would happily canonicalise onto the junk drawer and grow it.
  assert.equal(resolveSubsystem("generals", ["general", "search"]), "generals");
});

test("filterVocabulary strips catch-alls before a prompt ever sees them", () => {
  assert.deepEqual(filterVocabulary(["capture", "general", "search", "misc"]), ["capture", "search"]);
  assert.deepEqual(filterVocabulary([]), []);
  assert.deepEqual(filterVocabulary(["capture"]), ["capture"]);
});
