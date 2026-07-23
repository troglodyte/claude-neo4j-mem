# Cypher cheatsheet

`scripts/cypher.sh "<query>"` runs arbitrary Cypher with no setup. It resolves
credentials from `$NEO4J_*`, then `~/.claude-neo4j/config.json`, then
`docker/.env`, and picks a `cypher-shell` binary automatically — preferring one
on your `PATH` but otherwise **borrowing the copy inside the Neo4j container**,
so local-mode users never have to install anything. It takes a query as an
argument or on stdin:

```bash
scripts/cypher.sh "MATCH (e:Entity) RETURN count(e);"
echo "MATCH (o:Observation) RETURN count(o);" | scripts/cypher.sh
```

Only a remote database (Aura) on a host without `cypher-shell` needs a real
install; the script prints platform-specific instructions if you hit that. The
`memory_*` MCP tools and `npm run memory -- <cmd>` talk to Neo4j over Bolt via
the driver library and never require `cypher-shell` at all.

Everything below also works pasted into the Neo4j Browser at
`http://localhost:7474`, and follows the graph model documented in the
[README](../README.md#graph-model).

```cypher
// List every project tracked in the db, with entity/observation counts and
// last activity (same data as `npm run memory -- projects` / memory_list_projects)
MATCH (e:Entity) WHERE e.project IS NOT NULL
OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
RETURN e.project AS project, count(DISTINCT e) AS entities, count(o) AS observations,
       max(o.createdAt) AS lastActivity
ORDER BY lastActivity DESC;

// All entities for one project, with observation counts
MATCH (e:Entity {project: "github.com/you/your-repo"})
OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
RETURN e.name, e.type, count(o) AS observations
ORDER BY observations DESC;

// Full detail for one entity: every observation + every relation in/out
MATCH (e:Entity {name: "user"})
OPTIONAL MATCH (o:Observation)-[:ABOUT]->(e)
OPTIONAL MATCH (e)-[r:RELATES_TO]-(other)
RETURN e, collect(DISTINCT o) AS observations, collect(DISTINCT {type: r.type, entity: other.name}) AS relations;

// Most recently created observations across all projects (recent activity feed)
MATCH (o:Observation)-[:ABOUT]->(e:Entity)
RETURN o.createdAt AS createdAt, e.project AS project, e.name AS entity, o.text AS text
ORDER BY o.createdAt DESC
LIMIT 25;

// Observation counts per subsystem for one project — the same breakdown the
// SessionStart injection renders as its index
MATCH (o:Observation)-[:ABOUT]->(e:Entity {project: "github.com/you/your-repo"})
WHERE o.subsystem IS NOT NULL
RETURN o.subsystem AS subsystem, count(o) AS observations
ORDER BY observations DESC;

// Untagged observations (candidates for `npm run backfill-subsystems`)
MATCH (o:Observation)-[:ABOUT]->(e:Entity)
WHERE o.subsystem IS NULL
RETURN e.project, count(o) AS untagged
ORDER BY untagged DESC;

// Whole relationship graph for one project (visualize in Neo4j Browser)
MATCH (e:Entity {project: "github.com/you/your-repo"})
OPTIONAL MATCH (e)-[r:RELATES_TO]-(other)
RETURN e, r, other;

// Sessions and how many observations each one produced
MATCH (s:Session)
OPTIONAL MATCH (s)-[:PRODUCED]->(o:Observation)
RETURN s.id, s.project, s.startedAt, count(o) AS observationsProduced
ORDER BY s.startedAt DESC;

// Possible near-duplicate entity names within a project (eyeball before merging —
// see `src/lib/dedup.js` for the automated version applied at write time)
MATCH (a:Entity), (b:Entity)
WHERE a.project = b.project AND a.name < b.name
  AND (toLower(a.name) CONTAINS toLower(b.name) OR toLower(b.name) CONTAINS toLower(a.name))
RETURN a.project, a.name, b.name;

// Orphan entities with zero observations (candidates for cleanup)
MATCH (e:Entity) WHERE NOT (e)<-[:ABOUT]-(:Observation)
RETURN e.project, e.name, e.type;

// Manually merge two duplicate entities (rewire b's observations/relations onto a, delete b)
// Run only after confirming they really are the same thing.
MATCH (a:Entity {project: "github.com/you/your-repo", name: "canonical-name"})
MATCH (b:Entity {project: "github.com/you/your-repo", name: "duplicate-name"})
MATCH (b)<-[:ABOUT]-(o:Observation)
MERGE (o)-[:ABOUT]->(a)
WITH a, b
DETACH DELETE b;
```
