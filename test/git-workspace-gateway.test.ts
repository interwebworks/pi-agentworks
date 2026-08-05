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
    stdio: ["ignore", "pipe", "pipe"],
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

function mergeRequest(
  fixture: ReturnType<typeof createStoryFixture>,
  candidateCommit: string,
) {
  return {
    runId: "run-1",
    storyId: "story-1",
    operationId: "merge-story-1",
    originalCheckout: fixture.repository,
    integrationBranch: integrationBranchForRun("run-1"),
    integrationWorktreePath: fixture.integrationPath,
    reviewedIntegrationHead: fixture.integrationHead,
    storyBranch: storyBranchForRun("run-1", "story-1"),
    storyWorktreePath: fixture.storyPath,
    candidateCommit,
    writerAgentId: "writer-1",
    reviewerAgentId: "reviewer-1",
    requesterRole: "project-manager",
    requiredChecksPassed: true,
    writerLeaseReleased: true,
    controllerLeaseCurrent: true,
    expectedRevisionMatches: true,
    targetIsDefaultOrProtected: false,
    protectedTargetUserApproval: false,
    subject: "Merge candidate for story-1",
  };
}

function createCandidateFixture(root: string) {
  const fixture = createStoryFixture(root);
  writeFileSync(join(fixture.storyPath, "candidate.txt"), "candidate\n");
  const candidate = fixture.gateway.createCandidateCommit(
    candidateRequest(
      fixture.repository,
      "story-1",
      fixture.storyPath,
      fixture.integrationHead,
      fixture.storyHead,
    ),
  );
  return { ...fixture, candidateCommit: candidate.commit };
}

function cleanupRequest(
  fixture: ReturnType<typeof createCandidateFixture>,
  mergeCommit: string,
) {
  return {
    runId: "run-1",
    storyId: "story-1",
    operationId: "cleanup-story-1",
    originalCheckout: fixture.repository,
    integrationBranch: integrationBranchForRun("run-1"),
    integrationWorktreePath: fixture.integrationPath,
    storyBranch: storyBranchForRun("run-1", "story-1"),
    storyWorktreePath: fixture.storyPath,
    candidateCommit: fixture.candidateCommit,
    reviewedIntegrationHead: fixture.integrationHead,
    mergeCommit,
    mergeOperationId: "merge-story-1",
    mergeSubject: "Merge candidate for story-1",
    reviewerAgentId: "reviewer-1",
    writerLeaseReleased: true,
    agentClosed: true,
    controllerLeaseCurrent: true,
    expectedRevisionMatches: true,
  };
}

