import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { integrationBranchForRun } from "../src/domain/workspace-naming.ts";
import { GitCliRepositoryInspector } from "../src/infrastructure/git/git-cli-repository-inspector.ts";
import {
  GitCliWorkspaceGateway,
  GitWorkspaceError,
} from "../src/infrastructure/git/git-cli-workspace-gateway.ts";

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  }).trim();
}

function createRepository(root: string, name = "repository"): string {
  const repository = join(root, name);
  execFileSync("git", ["init", "--initial-branch", "main", repository], {
    stdio: "ignore",
  });
  git(repository, "config", "user.name", "Agentworks Test");
  git(repository, "config", "user.email", "agentworks@example.test");
  writeFileSync(join(repository, "README.md"), "initial\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "Initial commit");
  return repository;
}

function request(
  repository: string,
  worktreePath: string,
  expectedBaseHead?: string,
) {
  const inspection = new GitCliRepositoryInspector().inspect(repository);
  assert.ok(inspection.repositoryRoot);
  return {
    runId: "run-1",
    originalCheckout: inspection.repositoryRoot,
    repositoryRoot: inspection.repositoryRoot,
    commonGitDirectory: inspection.commonGitDirectory,
    baseBranch: "main",
    expectedBaseHead: expectedBaseHead ?? inspection.headCommit ?? "",
    integrationBranch: integrationBranchForRun("run-1"),
    worktreePath,
  };
}

test("creates and idempotently reuses a dedicated integration worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-workspace-"));
  try {
    const repository = createRepository(root);
    writeFileSync(join(repository, "untracked.txt"), "preserve me\n");
    const originalStatus = git(repository, "status", "--porcelain=v1");
    const originalBranch = git(repository, "branch", "--show-current");
    const originalHead = git(repository, "rev-parse", "HEAD");
    const worktreePath = join(root, "worktrees", "run-1", "integration");
    const gateway = new GitCliWorkspaceGateway();

    const created = gateway.createIntegrationWorkspace(
      request(repository, worktreePath),
    );
    assert.equal(created.status, "created");
    assert.equal(created.branch, "agentworks/run-1/integration");
    assert.equal(created.branchHead, originalHead);
    assert.equal(
      readFileSync(join(worktreePath, "README.md"), "utf8"),
      "initial\n",
    );

    const existing = gateway.createIntegrationWorkspace(
      request(repository, worktreePath),
    );
    assert.equal(existing.status, "existing");
    assert.equal(existing.branchHead, created.branchHead);
    assert.equal(git(repository, "status", "--porcelain=v1"), originalStatus);
    assert.equal(git(repository, "branch", "--show-current"), originalBranch);
    assert.equal(git(repository, "rev-parse", "HEAD"), originalHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers a controller-created branch when worktree attachment was interrupted", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-workspace-"));
  try {
    const repository = createRepository(root);
    const branch = integrationBranchForRun("run-1");
    git(repository, "branch", branch, "HEAD");
    const worktreePath = join(root, "worktrees", "integration");

    const result = new GitCliWorkspaceGateway().createIntegrationWorkspace(
      request(repository, worktreePath),
    );
    assert.equal(result.status, "recovered");
    assert.equal(git(worktreePath, "branch", "--show-current"), branch);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale base evidence and a hijacked existing branch fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-workspace-"));
  try {
    const repository = createRepository(root);
    const oldHead = git(repository, "rev-parse", "HEAD");
    writeFileSync(join(repository, "README.md"), "second\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "Second commit");
    const gateway = new GitCliWorkspaceGateway();

    assert.throws(
      () =>
        gateway.createIntegrationWorkspace(
          request(repository, join(root, "stale-worktree"), oldHead),
        ),
      /Base branch HEAD changed/u,
    );

    git(repository, "branch", integrationBranchForRun("run-1"), oldHead);
    assert.throws(
      () =>
        gateway.createIntegrationWorkspace(
          request(repository, join(root, "hijacked-worktree")),
        ),
      /does not match the expected base HEAD/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects paths inside the original checkout and unregistered existing paths", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-workspace-"));
  try {
    const repository = createRepository(root);
    const gateway = new GitCliWorkspaceGateway();
    assert.throws(
      () =>
        gateway.createIntegrationWorkspace(
          request(repository, join(repository, "nested-worktree")),
        ),
      /must be outside the original checkout/u,
    );

    const occupied = join(root, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "valuable.txt"), "do not replace\n");
    assert.throws(
      () => gateway.createIntegrationWorkspace(request(repository, occupied)),
      /already exists/u,
    );
    assert.equal(
      readFileSync(join(occupied, "valuable.txt"), "utf8"),
      "do not replace\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disables repository hooks and configured filters during checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-workspace-"));
  try {
    const repository = createRepository(root);
    const hookMarker = join(root, "hook-executed");
    const filterMarker = join(root, "filter-executed");
    const hook = join(repository, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`);
    chmodSync(hook, 0o755);
    writeFileSync(
      join(repository, ".gitattributes"),
      "README.md filter=evil\n",
    );
    git(
      repository,
      "config",
      "filter.evil.smudge",
      `touch '${filterMarker}'; cat`,
    );
    git(repository, "config", "filter.evil.clean", "cat");
    git(repository, "add", ".gitattributes");
    git(repository, "commit", "-m", "Add attributes");

    const worktreePath = join(root, "safe-worktree");
    new GitCliWorkspaceGateway().createIntegrationWorkspace(
      request(repository, worktreePath),
    );
    assert.equal(existsSync(hookMarker), false);
    assert.equal(existsSync(filterMarker), false);
    assert.equal(existsSync(join(worktreePath, "README.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell-shaped worktree paths and invalid integration identities cannot inject", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-workspace-"));
  try {
    const repository = createRepository(root);
    const worktreePath = join(root, "worktree;touch injected");
    const gateway = new GitCliWorkspaceGateway();
    const validRequest = request(repository, worktreePath);
    gateway.createIntegrationWorkspace(validRequest);
    assert.equal(existsSync(join(root, "injected")), false);

    assert.throws(
      () =>
        gateway.createIntegrationWorkspace({
          ...validRequest,
          worktreePath: join(root, "other-worktree"),
          integrationBranch: "attacker/branch",
        }),
      GitWorkspaceError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
