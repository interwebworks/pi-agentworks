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
import {
  integrationBranchForRun,
  storyBranchForRun,
} from "../src/domain/workspace-naming.ts";
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

function storyRequest(
  repository: string,
  storyId: string,
  worktreePath: string,
  expectedIntegrationHead: string,
) {
  const inspection = new GitCliRepositoryInspector().inspect(repository);
  assert.ok(inspection.repositoryRoot);
  return {
    runId: "run-1",
    storyId,
    originalCheckout: inspection.repositoryRoot,
    repositoryRoot: inspection.repositoryRoot,
    commonGitDirectory: inspection.commonGitDirectory,
    integrationBranch: integrationBranchForRun("run-1"),
    expectedIntegrationHead,
    storyBranch: storyBranchForRun("run-1", storyId),
    worktreePath,
  };
}

function candidateRequest(
  repository: string,
  storyId: string,
  worktreePath: string,
  expectedIntegrationHead: string,
  expectedStoryHead = expectedIntegrationHead,
) {
  return {
    runId: "run-1",
    storyId,
    operationId: `candidate-${storyId}`,
    originalCheckout: repository,
    integrationBranch: integrationBranchForRun("run-1"),
    expectedIntegrationHead,
    storyBranch: storyBranchForRun("run-1", storyId),
    expectedStoryHead,
    worktreePath,
    subject: `Create candidate for ${storyId}`,
    writerLeaseReleased: true,
  };
}

