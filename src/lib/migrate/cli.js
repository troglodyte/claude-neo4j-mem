import path from "node:path";

export const USAGE = "usage: migrate-to-sqlite [--out PATH] [--check-only] [--report PATH]";

/**
 * The command's flags. Relative paths resolve against `cwd`, which the script
 * sets to INIT_CWD under `npm run`: npm runs scripts from the plugin directory,
 * a git working tree where a stray copy of every project's memory could be
 * committed, not from where the user typed the command.
 */
export function parseArgs(argv, { cwd, defaultOut }) {
  const flags = { out: defaultOut, checkOnly: false, report: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) {
      flags.out = path.resolve(cwd, argv[++i]);
    } else if (arg === "--report" && argv[i + 1]) {
      flags.report = path.resolve(cwd, argv[++i]);
    } else if (arg === "--check-only") {
      flags.checkOnly = true;
    } else {
      return { error: `Unknown or incomplete argument: ${arg}\n${USAGE}` };
    }
  }
  return { flags };
}

/** A connection URI without any `user:password@` part, safe to print and to store in the run log. */
export function withoutCredentials(uri) {
  return uri.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
}
