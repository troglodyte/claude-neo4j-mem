---
name: timeline-report
description: Generate a narrative report of a project's development history from the Neo4j memory graph's chronological observation timeline. Use when asked for a timeline report, project history/journey narrative, or a digest of what's happened on this project.
---

Use the `memory_timeline` MCP tool to fetch the project's observation history in chronological order (oldest first). Pass `since` (ISO date) if the user asked for a specific window, e.g. "this week" or "since last month"; otherwise omit it for a first look at the full history.

It returns `{events, total, returned, truncated}`. Each entry's text is abridged to its opening ~200 characters — enough to summarize from, which is all this report needs.

If the result is empty, say plainly that there's no recorded memory history for this project yet — don't fabricate one.

Otherwise, turn the flat observation list into a narrative report:

1. Group observations by day (or by week, if the range spans more than ~3 weeks) using their `createdAt` timestamps.
2. Within each group, write a short prose paragraph — not a bullet dump of raw observation text — synthesizing what happened, decided, or was learned, referencing the entities involved.
3. Order chronologically, oldest first, so the report reads as a journey through the project's history.
4. Close with a brief "current state" summary drawn from the most recent entries.

**When `truncated` is true, walk the history in date windows — never raise `limit` to swallow it whole.** `returned` and `total` tell you how much you're missing. Issue successive calls with `since` set to just after the last event you received (and stop once you reach the present), summarizing each window into prose before fetching the next so only the summaries accumulate in context. Raising `limit` instead pulls the entire history into a single response, which on a mature project runs to tens of thousands of tokens — the report is a synthesis, so it never needs the raw history resident all at once.

State plainly in the report if you summarized only part of the history and say which window it covers.

Keep the tone factual and grounded in the observation text; don't invent details the memory doesn't contain.
