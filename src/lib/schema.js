import { withSession } from "./neo4jClient.js";

const STATEMENTS = [
  // Entity identity is (name, project), not name alone - a bare name-unique
  // constraint let two different projects collide on the same entity node
  // (e.g. both writing "user"), silently merging/overwriting each other's
  // facts. Composite uniqueness constraints work fine on Community Edition
  // (verified against neo4j:5-community); only NODE KEY needs Enterprise.
  "DROP CONSTRAINT entity_name_unique IF EXISTS",
  "CREATE CONSTRAINT entity_name_project_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.name, e.project) IS UNIQUE",
  "CREATE CONSTRAINT session_id_unique IF NOT EXISTS FOR (s:Session) REQUIRE s.id IS UNIQUE",
  "CREATE CONSTRAINT observation_id_unique IF NOT EXISTS FOR (o:Observation) REQUIRE o.id IS UNIQUE",
  "CREATE FULLTEXT INDEX entityNameFulltext IF NOT EXISTS FOR (e:Entity) ON EACH [e.name]",
  "CREATE FULLTEXT INDEX observationTextFulltext IF NOT EXISTS FOR (o:Observation) ON EACH [o.text]",
];

let ensured = false;

/** Idempotent; safe to call on every hook/MCP invocation. Cached per-process. */
export async function ensureSchema() {
  if (ensured) return;
  await withSession(async (session) => {
    for (const statement of STATEMENTS) {
      await session.run(statement);
    }
  });
  ensured = true;
}
