#!/usr/bin/env node
// Statistics for one project's memory: what it holds, how it grew week by week,
// and how it is shaped. Defaults to the project of the directory npm was run
// from, so `npm --prefix <plugin dir> run stats` works from any repo.
//   npm run stats [-- --project ID | --all]
import fs from "node:fs";
import { memoryDbPath } from "../src/lib/config.js";
import { detectProject } from "../src/lib/project.js";
import { openMemoryDb } from "../src/lib/sqliteDb.js";
import { buildStatsReport, renderStatsReport } from "../src/lib/statsReport.js";

const USAGE = "usage: memory-stats [--project ID | --all]";

function parseArgs(argv) {
  const flags = { project: undefined, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--all") {
      flags.all = true;
    } else if (argv[i] === "--project" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags.project = argv[++i];
    } else {
      return null;
    }
  }
  return flags.all && flags.project !== undefined ? null : flags;
}

const flags = parseArgs(process.argv.slice(2));
if (flags === null) {
  console.error(`${USAGE}   (got: ${process.argv.slice(2).join(" ")})`);
  process.exit(2);
}
const file = memoryDbPath();
if (!fs.existsSync(file)) {
  console.error(`memory-stats: no memory store at ${file}`);
  process.exit(1);
}
const project = flags.all ? null : (flags.project ?? detectProject(process.env.INIT_CWD ?? process.cwd()));
const db = openMemoryDb(file, { readOnly: true });
try {
  process.stdout.write(renderStatsReport(buildStatsReport(db, { project })));
} finally {
  db.close();
}
