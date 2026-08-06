import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  integrationBranchForRun,
  storyBranchForRun,
} from "../src/domain/workspace-naming.ts";
import { GitCliRepositoryInspector } from "../src/infrastructure/git/git-cli-repository-inspector.ts";
import { GitCliWorkspaceGateway } from "../src/infrastructure/git/git-cli-workspace-gateway.ts";

const RUN = "run-1";
const STORY = "story-1";

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  }).trim();
}

function createRepository(root: string): string {
  const repository = join(root, "checkout");
  execFileSync("git", ["init", "--initial-branch", "main", repository], {
    stdio: "ignore",
  });
  git(repository, "config", "user.name", "Agentworks Test");
  git(repository, "config", "user.email", "agentworks@example.test");
  writeFileSync(join(repository, "README.md"), "initial\n");
  writeFileSync(join(repository, ".gitignore"), "build/\n");
  git(repository, "add", "README.md", ".gitignore");
  git(repository, "commit", "-m", "Initial commit");
  // Leave real-world clutter the run must never disturb.
  writeFileSync(join(repository, "uncommitted.txt"), "user work in progress\n");
  writeFileSync(join(repository, "build"), "ignored artifact\n");
  return repository;
}

/**
 * A fingerprint of the checkout as the *user* sees it: every working-tree file
 * (excluding the .git directory) by content, plus HEAD, the current branch, the
 * base-branch tip, and porcelain status. The controller legitimately adds
 * sibling branches to the shared object store; that is isolation working, not a
 * modification of the checkout, so refs are deliberately excluded here.
 */
function fingerprint(repository: string): string {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        const hash = createHash("sha256")
          .update(readFileSync(absolute))
          .digest("hex");
        files.push(`${relative(repository, absolute)}:${hash}`);
      }
    }
  };
  walk(repository);
  return JSON.stringify({
    files,
    head: git(repository, "rev-parse", "HEAD"),
    branch: git(repository, "branch", "--show-current"),
    baseTip: git(repository, "rev-parse", "main"),
    status: git(repository, "status", "--porcelain=v1"),
  });
}

function worktreePaths(repository: string): string[] {
  return git(repository, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function isInside(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
}

test("a full run lifecycle never uses or modifies the original checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-preservation-"));
  try {
    const checkout = createRepository(root);
    const before = fingerprint(checkout);
    const inspection = new GitCliRepositoryInspector().inspect(checkout);
    assert.ok(inspection.repositoryRoot);
    const gateway = new GitCliWorkspaceGateway();

    const integrationPath = join(root, "worktrees", RUN, "integration");
    const storyPath = join(root, "worktrees", RUN, STORY);
    // Every path handed to an agent must live outside the checkout.
    assert.equal(isInside(integrationPath, checkout), false);
    assert.equal(isInside(storyPath, checkout), false);

    const base = {
      runId: RUN,
      originalCheckout: inspection.repositoryRoot,
      repositoryRoot: inspection.repositoryRoot,
      commonGitDirectory: inspection.commonGitDirectory,
    };

    const integration = gateway.createIntegrationWorkspace({
      ...base,
      baseBranch: "main",
      expectedBaseHead: inspection.headCommit ?? "",
      integrationBranch: integrationBranchForRun(RUN),
      worktreePath: integrationPath,
    });
    assert.equal(fingerprint(checkout), before);

    const story = gateway.createStoryWorkspace({
      ...base,
      storyId: STORY,
      integrationBranch: integrationBranchForRun(RUN),
      expectedIntegrationHead: integration.branchHead,
      storyBranch: storyBranchForRun(RUN, STORY),
      worktreePath: storyPath,
    });
    assert.equal(fingerprint(checkout), before);

    // The writer produces work inside its own worktree only.
    writeFileSync(join(storyPath, "feature.txt"), "delivered\n");
    const candidate = gateway.createCandidateCommit({
      runId: RUN,
      storyId: STORY,
      operationId: `candidate-${STORY}`,
      originalCheckout: checkout,
      integrationBranch: integrationBranchForRun(RUN),
      expectedIntegrationHead: integration.branchHead,
      storyBranch: storyBranchForRun(RUN, STORY),
      expectedStoryHead: story.branchHead,
      worktreePath: storyPath,
      subject: `Candidate for ${STORY}`,
      writerLeaseReleased: true,
    });
    assert.equal(fingerprint(checkout), before);

    const merge = gateway.mergeCandidate({
      runId: RUN,
      storyId: STORY,
      operationId: `merge-${STORY}`,
      originalCheckout: checkout,
      integrationBranch: integrationBranchForRun(RUN),
      integrationWorktreePath: integrationPath,
      reviewedIntegrationHead: integration.branchHead,
      storyBranch: storyBranchForRun(RUN, STORY),
      storyWorktreePath: storyPath,
      candidateCommit: candidate.commit,
      writerAgentId: "writer-1",
      reviewerAgentId: "reviewer-1",
      requesterRole: "project-manager",
      requiredChecksPassed: true,
      writerLeaseReleased: true,
      controllerLeaseCurrent: true,
      expectedRevisionMatches: true,
      targetIsDefaultOrProtected: false,
      protectedTargetUserApproval: false,
      subject: `Merge ${STORY}`,
    });
    assert.equal(fingerprint(checkout), before);

    gateway.cleanupStoryWorkspace({
      runId: RUN,
      storyId: STORY,
      operationId: `cleanup-${STORY}`,
      originalCheckout: checkout,
      integrationBranch: integrationBranchForRun(RUN),
      integrationWorktreePath: integrationPath,
      storyBranch: storyBranchForRun(RUN, STORY),
      storyWorktreePath: storyPath,
      candidateCommit: candidate.commit,
      reviewedIntegrationHead: integration.branchHead,
      mergeCommit: merge.mergeCommit,
      mergeOperationId: `merge-${STORY}`,
      mergeSubject: `Merge ${STORY}`,
      reviewerAgentId: "reviewer-1",
      writerLeaseReleased: true,
      agentClosed: true,
      controllerLeaseCurrent: true,
      expectedRevisionMatches: true,
    });

    // End to end, the user's checkout is byte-for-byte what it was.
    assert.equal(fingerprint(checkout), before);

    // No agent worktree was ever nested inside the checkout; the checkout is
    // the sole worktree living at its own path.
    for (const path of worktreePaths(checkout)) {
      if (path !== inspection.repositoryRoot) {
        assert.equal(
          isInside(path, checkout),
          false,
          `worktree ${path} must be outside the checkout`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
