import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, canonicalRow, keyOf, readConsistentGraph } from "../src/lib/migrate/fingerprint.js";
import { fixtureRecords } from "./helpers/graphFixture.js";

test("the same records in another order have the same fingerprint", () => {
  const reversed = fixtureRecords();
  for (const rows of Object.values(reversed)) {
    rows.reverse();
  }
  assert.deepEqual(fingerprint(reversed), fingerprint(fixtureRecords()));
});

test("one changed character in one observation changes the fingerprint", () => {
  const changed = fixtureRecords();
  changed.observations[0].text = changed.observations[0].text.replace("two", "twO");
  assert.notEqual(fingerprint(changed).hashes.observations, fingerprint(fixtureRecords()).hashes.observations);
});

test("seq orders rows but is not compared", () => {
  const reordered = fixtureRecords();
  reordered.observations[0].seq = 999;
  assert.deepEqual(fingerprint(reordered), fingerprint(fixtureRecords()));
});

test("null and the empty string are different values", () => {
  const entity = fixtureRecords().entities[1];
  assert.notEqual(canonicalRow("entities", entity), canonicalRow("entities", { ...entity, type: "" }));
});

test("text with an unpaired surrogate compares as its well-formed form", () => {
  const observation = { ...fixtureRecords().observations[0], text: "cut through an emoji \uD83D" };
  assert.equal(
    canonicalRow("observations", observation),
    canonicalRow("observations", { ...observation, text: "cut through an emoji \uFFFD" })
  );
});

test("keys ignore fields that are not part of the key", () => {
  const entity = fixtureRecords().entities[0];
  assert.equal(keyOf("entities", entity), keyOf("entities", { ...entity, type: "changed" }));
});

test("two matching reads return the second one", async () => {
  let reads = 0;
  const result = await readConsistentGraph(async () => {
    reads++;
    return fixtureRecords();
  });
  assert.equal(result.consistent, true);
  assert.equal(result.reads, 2);
  assert.equal(reads, 2);
});

test("a graph that changes between reads is read again until it holds still", async () => {
  let reads = 0;
  const result = await readConsistentGraph(async () => {
    reads++;
    const records = fixtureRecords();
    // The first two reads each see a different extra observation; then the graph is still.
    if (reads <= 2) {
      records.observations.push({ ...records.observations[0], id: `late-${reads}` });
    }
    return records;
  });
  assert.equal(result.consistent, true);
  assert.equal(result.reads, 4);
});

test("a graph that never holds still gives up after five comparisons", async () => {
  let reads = 0;
  const result = await readConsistentGraph(async () => {
    reads++;
    const records = fixtureRecords();
    records.observations.push({ ...records.observations[0], id: `late-${reads}` });
    return records;
  });
  assert.equal(result.consistent, false);
  assert.equal(result.records, null);
  assert.equal(reads, 6);
});
