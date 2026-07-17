import neo4j from "neo4j-driver";
import { loadConnectionConfig } from "./config.js";

let driver;

export function getDriver() {
  if (!driver) {
    const { uri, username, password } = loadConnectionConfig();
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
      maxConnectionLifetime: 3 * 60 * 60 * 1000,
      connectionTimeout: 10 * 1000,
    });
  }
  return driver;
}

export async function withSession(work) {
  const { database } = loadConnectionConfig();
  const session = getDriver().session({ database });
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

export async function verifyConnectivity() {
  const { database } = loadConnectionConfig();
  await getDriver().verifyConnectivity({ database });
}

export async function closeDriver() {
  if (driver) {
    await driver.close();
    driver = undefined;
  }
}

export const int = neo4j.int;
