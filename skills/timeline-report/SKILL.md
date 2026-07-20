---
name: timeline-report
description: Generate a narrative report of a project's development history from the Neo4j memory graph's chronological observation timeline. Use when asked for a timeline report, project history/journey narrative, or a digest of what's happened on this project.
---

Use the `memory_timeline` MCP tool to fetch the project's observation history in chronological order (oldest first). Pass `since` (ISO date) if the user asked for a specific window, e.g. "this week" or "since last month"; otherwise omit it for the full history.

If the result is empty, say plainly that there's no recorded memory history for this project yet — don't fabricate one.

Otherwise, turn the flat observation list into a narrative report:

1. Group observations by day (or by week, if the range spans more than ~3 weeks) using their `createdAt` timestamps.
2. Within each group, write a short prose paragraph — not a bullet dump of raw observation text — synthesizing what happened, decided, or was learned, referencing the entities involved.
3. Order chronologically, oldest first, so the report reads as a journey through the project's history.
4. Close with a brief "current state" summary drawn from the most recent entries.

If the timeline is very large (call `memory_status` first if unsure — hundreds of observations), split the work into batches by day/week rather than holding everything in context at once, and stitch the per-batch summaries together in order.

Keep the tone factual and grounded in the observation text; don't invent details the memory doesn't contain.