function createStoryFixture(root: string) {
  const repository = createRepository(root);
  const gateway = new GitCliWorkspaceGateway();
  const integrationPath = join(root, "integration");
  const integration = gateway.createIntegrationWorkspace(
    request(repository, integrationPath),
  );
  const storyPath = join(root, "story-1");
  const storyWorkspace = gateway.createStoryWorkspace(
    storyRequest(repository, "story-1", storyPath, integration.branchHead),
  );
  return {
    repository,
    gateway,
    integrationPath,
    integrationHead: integration.branchHead,
    storyPath,
    storyHead: storyWorkspace.branchHead,
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
      /Integration base branch HEAD changed/u,
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

test("creates one isolated worktree per story from the exact integration HEAD", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-story-workspace-"));
  try {
    const repository = createRepository(root);
    const gateway = new GitCliWorkspaceGateway();
    const integrationPath = join(root, "worktrees", "integration");
    const integration = gateway.createIntegrationWorkspace(
      request(repository, integrationPath),
    );
    writeFileSync(join(integrationPath, "pm-notes.txt"), "stay isolated\n");
    const integrationStatus = git(integrationPath, "status", "--porcelain=v1");
    const originalStatus = git(repository, "status", "--porcelain=v1");

    const firstPath = join(root, "worktrees", "story-1");
    const secondPath = join(root, "worktrees", "story-2");
    const first = gateway.createStoryWorkspace(
      storyRequest(repository, "story-1", firstPath, integration.branchHead),
    );
    const second = gateway.createStoryWorkspace(
      storyRequest(repository, "story-2", secondPath, integration.branchHead),
    );
    assert.equal(first.status, "created");
    assert.equal(first.branch, "agentworks/run-1/stories/story-1");
    assert.equal(second.branch, "agentworks/run-1/stories/story-2");
    assert.equal(first.branchHead, integration.branchHead);
    assert.equal(second.branchHead, integration.branchHead);
    assert.equal(existsSync(join(firstPath, "pm-notes.txt")), false);
    assert.equal(
      git(integrationPath, "status", "--porcelain=v1"),
      integrationStatus,
    );
    assert.equal(git(repository, "status", "--porcelain=v1"), originalStatus);

    const existing = gateway.createStoryWorkspace(
      storyRequest(repository, "story-1", firstPath, integration.branchHead),
    );
    assert.equal(existing.status, "existing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers interrupted story attachment and rejects stale integration evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-story-workspace-"));
  try {
    const repository = createRepository(root);
    const gateway = new GitCliWorkspaceGateway();
    const integrationPath = join(root, "integration");
    const integration = gateway.createIntegrationWorkspace(
      request(repository, integrationPath),
    );
    const storyBranch = storyBranchForRun("run-1", "story-1");
    git(repository, "branch", storyBranch, integration.branchHead);
    const recovered = gateway.createStoryWorkspace(
      storyRequest(
        repository,
        "story-1",
        join(root, "story-1"),
        integration.branchHead,
      ),
    );
    assert.equal(recovered.status, "recovered");

    writeFileSync(join(integrationPath, "advance.txt"), "advance\n");
    git(integrationPath, "add", "advance.txt");
    git(integrationPath, "commit", "-m", "Advance integration");
    assert.throws(
      () =>
        gateway.createStoryWorkspace(
          storyRequest(
            repository,
            "story-2",
            join(root, "story-2"),
            integration.branchHead,
          ),
        ),
      /Story base branch HEAD changed/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("story paths cannot overlap existing worktrees or claim another story identity", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-story-workspace-"));
  try {
    const repository = createRepository(root);
    const gateway = new GitCliWorkspaceGateway();
    const integrationPath = join(root, "integration");
    const integration = gateway.createIntegrationWorkspace(
      request(repository, integrationPath),
    );
    assert.throws(
      () =>
        gateway.createStoryWorkspace(
          storyRequest(
            repository,
            "story-1",
            join(integrationPath, "nested"),
            integration.branchHead,
          ),
        ),
      /nested within another worktree/u,
    );

    const valid = storyRequest(
      repository,
      "story-1",
      join(root, "story-1"),
      integration.branchHead,
    );
    assert.throws(
      () =>
        gateway.createStoryWorkspace({
          ...valid,
          storyBranch: storyBranchForRun("run-1", "story-2"),
        }),
      /does not match the story identity/u,
    );
    assert.throws(() => storyBranchForRun("run-1", "story..lock"));
    assert.throws(() => storyBranchForRun("../run", "story-1"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates and recovers an exact controller-authored candidate commit", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-candidate-"));
  try {
    const fixture = createStoryFixture(root);
    writeFileSync(join(fixture.repository, "original-only.txt"), "preserve\n");
    writeFileSync(join(fixture.integrationPath, "pm-only.txt"), "preserve\n");
    const originalStatus = git(fixture.repository, "status", "--porcelain=v1");
    const integrationStatus = git(
      fixture.integrationPath,
      "status",
      "--porcelain=v1",
    );
    git(fixture.storyPath, "mv", "README.md", "renamed README.md");
    writeFileSync(join(fixture.storyPath, "renamed README.md"), "candidate\n");
    writeFileSync(join(fixture.storyPath, "new file.txt"), "new\n");
    const candidate = candidateRequest(
      fixture.repository,
      "story-1",
      fixture.storyPath,
      fixture.integrationHead,
      fixture.storyHead,
    );

    const created = fixture.gateway.createCandidateCommit(candidate);
    assert.equal(created.status, "created");
    assert.equal(created.parent, fixture.storyHead);
    assert.deepEqual(created.changedPaths, [
      "README.md",
      "new file.txt",
      "renamed README.md",
    ]);
    assert.equal(git(fixture.storyPath, "status", "--porcelain=v1"), "");
    assert.equal(
      git(fixture.storyPath, "show", "-s", "--format=%an <%ae>", "HEAD"),
      "Agentworks Controller <controller@agentworks.invalid>",
    );
    assert.match(
      git(fixture.storyPath, "show", "-s", "--format=%B", "HEAD"),
      /Agentworks-Operation: candidate-story-1/u,
    );

    const recovered = fixture.gateway.createCandidateCommit(candidate);
    assert.equal(recovered.status, "existing");
    assert.equal(recovered.commit, created.commit);
    assert.deepEqual(recovered.changedPaths, created.changedPaths);
    assert.equal(
      git(fixture.repository, "status", "--porcelain=v1"),
      originalStatus,
    );
    assert.equal(
      git(fixture.integrationPath, "status", "--porcelain=v1"),
      integrationStatus,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate creation fails closed for active leases, empty work, and stale integration", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-candidate-"));
  try {
    const fixture = createStoryFixture(root);
    const candidate = candidateRequest(
      fixture.repository,
      "story-1",
      fixture.storyPath,
      fixture.integrationHead,
    );
    assert.throws(
      () =>
        fixture.gateway.createCandidateCommit({
          ...candidate,
          writerLeaseReleased: false,
        }),
      /writer lease to be released/u,
    );
    assert.throws(
      () => fixture.gateway.createCandidateCommit(candidate),
      /no changes to commit/u,
    );

    writeFileSync(join(fixture.integrationPath, "advance.txt"), "advance\n");
    git(fixture.integrationPath, "add", "advance.txt");
    git(fixture.integrationPath, "commit", "-m", "Advance integration");
    writeFileSync(join(fixture.storyPath, "README.md"), "candidate\n");
    assert.throws(
      () => fixture.gateway.createCandidateCommit(candidate),
      /Integration HEAD changed/u,
    );
    assert.throws(
      () =>
        fixture.gateway.createCandidateCommit({
          ...candidate,
          operationId: "../candidate",
        }),
      /unsafe/u,
    );
    assert.throws(
      () =>
        fixture.gateway.createCandidateCommit({
          ...candidate,
          subject: "bad\nsubject",
        }),
      /control characters/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate creation rejects an unresolved index before staging", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-candidate-"));
  try {
    const fixture = createStoryFixture(root);
    const hashBlob = (content: string): string =>
      execFileSync(
        "git",
        ["-C", fixture.storyPath, "hash-object", "-w", "--stdin"],
        { encoding: "utf8", input: content },
      ).trim();
    const base = git(fixture.storyPath, "rev-parse", "HEAD:README.md");
    const ours = hashBlob("ours\n");
    const theirs = hashBlob("theirs\n");
    const zeroObject = "0".repeat(base.length);
    execFileSync(
      "git",
      ["-C", fixture.storyPath, "update-index", "--index-info"],
      {
        input: `0 ${zeroObject}\tREADME.md\n100644 ${base} 1\tREADME.md\n100644 ${ours} 2\tREADME.md\n100644 ${theirs} 3\tREADME.md\n`,
      },
    );
    writeFileSync(
      join(fixture.storyPath, "README.md"),
      "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n",
    );
    assert.throws(
      () =>
        fixture.gateway.createCandidateCommit(
          candidateRequest(
            fixture.repository,
            "story-1",
            fixture.storyPath,
            fixture.integrationHead,
          ),
        ),
      /unresolved merge conflicts/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate creation rejects submodule index changes", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-candidate-"));
  try {
    const fixture = createStoryFixture(root);
    git(
      fixture.storyPath,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${fixture.storyHead},nested-repository`,
    );
    assert.throws(
      () =>
        fixture.gateway.createCandidateCommit(
          candidateRequest(
            fixture.repository,
            "story-1",
            fixture.storyPath,
            fixture.integrationHead,
          ),
        ),
      /unsupported submodule changes/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate mutation suppresses repository hooks, filters, and signing programs", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-candidate-"));
  try {
    const repository = createRepository(root);
    const hookMarker = join(root, "commit-hook-executed");
    const filterMarker = join(root, "clean-filter-executed");
    const signerMarker = join(root, "signer-executed");
    const hook = join(repository, ".git", "hooks", "post-commit");
    const signer = join(root, "malicious-signer");
    writeFileSync(signer, `#!/bin/sh\ntouch '${signerMarker}'\nexit 1\n`);
    chmodSync(signer, 0o755);
    writeFileSync(
      join(repository, ".gitattributes"),
      "README.md filter=evil\n",
    );
    git(
      repository,
      "config",
      "filter.evil.clean",
      `touch '${filterMarker}'; cat`,
    );
    git(repository, "config", "filter.evil.smudge", "cat");
    git(repository, "config", "commit.gpgSign", "true");
    git(repository, "config", "core.commentChar", "A");
    git(repository, "config", "gpg.program", signer);
    git(repository, "add", ".gitattributes");
    git(
      repository,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "Add attributes",
    );
    rmSync(filterMarker, { force: true });
    writeFileSync(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`);
    chmodSync(hook, 0o755);

    const gateway = new GitCliWorkspaceGateway();
    const integrationPath = join(root, "integration");
    const integration = gateway.createIntegrationWorkspace(
      request(repository, integrationPath),
    );
    const storyPath = join(root, "story-1");
    const story = gateway.createStoryWorkspace(
      storyRequest(repository, "story-1", storyPath, integration.branchHead),
    );
    writeFileSync(join(storyPath, "README.md"), "safe candidate\n");
    const result = gateway.createCandidateCommit(
      candidateRequest(
        repository,
        "story-1",
        storyPath,
        integration.branchHead,
        story.branchHead,
      ),
    );
    assert.equal(result.status, "created");
    assert.equal(existsSync(hookMarker), false);
    assert.equal(existsSync(filterMarker), false);
    assert.equal(existsSync(signerMarker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate recovery rejects a branch advanced by another commit", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-candidate-"));
  try {
    const fixture = createStoryFixture(root);
    const candidate = candidateRequest(
      fixture.repository,
      "story-1",
      fixture.storyPath,
      fixture.integrationHead,
    );
    writeFileSync(join(fixture.storyPath, "README.md"), "candidate\n");
    fixture.gateway.createCandidateCommit(candidate);
    writeFileSync(join(fixture.storyPath, "after.txt"), "unauthorized\n");
    git(fixture.storyPath, "add", "after.txt");
    git(fixture.storyPath, "commit", "-m", "Unrelated commit");
    assert.throws(
      () => fixture.gateway.createCandidateCommit(candidate),
      /not owned by this candidate operation/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
