import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSubsystem, resolveSubsystem, UNTAGGED } from "../src/lib/subsystem.js";

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
