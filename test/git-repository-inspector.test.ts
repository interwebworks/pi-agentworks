import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { assessBranchProtection } from "../src/domain/branch-protection.ts";
import {
  GitCliRepositoryInspector,
  GitRepositoryInspectionError,
} from "../src/infrastructure/git/git-cli-repository-inspector.ts";

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  }).trim();
}

function createRepository(
  root: string,
  name = "repository",
  branch = "main",
): string {
  const repository = join(root, name);
  execFileSync("git", ["init", "--initial-branch", branch, repository], {
    stdio: "ignore",
  });
  git(repository, "config", "user.name", "Agentworks Test");
  git(repository, "config", "user.email", "agentworks@example.test");
  execFileSync("node", [
    "-e",
    "require('fs').writeFileSync(process.argv[1], 'initial\\n')",
    join(repository, "README.md"),
  ]);
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "Initial commit");
  return repository;
}

test("inspects canonical repository identity and conventional default branch offline", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-git-inspect-"));
  try {
    const repository = createRepository(root, "repository", "trunk");
    git(repository, "branch", "feature/example");
    const inspector = new GitCliRepositoryInspector();
    const inspection = inspector.inspect(join(repository, "."));

    assert.equal(inspection.repositoryRoot, repository);
    assert.equal(inspection.bare, false);
    assert.equal(inspection.currentBranch, "trunk");
    assert.match(inspection.headCommit ?? "", /^[0-9a-f]{40}$/u);
    assert.deepEqual(inspection.localBranches, ["feature/example", "trunk"]);
    assert.equal(inspection.defaultBranch, "trunk");
    assert.equal(inspection.defaultBranchSource, "conventional-local-branch");
    assert.equal(["sha1", "sha256"].includes(inspection.objectFormat), true);
    inspector.assertBranchExists(inspection, "feature/example");
    assert.throws(
      () => inspector.assertBranchExists(inspection, "missing"),
      GitRepositoryInspectionError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote HEAD takes precedence and credentials are removed from remote URLs", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-git-inspect-"));
  try {
    const repository = createRepository(root);
    git(
      repository,
      "remote",
      "add",
      "origin",
      "https://secret-token@example.com/organization/repository.git",
    );
    git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(
      repository,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );

    const inspection = new GitCliRepositoryInspector().inspect(repository);
    assert.equal(inspection.defaultBranch, "main");
    assert.equal(inspection.defaultBranchSource, "remote-head");
    assert.equal(
      inspection.remotes[0]?.fetchUrl,
      "https://example.com/organization/repository.git",
    );
    assert.equal(JSON.stringify(inspection).includes("secret-token"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked worktrees resolve distinct Git directories and one common directory", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-git-inspect-"));
  try {
    const repository = createRepository(root);
    const worktree = join(root, "linked-worktree");
    git(repository, "worktree", "add", "-b", "feature/worktree", worktree);

    const inspector = new GitCliRepositoryInspector();
    const main = inspector.inspect(repository);
    const linked = inspector.inspect(worktree);
    assert.notEqual(linked.gitDirectory, main.gitDirectory);
    assert.equal(linked.commonGitDirectory, main.commonGitDirectory);
    assert.equal(linked.repositoryRoot, worktree);
    assert.equal(linked.currentBranch, "feature/worktree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare repositories are identified without inventing a worktree root", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-git-inspect-"));
  try {
    const source = createRepository(root, "source");
    const bare = join(root, "remote.git");
    execFileSync("git", ["clone", "--bare", source, bare], { stdio: "ignore" });

    const inspection = new GitCliRepositoryInspector().inspect(bare);
    assert.equal(inspection.bare, true);
    assert.equal(inspection.repositoryRoot, null);
    assert.equal(inspection.gitDirectory, bare);
    assert.equal(inspection.commonGitDirectory, bare);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default, repository, and caller branch protections are additive", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-git-inspect-"));
  try {
    const repository = createRepository(root);
    git(
      repository,
      "config",
      "--add",
      "agentworks.protectedBranch",
      "release/**",
    );
    git(repository, "config", "--add", "agentworks.protectedBranch", "stable");
    const inspection = new GitCliRepositoryInspector().inspect(repository);

    assert.deepEqual(assessBranchProtection(inspection, "main"), {
      branch: "main",
      protected: true,
      reasons: ["branch is the detected default branch"],
    });
    assert.equal(
      assessBranchProtection(inspection, "release/2026/hotfix").protected,
      true,
    );
    assert.equal(assessBranchProtection(inspection, "stable").protected, true);
    assert.equal(
      assessBranchProtection(inspection, "production", ["prod*"]).protected,
      true,
    );
    assert.equal(
      assessBranchProtection(inspection, "feature/safe").protected,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe patterns, non-repositories, and shell-shaped paths fail safely", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-git-inspect-"));
  try {
    const inspector = new GitCliRepositoryInspector();
    assert.throws(() => inspector.inspect(root), GitRepositoryInspectionError);

    const repository = createRepository(root, "repo;touch injected");
    const inspection = inspector.inspect(repository);
    assert.equal(inspection.repositoryRoot, repository);
    assert.equal(existsSync(join(root, "injected")), false);
    assert.throws(
      () => assessBranchProtection(inspection, "feature", ["../unsafe"]),
      /Invalid protected branch pattern/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
