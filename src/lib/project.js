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
    if (remote) {
      return normalizeRemote(remote);
    }
  } catch {
    // not a git repo, or no "origin" remote
  }
  return mainCheckoutName(cwd) ?? path.basename(cwd);
}

/**
 * Name of the main checkout's directory, for repos with no origin remote. Without this a
 * worktree (or a subdirectory) names its own project after itself and recalls from an
 * empty graph. Null when cwd is not in a repo or the repo is bare (no ".git" directory).
 */
function mainCheckoutName(cwd) {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const gitDir = path.resolve(cwd, common);
    return path.basename(gitDir) === ".git" ? path.basename(path.dirname(gitDir)) : null;
  } catch {
    return null;
  }
}

function normalizeRemote(remote) {
  return remote
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\.git$/, "");
}
