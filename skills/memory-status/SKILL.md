---
name: memory-status
description: Report where memory is stored (the SQLite file), the active project scope, and entity/observation counts, or list every project in the store with its usage. Use when the user asks whether memory is working, where it is stored, how much has been remembered, what projects are stored, or how much each project takes.
---

Two questions land here. Pick the tool that matches which one was asked.

## "Is memory working / how much is stored for *this* project?"

Call the `memory_status` MCP tool and present the result: where memory is stored (the SQLite file), the active project scope, and the entity/observation counts.

## "What projects are in the database / how much is in each?"

Call the `memory_list_projects` MCP tool. It returns every project in the graph with its entity count, observation count, and last-activity timestamp — across all projects, not just the current one. Present it as a table sorted by last activity.

For a deeper report across every project in the store, run `npm run usage` from the plugin directory. On top of the same table it adds each project's first-seen date, observations in the last 7 days, database totals, and hygiene warnings: projects recorded under two different names (which silently splits one repo's memory in half), entities hoarding 100+ observations, and empty entity stubs. Use `--quiet` for just the table.


## "This project's subsystem tags are a mess / everything is untagged"

The SessionStart map and `npm run usage` both surface fragmentation — a junk-drawer
tag holding most of the graph, three-observation slivers that should be merged, or a
large `(untagged)` bucket. Every read tool returns each observation's `subsystem`, and
`memory_search` / `memory_recent` / `memory_timeline` accept `subsystem: "(untagged)"`
to enumerate the unclassified ones, so the diagnosis can be made in-session.

Acting on it is a maintenance script, not an MCP tool, because reclassification is an
LLM pass over every affected observation. The script is legacy and still works on the old
Neo4j graph only, not the SQLite store: `npm run backfill-subsystems` tags whatever
is currently untagged, and `--retag TAG` reclassifies observations already carrying a
tag (`--retag general` is how a junk drawer gets emptied). Both take `--dry-run` to
show the proposed tags without writing, and `--project NAME` to scope to one project.
Retagging edits observations in place — ids, timestamps and session links are
preserved — so it is safe to re-run and safe to interrupt.

## When things fail

If a tool call fails, run npm run health inside the plugin directory: it checks the launcher's Node, the store file, its schema and integrity, and prints PASS/FAIL per check.
