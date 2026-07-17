import { withSession } from "./neo4jClient.js";

const STATEMENTS = [
  "CREATE CONSTRAINT entity_name_unique IF NOT EXISTS FOR (e:Entity) REQUIRE e.name IS UNIQUE",
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
