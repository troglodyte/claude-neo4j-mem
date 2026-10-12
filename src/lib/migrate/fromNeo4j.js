// Opens the configured Neo4j graph read-only and hands `work` a reader.
// Shared by migrate-to-sqlite, the first-start worker and the catch-up.

export class Neo4jUnreachableError extends Error {
  constructor(message) {
    super(`Cannot reach Neo4j: ${message}`);
    this.name = "Neo4jUnreachableError";
  }
}

export async function withNeo4jReader(work) {
  const { default: neo4j } = await import("neo4j-driver");
  const { loadConnectionConfig } = await import("../config.js");
  const { getDriver, verifyConnectivity, closeDriver } = await import("../neo4jClient.js");
  const { readGraph } = await import("./readNeo4j.js");
  try {
    let config;
    try {
      config = loadConnectionConfig();
      await verifyConnectivity();
    } catch (error) {
      throw new Neo4jUnreachableError(error.message);
    }
    const readOnce = async () => {
      const session = getDriver().session({ database: config.database, defaultAccessMode: neo4j.session.READ });
      try {
        return await readGraph(session);
      } finally {
        await session.close();
      }
    };
    return await work(readOnce, config);
  } finally {
    await closeDriver();
  }
}

/** The migration into `out`, as migrate-to-sqlite runs it. Warnings and connection failures go to `warn` (stderr by default). */
export async function migrateFromNeo4j({ out, checkOnly = false, reportPath, log = console.log, warn = console.error }) {
  const { runMigration, EXIT } = await import("./runMigration.js");
  const { withoutCredentials } = await import("./cli.js");
  try {
    return await withNeo4jReader(async (readOnce, config) => {
      const source = withoutCredentials(config.uri);
      if (config.mode === "remote") {
        warn(`Warning: the source is a remote graph (${source}); the SQLite file serves this machine only.`);
      }
      const result = await runMigration({ readOnce, out, checkOnly, reportPath, sourceLabel: `${source} (${config.mode})`, log });
      // Could-not-run without validation problems is a read or write that may work next time.
      return { exitCode: result.exitCode, transient: result.exitCode === EXIT.COULD_NOT_RUN && !result.problems };
    });
  } catch (error) {
    if (error instanceof Neo4jUnreachableError) {
      warn(error.message);
      return { exitCode: EXIT.COULD_NOT_RUN, transient: true };
    }
    throw error;
  }
}
