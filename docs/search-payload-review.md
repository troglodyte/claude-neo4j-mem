# Reviewing the `memory_search` payload

`memory_search` costs about 2.9k tokens a call. Whether to make it smaller
(fewer observations per entity, fewer entities) is a recall-versus-tokens
trade, and the first review said not to yet. This page is how to recheck.

## Run it

```
npm run search-review              # replay + follow-ups
npm run search-review -- --followups   # telemetry only, no Neo4j needed
```

Read-only. Part 1 replays every logged search against the live graph. Part 2
reads `~/.claude-neo4j/telemetry.jsonl`, where `memory_search` entries carry
`shown` (entity names, rank order) and `memory_get_entity` entries carry
`entity`, and ranks each lookup against the search before it.

## Baseline: 2026-10-07 (192 searches, after the relation cap)

| measure | value |
| --- | --- |
| average result | 11,624 chars (~2.9k tokens), 9.7 entities |
| chars by entity rank 1-3 / 4-6 / 7-10 | 31% / 30% / 39% |
| observations containing a query word | 75% (63% for the 3rd-5th) |
| ranks 2+ scoring ≥70% / 50-70% / <50% of the top | 545 / 559 / 568 |
| compact result (2 observations, 3 relations) would save | 45% |
| follow-up lookups | no data yet: `shown` and `entity` are new |

Measured against 198 logged searches on the same day, the relation cap saved
29% and left every entity and observation unchanged.

## What the baseline said

Trimming further was not worth it. Scores are flat (no relevance cliff for a
cut to follow), most of what a compact result would drop still contains a query
word, and a compact result trades characters for extra `memory_get_entity`
round trips. Search costs a few thousand tokens a day against contexts of 100k+.

## When to change the defaults

Judge only once there are at least ~30 searches with a `shown` list and ~20
follow-ups; the script says so when it is too early.

| if the follow-ups show | then |
| --- | --- |
| 80%+ name an entity ranked 1-3 | cut entities to the top 5 (default `limit`): ranks 4-10 are rarely read |
| most name an entity ranked 4-10 | leave it; the deep results are being used |
| many are "not shown" | Claude is following relations the cap cut, or searching again by name; raise `CLAUDE_NEO4J_SEARCH_RELATIONS_CAP` |
| fewer than ~15% of searches have a follow-up | a compact result's extra round trips would be cheap, so compact observations (2 per entity) is worth trying |
| the first row is not met and the third is | do nothing |

Before shipping a cut, replay it: the script's part 1 prints the saving, and
the observations-containing-a-query-word figure says how much relevant-looking
text it would remove. A cut that removes mostly matching text needs a stronger
reason than "fewer tokens".

## Rerun about every month, or sooner after

- changing the search query or the budgets in `src/lib/budget.js`,
- a large import or backfill (observation length changes the cost),
- a team member reporting that memory missed something it should have known.
