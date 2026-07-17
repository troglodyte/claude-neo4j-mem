---
name: memory-status
description: Report the Neo4j memory backend's connection mode (local Docker vs remote), active project scope, and entity/observation counts. Use when the user asks whether memory is working, which database it's using, or how much has been remembered.
---

Call the `memory_status` MCP tool and present the result: connection URI, whether it's running in local or remote mode, the active project scope, and the entity/observation counts.

If the tool call fails, explain that the Neo4j memory backend is unreachable and point to the plugin's setup: run `npm run configure` inside the plugin directory, and for local mode make sure `docker compose up -d` (in `docker/`) is running.
