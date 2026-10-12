import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectProject } from "../src/lib/project.js";

// Throwaway repos need real commits for `git worktree add`. Hooks and signing are
// switched off per command so a developer's global git config cannot interfere.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "f.txt"), "x");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("detectProject", () => {
  let tmp;
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-test-")));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("uses the normalised origin remote when there is one", () => {
    const repo = makeRepo(path.join(tmp, "with-remote"));
    git(repo, "remote", "add", "origin", "git@github.com:acme/widgets.git");
    assert.equal(detectProject(repo), "github.com/acme/widgets");
  });

  test("a worktree of a repo with a remote resolves to the same project as the main checkout", () => {
    const repo = makeRepo(path.join(tmp, "remote-main"));
    git(repo, "remote", "add", "origin", "https://bitbucket.org/acme/gadgets.git");
    const wt = path.join(tmp, "remote-wt");
    git(repo, "worktree", "add", "-q", "-b", "feat/x", wt);
    assert.equal(detectProject(wt), detectProject(repo));
    assert.equal(detectProject(wt), "bitbucket.org/acme/gadgets");
  });

  test("a remote-less repo falls back to its directory name", () => {
    const repo = makeRepo(path.join(tmp, "solo"));
    assert.equal(detectProject(repo), "solo");
  });

  test("a worktree of a remote-less repo shares the main checkout's project, not its own name", () => {
    const repo = makeRepo(path.join(tmp, "synclync"));
    const wt = path.join(repo, ".claude", "worktrees", "trusting-lewin-decd9d");
    git(repo, "worktree", "add", "-q", "-b", "claude/trusting-lewin", wt);
    assert.equal(detectProject(wt), "synclync");
    assert.equal(detectProject(wt), detectProject(repo));
  });

  test("a subdirectory of a remote-less worktree still resolves to the main checkout", () => {
    const repo = makeRepo(path.join(tmp, "nested"));
    const wt = path.join(tmp, "nested-wt");
    git(repo, "worktree", "add", "-q", "-b", "feat/n", wt);
    fs.mkdirSync(path.join(wt, "pkg"));
    assert.equal(detectProject(path.join(wt, "pkg")), "nested");
  });

  test("a directory outside any repo falls back to its name", () => {
    const dir = path.join(tmp, "not-a-repo");
    fs.mkdirSync(dir);
    assert.equal(detectProject(dir), "not-a-repo");
  });
});
