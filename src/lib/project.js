import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Scopes memory to a project so recall from an unrelated repo doesn't leak in.
 * Prefers the git remote (stable across clones/machines) over the cwd basename.
 */
export function detectProject(cwd = process.cwd()) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (remote) return normalizeRemote(remote);
  } catch {
    // not a git repo, or no "origin" remote
  }
  return path.basename(cwd);
}

function normalizeRemote(remote) {
  return remote
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\.git$/, "");
}
