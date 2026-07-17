---
name: memory-search
description: Search the Neo4j memory graph for facts, decisions, or context saved from past sessions. Use when the user asks what you remember about something, references a past conversation, or when prior context might exist worth checking before starting new work.
---

Use the `memory_search` MCP tool with the user's query (or `$ARGUMENTS` if given directly) to search the memory graph. If a specific entity name comes back, follow up with `memory_get_entity` to pull its full observation history and relations before answering.

Present findings concisely: group by entity, cite only the observations relevant to the question. If nothing relevant is found, say so plainly rather than fabricating context.
