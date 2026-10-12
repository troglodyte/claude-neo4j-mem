import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRehearsalTarget } from "./helpers/rehearsalGuard.js";

test("an empty target, or one holding only the fixture's projects, may be wiped", () => {
  assert.doesNotThrow(() => assertRehearsalTarget(0));
});

test("a target holding entities from other projects is refused", () => {
  assert.throws(() => assertRehearsalTarget(3), /refusing to wipe.*3 entities/);
});
