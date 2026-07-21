---
name: memory-status
description: Report the Neo4j memory backend's connection mode (local Docker vs remote), active project scope, and entity/observation counts, or list every project registered in the database with its usage. Use when the user asks whether memory is working, which database it's using, how much has been remembered, what projects are stored in the graph, or how much space/usage each project takes.
---

Two questions land here. Pick the tool that matches which one was asked.

## "Is memory working / how much is stored for *this* project?"

Call the `memory_status` MCP tool and present the result: connection URI, whether it's running in local or remote mode, the active project scope, and the entity/observation counts.

## "What projects are in the database / how much is in each?"

Call the `memory_list_projects` MCP tool. It returns every project in the graph with its entity count, observation count, and last-activity timestamp — across all projects, not just the current one. Present it as a table sorted by last activity.

For a deeper report, run `scripts/memory-usage.sh` from the plugin directory. On top of the same table it adds each project's first-seen date, observations in the last 7 days, database totals, and hygiene warnings: projects recorded under two different names (which silently splits one repo's memory in half), entities hoarding 100+ observations, and empty entity stubs. Use `--quiet` for just the table.

Do not write ad-hoc Cypher for these questions when the tools above answer them.

## Running arbitrary Cypher

If the user genuinely needs a query the tools do not cover, use `scripts/cypher.sh "<query>"`. It resolves credentials automatically and, in local mode, borrows the `cypher-shell` binary from inside the Neo4j container — so **nothing needs to be installed**. It only asks the user to install `cypher-shell` when connecting to a remote database from a host that lacks it, and even then the `memory_*` tools and `npm run memory -- <cmd>` keep working without it. Never tell the user they must install cypher-shell before checking that fallback.

## When things fail

If a tool call fails, explain that the Neo4j memory backend is unreachable and point to the plugin's setup: run `npm run configure` inside the plugin directory, and for local mode make sure `docker compose up -d` (in `docker/`) is running. `scripts/check-health.sh` diagnoses the whole stack and prints PASS/FAIL per check.
