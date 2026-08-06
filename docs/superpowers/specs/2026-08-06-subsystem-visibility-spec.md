# Spec: expose `subsystem` on read paths, and make `(untagged)` queryable

**Component:** `claude-neo4j-memory` (plugin `neo4j-memory@claude-neo4j-local`)
**Version observed:** 0.5.0 (cache also holds 0.3.1, 0.4.0, 0.4.1, 0.4.2)
**Reported from:** project `bitbucket.org/jhtna/jump-authorization-server` — 112 entities, 387 observations
**Priority:** low/medium — no data at risk; this is an observability and API-consistency gap

---

## Not the problem

To be clear up front, since it's the obvious thing to assume: **in-place retagging already works
correctly.** `scripts/backfill-subsystems.mjs` matches by observation `id` and does
`SET o.subsystem = row.subsystem`, preserving `id`, `createdAt`, and `sessionId`. `--retag TAG`,
`--dry-run`, `--project`, per-batch resumability, and `resolveSubsystem` folding catch-alls to
`null` are all present and well-commented. Nothing below asks for that to change.

The gaps are that an agent **cannot see or audit tags through the MCP surface**, and that the
SessionStart map advertises a bucket the API rejects.

---

## Gap 1 — no read path ever returns `subsystem`

`subsystem` appears in `src/mcp/server.js` only as an *input* filter (lines 46, 107, 168) and as a
*write* field (lines 68–77). No tool returns it. `memory_get_entity`, `memory_search`, and
`memory_recent` all emit observations as `{id, text, createdAt}` with the tag omitted.

**Consequence:** tagging is write-only from the agent's perspective. To answer "what subsystem is
this observation in?" the only method is to call a read once per candidate tag and diff the
result sets. I established that tags are per-observation rather than per-entity precisely this
way — `decision:agreement-service-as-64-sync-design` returns 3 observations unfiltered and 2 under
`subsystem: infrastructure`, so the missing one must be tagged otherwise. That inference should
not require N calls and a set difference.

It also makes the hygiene problem invisible in-session. This project reads
`infrastructure 133 / untagged 139` out of ~341 mapped observations: 80% of the graph in two
buckets that don't discriminate, while `oauth` holds 8 observations in an OAuth authorization
server. An agent cannot spot that from any read result — only from the SessionStart summary.

**Ask:** include `subsystem` (nullable) in the observation objects returned by
`memory_get_entity`, `memory_search`, and `memory_recent`. Additive and backward-compatible.

## Gap 2 — `(untagged)` is advertised but not queryable

The SessionStart map renders `(untagged)` as a row beside real tags, e.g.:

```
api (29, 08-04) · infrastructure (133, 08-04) · (untagged) (139, 08-04) · oauth (8, 08-03) · …
```

with the instruction `memory_search(subsystem: …) to read`. Passing that value returns nothing:

- `memory_recent(subsystem: "untagged")` → `[]`
- `memory_timeline(subsystem: "untagged")` → `{events: [], total: 0}`

**Root cause:** the map builder coalesces for display — `graph.js:88`,
`coalesce(o.subsystem, $untagged) AS subsystem` — but every filter compares literally:
`graph.js:223, 305, 417, 427`, `WHERE $subsystem IS NULL OR o.subsystem = $subsystem`. Untagged
rows have `o.subsystem IS NULL`, so no string can ever match them. The label is display-only and
the map presents it as if it round-trips.

**Ask (either is fine):**
- accept a reserved sentinel — `subsystem: "(untagged)"` (or `"untagged"`) → `o.subsystem IS NULL`; or
- drop `(untagged)` from the map's tag list and report it as a separate count, so it reads as a
  statistic rather than a selector.

The first is more useful: 139 observations here are reachable only by full-text search or a full
chronological walk, and a sentinel makes them enumerable.

## Gap 3 (minor) — retag is CLI-only and undiscoverable

`--retag` lives in a maintenance script. An agent that has just diagnosed a junk-drawer tag in
conversation cannot act on it through any tool, and nothing in the tool descriptions or the
`memory-status` / `memory-search` skills mentions the script exists. I concluded in-session that
no retag capability existed at all, and only found it by grepping the plugin source.

**Ask:** mention `npm run backfill-subsystems` (with `--dry-run` and `--retag`) in the
`memory-status` skill or the `memory_add_observations` tool description. Exposing it as an MCP tool
would be nice but is not required — it's a maintenance operation and an LLM-classification job.

---

## Acceptance criteria

1. `memory_get_entity`, `memory_search`, `memory_recent` each return `subsystem` per observation,
   `null` for cross-cutting facts.
2. Untagged observations are enumerable through one documented call, **or** `(untagged)` no longer
   appears in the map's selector list.
3. A round-trip holds: any tag string shown in the SessionStart map, passed back as `subsystem`,
   returns a non-empty result whenever its count is non-zero.
4. Retag tooling is discoverable from the MCP surface or skill docs without reading plugin source.

## Notes for triage

Criterion 3 is the general form of Gap 2 and is worth a regression test — the map is generated by
one code path and consumed by another, and nothing currently asserts they agree on a vocabulary.