function createMergedFixture(root: string) {
  const fixture = createCandidateFixture(root);
  const merged = fixture.gateway.mergeCandidate(
    mergeRequest(fixture, fixture.candidateCommit),
  );
  return { ...fixture, mergeCommit: merged.mergeCommit };
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

test("merges an exact reviewed candidate and recovers the committed result", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-merge-"));
  try {
    const fixture = createCandidateFixture(root);
    writeFileSync(join(fixture.repository, "original-only.txt"), "preserve\n");
    const originalStatus = git(fixture.repository, "status", "--porcelain=v1");
    const hookMarker = join(root, "merge-hook-executed");
    const signerMarker = join(root, "merge-signer-executed");
    const postMerge = join(fixture.repository, ".git", "hooks", "post-merge");
    const signer = join(root, "merge-signer");
    writeFileSync(postMerge, `#!/bin/sh\ntouch '${hookMarker}'\n`);
    writeFileSync(signer, `#!/bin/sh\ntouch '${signerMarker}'\nexit 1\n`);
    chmodSync(postMerge, 0o755);
    chmodSync(signer, 0o755);
    git(fixture.repository, "config", "commit.gpgSign", "true");
    git(fixture.repository, "config", "gpg.program", signer);
    git(
      fixture.repository,
      "config",
      `branch.${integrationBranchForRun("run-1")}.mergeOptions`,
      "--strategy=definitely-not-a-strategy",
    );
    const request_ = mergeRequest(fixture, fixture.candidateCommit);

    const merged = fixture.gateway.mergeCandidate(request_);
    assert.equal(merged.status, "created");
    assert.equal(merged.integrationParent, fixture.integrationHead);
    assert.equal(merged.candidateParent, fixture.candidateCommit);
    assert.equal(
      existsSync(join(fixture.integrationPath, "candidate.txt")),
      true,
    );
    assert.equal(git(fixture.integrationPath, "status", "--porcelain=v1"), "");
    assert.equal(
      git(fixture.integrationPath, "show", "-s", "--format=%P", "HEAD"),
      `${fixture.integrationHead} ${fixture.candidateCommit}`,
    );
    assert.match(
      git(fixture.integrationPath, "show", "-s", "--format=%B", "HEAD"),
      /Agentworks-Reviewer: reviewer-1/u,
    );
    assert.equal(existsSync(hookMarker), false);
    assert.equal(existsSync(signerMarker), false);

    const recovered = fixture.gateway.mergeCandidate(request_);
    assert.equal(recovered.status, "existing");
    assert.equal(recovered.mergeCommit, merged.mergeCommit);
    assert.equal(
      git(fixture.repository, "status", "--porcelain=v1"),
      originalStatus,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers an exact merge interrupted before commit creation", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-merge-"));
  try {
    const fixture = createCandidateFixture(root);
    git(
      fixture.integrationPath,
      "merge",
      "--no-ff",
      "--no-commit",
      fixture.candidateCommit,
    );
    assert.equal(
      git(fixture.integrationPath, "rev-parse", "MERGE_HEAD"),
      fixture.candidateCommit,
    );

    const merged = fixture.gateway.mergeCandidate(
      mergeRequest(fixture, fixture.candidateCommit),
    );
    assert.equal(merged.status, "created");
    assert.equal(git(fixture.integrationPath, "status", "--porcelain=v1"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merge policy rejects stale, unreviewed, self-reviewed, and protected requests", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-merge-"));
  try {
    const fixture = createCandidateFixture(root);
    const approved = mergeRequest(fixture, fixture.candidateCommit);
    const denied = [
      { ...approved, requesterRole: "backend-developer" },
      { ...approved, requiredChecksPassed: false },
      { ...approved, reviewerAgentId: "writer-1" },
      { ...approved, controllerLeaseCurrent: false },
      { ...approved, expectedRevisionMatches: false },
      { ...approved, writerLeaseReleased: false },
      {
        ...approved,
        targetIsDefaultOrProtected: true,
        protectedTargetUserApproval: false,
      },
    ];
    for (const request_ of denied) {
      assert.throws(() => fixture.gateway.mergeCandidate(request_));
    }
    assert.equal(
      git(fixture.integrationPath, "rev-parse", "HEAD"),
      fixture.integrationHead,
    );
    const protectedMerge = fixture.gateway.mergeCandidate({
      ...approved,
      targetIsDefaultOrProtected: true,
      protectedTargetUserApproval: true,
    });
    assert.equal(protectedMerge.status, "created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merge fails when integration or candidate identity changes after review", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-merge-"));
  try {
    const fixture = createCandidateFixture(root);
    const reviewed = mergeRequest(fixture, fixture.candidateCommit);
    writeFileSync(join(fixture.integrationPath, "advance.txt"), "advance\n");
    git(fixture.integrationPath, "add", "advance.txt");
    git(fixture.integrationPath, "commit", "-m", "Advance integration");
    assert.throws(
      () => fixture.gateway.mergeCandidate(reviewed),
      /not owned by this operation/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const secondRoot = mkdtempSync(join(tmpdir(), "agentworks-merge-"));
  try {
    const fixture = createCandidateFixture(secondRoot);
    const reviewed = mergeRequest(fixture, fixture.candidateCommit);
    writeFileSync(join(fixture.storyPath, "advance.txt"), "advance\n");
    git(fixture.storyPath, "add", "advance.txt");
    git(fixture.storyPath, "commit", "-m", "Advance candidate");
    assert.throws(
      () => fixture.gateway.mergeCandidate(reviewed),
      /exact registered candidate/u,
    );
  } finally {
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("removes an exact merged story worktree and branch without force", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-cleanup-"));
  try {
    const fixture = createMergedFixture(root);
    writeFileSync(join(fixture.repository, "original-only.txt"), "preserve\n");
    const originalStatus = git(fixture.repository, "status", "--porcelain=v1");
    const request_ = cleanupRequest(fixture, fixture.mergeCommit);

    const removed = fixture.gateway.cleanupStoryWorkspace(request_);
    assert.equal(removed.status, "removed");
    assert.equal(removed.worktreeAbsent, true);
    assert.equal(removed.branchAbsent, true);
    assert.equal(existsSync(fixture.storyPath), false);
    assert.throws(() =>
      git(fixture.repository, "rev-parse", request_.storyBranch),
    );
    assert.equal(
      git(
        fixture.repository,
        "merge-base",
        "--is-ancestor",
        fixture.candidateCommit,
        request_.integrationBranch,
      ),
      "",
    );
    assert.equal(
      git(fixture.repository, "status", "--porcelain=v1"),
      originalStatus,
    );

    const existing = fixture.gateway.cleanupStoryWorkspace(request_);
    assert.equal(existing.status, "existing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers cleanup after worktree removal but before branch deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-cleanup-"));
  try {
    const fixture = createMergedFixture(root);
    git(fixture.repository, "worktree", "remove", fixture.storyPath);
    assert.equal(existsSync(fixture.storyPath), false);
    assert.equal(
      git(
        fixture.repository,
        "rev-parse",
        storyBranchForRun("run-1", "story-1"),
      ),
      fixture.candidateCommit,
    );

    const recovered = fixture.gateway.cleanupStoryWorkspace(
      cleanupRequest(fixture, fixture.mergeCommit),
    );
    assert.equal(recovered.status, "recovered");
    assert.throws(() =>
      git(
        fixture.repository,
        "rev-parse",
        storyBranchForRun("run-1", "story-1"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup rejects tracked, untracked, and ignored worktree content", () => {
  const cases = ["tracked", "untracked", "ignored"] as const;
  for (const kind of cases) {
    const root = mkdtempSync(join(tmpdir(), `agentworks-cleanup-${kind}-`));
    try {
      const fixture = createMergedFixture(root);
      if (kind === "tracked") {
        writeFileSync(join(fixture.storyPath, "candidate.txt"), "changed\n");
      } else if (kind === "untracked") {
        writeFileSync(join(fixture.storyPath, "valuable.txt"), "preserve\n");
      } else {
        writeFileSync(
          join(fixture.repository, ".git", "info", "exclude"),
          "ignored-output.txt\n",
        );
        writeFileSync(
          join(fixture.storyPath, "ignored-output.txt"),
          "preserve\n",
        );
      }
      assert.throws(
        () =>
          fixture.gateway.cleanupStoryWorkspace(
            cleanupRequest(fixture, fixture.mergeCommit),
          ),
        /worktree is not clean/u,
      );
      assert.equal(existsSync(fixture.storyPath), true);
      assert.equal(
        git(
          fixture.repository,
          "rev-parse",
          storyBranchForRun("run-1", "story-1"),
        ),
        fixture.candidateCommit,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("cleanup requires released lease, closed agent, current fence, and merge ancestry", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-cleanup-"));
  try {
    const fixture = createMergedFixture(root);
    const allowed = cleanupRequest(fixture, fixture.mergeCommit);
    for (const denied of [
      { ...allowed, writerLeaseReleased: false },
      { ...allowed, agentClosed: false },
      { ...allowed, controllerLeaseCurrent: false },
      { ...allowed, expectedRevisionMatches: false },
    ]) {
      assert.throws(() => fixture.gateway.cleanupStoryWorkspace(denied));
    }

    git(fixture.integrationPath, "reset", "--hard", fixture.integrationHead);
    assert.throws(
      () => fixture.gateway.cleanupStoryWorkspace(allowed),
      /merge ancestry proof is missing/u,
    );
    assert.equal(existsSync(fixture.storyPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup refuses unregistered replacement content after interrupted removal", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-cleanup-"));
  try {
    const fixture = createMergedFixture(root);
    git(fixture.repository, "worktree", "remove", fixture.storyPath);
    mkdirSync(fixture.storyPath);
    writeFileSync(join(fixture.storyPath, "valuable.txt"), "preserve\n");
    assert.throws(
      () =>
        fixture.gateway.cleanupStoryWorkspace(
          cleanupRequest(fixture, fixture.mergeCommit),
        ),
      /Unregistered content exists/u,
    );
    assert.equal(
      readFileSync(join(fixture.storyPath, "valuable.txt"), "utf8"),
      "preserve\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
