#!/usr/bin/env node
// Interactive setup wizard. Meant to be run by hand in a terminal (never by Claude) since
// it collects a database password. Supports non-interactive use via --flags for scripting/CI.
import neo4j from "neo4j-driver";
import { writeConfigFile, CONFIG_FILE } from "../src/lib/config.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function prompt(question, { mask = false, flag } = {}) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error(
          `Not running in a terminal, so this can't be prompted for interactively. Pass --${flag} explicitly, or run in a real terminal. ` +
            `Full non-interactive example: node scripts/configure.mjs --mode local --uri bolt://localhost:7687 --username neo4j --password '...' --database neo4j`
        )
      );
      return;
    }
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let answer = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(answer);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(1);
        }
        if (char === "\u007f" || char === "\b") {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        answer += char;
        process.stdout.write(mask ? "*" : char);
      }
    };
    stdin.on("data", onData);
  });
}

async function testConnection({ uri, username, password, database }) {
  const driver = neo4j.driver(uri, neo4j.auth.basic(username, password), { connectionTimeout: 8000 });
  try {
    await driver.verifyConnectivity({ database });
  } finally {
    await driver.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("claude-neo4j memory setup\n");

  let mode = args.mode;
  if (!mode) {
    const answer = await prompt("Use (l)ocal Docker Neo4j or (r)emote/hosted Neo4j (e.g. Aura)? [l/r]: ", {
      flag: "mode local|remote",
    });
    mode = answer.toLowerCase().startsWith("r") ? "remote" : "local";
  }

  const defaultUri = mode === "local" ? "bolt://localhost:7687" : "";
  const uriAnswer =
    args.uri ??
    (await prompt(`Neo4j URI${mode === "local" ? " [bolt://localhost:7687]" : " (e.g. neo4j+s://xxxxx.databases.neo4j.io)"}: `, {
      flag: "uri <uri>",
    }));
  const uri = uriAnswer || defaultUri;
  if (!uri) {
    console.error("\nA URI is required.");
    process.exit(1);
  }
  const usernameAnswer = args.username ?? (await prompt("Username [neo4j]: ", { flag: "username <username>" }));
  const username = usernameAnswer || "neo4j";
  const password = args.password ?? (await prompt("Password: ", { mask: true, flag: "password <password>" }));
  const databaseAnswer = args.database ?? (await prompt("Database [neo4j]: ", { flag: "database <database>" }));
  const database = databaseAnswer || "neo4j";

  if (!password) {
    console.error("\nNo password given, aborting.");
    process.exit(1);
  }

  console.log("\nTesting connection...");
  try {
    await testConnection({ uri, username, password, database });
    console.log("Connected successfully.");
  } catch (error) {
    console.error(`Could not connect: ${error.message}`);
    if (!args.force) {
      console.error("Run again with --force to save this config anyway.");
      process.exit(1);
    }
  }

  writeConfigFile({ mode, uri, username, password, database });
  console.log(`\nSaved to ${CONFIG_FILE} (mode: ${mode})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
