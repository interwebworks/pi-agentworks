import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  CandidateCommitResult,
  CleanupStoryWorkspaceRequest,
  CleanupStoryWorkspaceResult,
  CreateCandidateCommitRequest,
  CreateIntegrationWorkspaceRequest,
  CreateStoryWorkspaceRequest,
  GitWorkspaceGateway,
  GitWorktreeRecord,
  GitWorkspaceResult,
  MergeCandidateRequest,
  MergeCandidateResult,
  RollbackStoryWorkspaceRequest,
} from "../../application/ports/git-workspace-gateway.ts";
import {
  assessCleanupEligibility,
  assessMergeEligibility,
} from "../../domain/execution-policy.ts";
import {
  assertSafeWorkspaceId,
  integrationBranchForRun,
  storyBranchForRun,
} from "../../domain/workspace-naming.ts";

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export class GitWorkspaceError extends Error {
  readonly command: readonly string[];

  constructor(message: string, command: readonly string[] = []) {
    super(message);
    this.name = "GitWorkspaceError";
    this.command = command;
  }
}

interface GitCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CreateWorkspaceCommand {
  readonly label: "Integration" | "Story";
  readonly checkout: string;
  readonly repositoryRoot: string;
  readonly commonGitDirectory: string;
  readonly baseBranch: string;
  readonly expectedBaseHead: string;
  readonly allowBaseBranchAdvance?: true;
  readonly branch: string;
  readonly worktreePath: string;
}

export interface GitCliWorkspaceGatewayOptions {
  readonly gitPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitWorkspaceError(`${label} must be positive`);
  }
  return value;
}

function isWithin(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateCommitSubject(subject: string): string {
  if (
    subject.length < 1 ||
    subject.length > 120 ||
    subject.trim() !== subject
  ) {
    throw new GitWorkspaceError(
      "Candidate commit subject must contain from 1 to 120 trimmed characters",
    );
  }
  for (const character of subject) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      throw new GitWorkspaceError(
        "Candidate commit subject cannot contain control characters",
      );
    }
  }
  return subject;
}

function fieldAfterSpaces(value: string, spaceCount: number): string {
  let offset = -1;
  for (let index = 0; index < spaceCount; index += 1) {
    offset = value.indexOf(" ", offset + 1);
    if (offset < 0) {
      throw new GitWorkspaceError("Git returned malformed status data");
    }
  }
  return value.slice(offset + 1);
}

function parseChangedPaths(
  serialized: string,
  includeIgnored = false,
): readonly string[] {
  if (serialized.length === 0) return [];
  const paths = new Set<string>();
  const records = serialized.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0) continue;
    if (record.startsWith("u ")) {
      throw new GitWorkspaceError(
        "Candidate worktree contains unresolved merge conflicts",
      );
    }
    if (record.startsWith("? ")) {
      paths.add(record.slice(2));
      continue;
    }
    if (record.startsWith("! ")) {
      if (includeIgnored) paths.add(record.slice(2));
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const fields = record.split(" ", 4);
      const submodule = fields[2];
      if (submodule?.startsWith("S") === true) {
        throw new GitWorkspaceError(
          "Candidate worktree contains unsupported submodule changes",
        );
      }
      paths.add(fieldAfterSpaces(record, record.startsWith("2 ") ? 9 : 8));
      if (record.startsWith("2 ")) {
        const originalPath = records[index + 1];
        if (originalPath === undefined || originalPath.length === 0) {
          throw new GitWorkspaceError("Git returned malformed rename status");
        }
        paths.add(originalPath);
        index += 1;
      }
      continue;
    }
    throw new GitWorkspaceError("Git returned an unknown status record");
  }
  return Object.freeze([...paths].sort());
}

function parseWorktrees(serialized: string): readonly GitWorktreeRecord[] {
  if (serialized.length === 0) return [];
  const records: GitWorktreeRecord[] = [];
  let current: {
    path: string;
    head: string | null;
    branch: string | null;
    bare: boolean;
    detached: boolean;
    prunable: boolean;
    locked: boolean;
  } | null = null;

  const finish = (): void => {
    if (current === null) return;
    records.push(Object.freeze({ ...current }));
    current = null;
  };
  for (const field of serialized.split("\0")) {
    if (field.length === 0) {
      finish();
      continue;
    }
    const separator = field.indexOf(" ");
    const name = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (name === "worktree") {
      finish();
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        prunable: false,
        locked: false,
      };
      continue;
    }
    if (current === null) {
      throw new GitWorkspaceError("Git returned malformed worktree data");
    }
    switch (name) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.startsWith("refs/heads/")
          ? value.slice("refs/heads/".length)
          : value;
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
      case "prunable":
        current.prunable = true;
        break;
      case "locked":
        current.locked = true;
        break;
      default:
        break;
    }
  }
  finish();
  return Object.freeze(records);
}

export class GitCliWorkspaceGateway implements GitWorkspaceGateway {
  readonly #gitPath: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: GitCliWorkspaceGatewayOptions = {}) {
    this.#gitPath = options.gitPath ?? "git";
    this.#timeoutMs = positiveSafeInteger(
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      "Git timeout",
    );
    this.#maxOutputBytes = positiveSafeInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "Git output limit",
    );
  }

  listWorktrees(originalCheckout: string): readonly GitWorktreeRecord[] {
    const checkout = realpathSync(resolve(originalCheckout));
    return parseWorktrees(
      this.#required(checkout, ["worktree", "list", "--porcelain", "-z"]),
    ).map((record) =>
      Object.freeze({
        ...record,
        path: existsSync(record.path)
          ? realpathSync(record.path)
          : resolve(record.path),
      }),
    );
  }

  createIntegrationWorkspace(
    request: CreateIntegrationWorkspaceRequest,
  ): GitWorkspaceResult {
    if (request.integrationBranch !== integrationBranchForRun(request.runId)) {
      throw new GitWorkspaceError(
        "Integration branch does not match the run identity",
      );
    }
    return this.#createWorkspace({
      label: "Integration",
      checkout: request.originalCheckout,
      repositoryRoot: request.repositoryRoot,
      commonGitDirectory: request.commonGitDirectory,
      baseBranch: request.baseBranch,
      expectedBaseHead: request.expectedBaseHead,
      ...(request.allowBaseBranchAdvance === true
        ? { allowBaseBranchAdvance: true as const }
        : {}),
      branch: request.integrationBranch,
      worktreePath: request.worktreePath,
    });
  }

  createStoryWorkspace(
    request: CreateStoryWorkspaceRequest,
  ): GitWorkspaceResult {
    if (request.integrationBranch !== integrationBranchForRun(request.runId)) {
      throw new GitWorkspaceError(
        "Integration branch does not match the run identity",
      );
    }
    if (
      request.storyBranch !== storyBranchForRun(request.runId, request.storyId)
    ) {
      throw new GitWorkspaceError(
        "Story branch does not match the story identity",
      );
    }
    return this.#createWorkspace({
      label: "Story",
      checkout: request.originalCheckout,
      repositoryRoot: request.repositoryRoot,
      commonGitDirectory: request.commonGitDirectory,
      baseBranch: request.integrationBranch,
      expectedBaseHead: request.expectedIntegrationHead,
      branch: request.storyBranch,
      worktreePath: request.worktreePath,
    });
  }

  createCandidateCommit(
    request: CreateCandidateCommitRequest,
  ): CandidateCommitResult {
    assertSafeWorkspaceId(request.operationId, "Candidate operation id");
    if (request.integrationBranch !== integrationBranchForRun(request.runId)) {
      throw new GitWorkspaceError(
        "Candidate integration branch does not match the run identity",
      );
    }
    if (
      request.storyBranch !== storyBranchForRun(request.runId, request.storyId)
    ) {
      throw new GitWorkspaceError(
        "Candidate story branch does not match the story identity",
      );
    }
    if (!request.writerLeaseReleased) {
      throw new GitWorkspaceError(
        "Candidate commit requires the writer lease to be released",
      );
    }
    if (
      !OBJECT_ID_PATTERN.test(request.expectedStoryHead) ||
      !OBJECT_ID_PATTERN.test(request.expectedIntegrationHead)
    ) {
      throw new GitWorkspaceError("Candidate commit evidence is invalid");
    }
    const subject = validateCommitSubject(request.subject);
    const checkout = realpathSync(resolve(request.originalCheckout));
    const worktreePath = realpathSync(resolve(request.worktreePath));
    const worktree = this.listWorktrees(checkout).find(
      (record) => record.path === worktreePath,
    );
    if (
      worktree?.branch !== request.storyBranch ||
      worktree.detached ||
      worktree.bare ||
      worktree.prunable
    ) {
      throw new GitWorkspaceError(
        "Candidate worktree is not the registered story branch worktree",
      );
    }

    const currentStoryHead = this.#required(worktreePath, [
      "rev-parse",
      "--verify",
      `refs/heads/${request.storyBranch}^{commit}`,
    ]);
    const message = this.#candidateCommitMessage(request, subject);
    if (worktree.head !== currentStoryHead) {
      throw new GitWorkspaceError(
        "Candidate worktree HEAD does not match its story branch",
      );
    }
    if (currentStoryHead !== request.expectedStoryHead) {
      return this.#recoverCandidateCommit(
        request,
        worktreePath,
        currentStoryHead,
        message,
      );
    }
    const integrationHead = this.#required(checkout, [
      "rev-parse",
      "--verify",
      `refs/heads/${request.integrationBranch}^{commit}`,
    ]);
    if (integrationHead !== request.expectedIntegrationHead) {
      throw new GitWorkspaceError(
        "Integration HEAD changed before candidate commit creation",
      );
    }
    const ancestry = this.#run(checkout, [
      "merge-base",
      "--is-ancestor",
      request.expectedIntegrationHead,
      request.expectedStoryHead,
    ]);
    if (ancestry.status !== 0) {
      throw new GitWorkspaceError(
        "Expected integration commit is not an ancestor of the story HEAD",
      );
    }

    const changedPaths = parseChangedPaths(
      this.#safeRequired(worktreePath, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]),
    );
    if (changedPaths.length === 0) {
      throw new GitWorkspaceError(
        "Candidate worktree has no changes to commit",
      );
    }
    this.#mutate(worktreePath, ["add", "--all", "--", "."]);
    const staged = this.#safeRun(worktreePath, [
      "diff",
      "--cached",
      "--quiet",
      "--no-ext-diff",
    ]);
    if (staged.status !== 1) {
      throw new GitWorkspaceError(
        staged.status === 0
          ? "Candidate has no staged content after normalization"
          : "Unable to verify staged candidate content",
      );
    }
    this.#mutate(worktreePath, [
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "--cleanup=verbatim",
      "-m",
      message,
    ]);
    const commit = this.#required(worktreePath, ["rev-parse", "HEAD^{commit}"]);
    const parent = this.#required(worktreePath, [
      "rev-parse",
      "HEAD^1^{commit}",
    ]);
    const persistedMessage = this.#required(worktreePath, [
      "show",
      "-s",
      "--format=%B",
      commit,
    ]);
    if (persistedMessage !== message) {
      throw new GitWorkspaceError(
        "Candidate commit metadata changed during commit creation",
      );
    }
    if (parent !== request.expectedStoryHead) {
      throw new GitWorkspaceError(
        "Candidate commit parent does not match the expected story HEAD",
      );
    }
    const remaining = parseChangedPaths(
      this.#safeRequired(worktreePath, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]),
    );
    if (remaining.length > 0) {
      throw new GitWorkspaceError(
        "Candidate worktree is not clean after commit creation",
      );
    }
    return Object.freeze({
      status: "created",
      commit,
      parent,
      integrationHead: request.expectedIntegrationHead,
      changedPaths,
    });
  }

  mergeCandidate(request: MergeCandidateRequest): MergeCandidateResult {
    assertSafeWorkspaceId(request.operationId, "Merge operation id");
    assertSafeWorkspaceId(request.writerAgentId, "Writer agent id");
    assertSafeWorkspaceId(request.reviewerAgentId, "Reviewer agent id");
    if (request.integrationBranch !== integrationBranchForRun(request.runId)) {
      throw new GitWorkspaceError(
        "Merge integration branch does not match the run identity",
      );
    }
    if (
      request.storyBranch !== storyBranchForRun(request.runId, request.storyId)
    ) {
      throw new GitWorkspaceError(
        "Merge story branch does not match the story identity",
      );
    }
    if (
      !OBJECT_ID_PATTERN.test(request.reviewedIntegrationHead) ||
      !OBJECT_ID_PATTERN.test(request.candidateCommit)
    ) {
      throw new GitWorkspaceError("Merge commit evidence is invalid");
    }
    if (!request.writerLeaseReleased) {
      throw new GitWorkspaceError(
        "Merge requires the story writer lease to be released",
      );
    }
    const subject = validateCommitSubject(request.subject);
    const checkout = realpathSync(resolve(request.originalCheckout));
    const integrationPath = realpathSync(
      resolve(request.integrationWorktreePath),
    );
    const storyPath = realpathSync(resolve(request.storyWorktreePath));
    const worktrees = this.listWorktrees(checkout);
    const integrationWorktree = worktrees.find(
      (record) => record.path === integrationPath,
    );
    const storyWorktree = worktrees.find((record) => record.path === storyPath);
    if (
      integrationWorktree?.branch !== request.integrationBranch ||
      integrationWorktree.detached ||
      integrationWorktree.bare ||
      integrationWorktree.prunable
    ) {
      throw new GitWorkspaceError(
        "Merge target is not the registered integration worktree",
      );
    }
    if (
      storyWorktree?.branch !== request.storyBranch ||
      storyWorktree.head !== request.candidateCommit ||
      storyWorktree.detached ||
      storyWorktree.bare ||
      storyWorktree.prunable
    ) {
      throw new GitWorkspaceError(
        "Merge source is not the exact registered candidate worktree",
      );
    }
    this.#assertCleanWorktree(storyPath, "story");

    const policy = assessMergeEligibility({
      requesterRole: request.requesterRole,
      writerAgentId: request.writerAgentId,
      storyHead: request.candidateCommit,
      integrationHead: request.reviewedIntegrationHead,
      storyWorktreeClean: true,
      targetIsRunIntegrationBranch: true,
      targetIsDefaultOrProtected: request.targetIsDefaultOrProtected,
      protectedTargetUserApproval: request.protectedTargetUserApproval,
      controllerLeaseCurrent: request.controllerLeaseCurrent,
      expectedRevisionMatches: request.expectedRevisionMatches,
      review: {
        reviewerAgentId: request.reviewerAgentId,
        verdict: "approved",
        reviewedStoryHead: request.candidateCommit,
        reviewedIntegrationHead: request.reviewedIntegrationHead,
        requiredChecksPassed: request.requiredChecksPassed,
      },
    });
    if (!policy.allowed) {
      throw new GitWorkspaceError(
        `Merge policy denied integration: ${policy.reasons.join("; ")}`,
      );
    }

    const message = this.#mergeCommitMessage(request, subject);
    const currentIntegrationHead = this.#required(integrationPath, [
      "rev-parse",
      "HEAD^{commit}",
    ]);
    if (integrationWorktree.head !== currentIntegrationHead) {
      throw new GitWorkspaceError(
        "Integration worktree HEAD does not match its branch",
      );
    }
    if (currentIntegrationHead !== request.reviewedIntegrationHead) {
      return this.#recoverMergeCommit(
        request,
        integrationPath,
        currentIntegrationHead,
        message,
      );
    }

    const ancestry = this.#run(checkout, [
      "merge-base",
      "--is-ancestor",
      request.reviewedIntegrationHead,
      request.candidateCommit,
    ]);
    if (ancestry.status !== 0) {
      throw new GitWorkspaceError(
        "Reviewed integration commit is not an ancestor of the candidate",
      );
    }
    const preflight = this.#safeRun(checkout, [
      "merge-tree",
      "--write-tree",
      "--no-messages",
      request.reviewedIntegrationHead,
      request.candidateCommit,
    ]);
    if (preflight.status !== 0 || !OBJECT_ID_PATTERN.test(preflight.stdout)) {
      throw new GitWorkspaceError(
        "Candidate cannot be merged cleanly into the reviewed integration HEAD",
      );
    }
    const expectedTree = preflight.stdout;
    const interruptedMergeHead = this.#optional(integrationPath, [
      "rev-parse",
      "--verify",
      "MERGE_HEAD^{commit}",
    ]);
    if (interruptedMergeHead === null) {
      this.#assertCleanWorktree(integrationPath, "integration");
      this.#mutate(integrationPath, [
        "merge",
        "--no-ff",
        "--no-commit",
        "--no-edit",
        "--no-autostash",
        "--strategy=ort",
        request.candidateCommit,
      ]);
    } else if (interruptedMergeHead !== request.candidateCommit) {
      throw new GitWorkspaceError(
        "Integration worktree contains a different interrupted merge",
      );
    }
    const mergeIndexTree = this.#safeRequired(integrationPath, ["write-tree"]);
    if (mergeIndexTree !== expectedTree) {
      throw new GitWorkspaceError(
        "Interrupted merge index does not match the preflight merge tree",
      );
    }
    this.#mutate(integrationPath, [
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "--cleanup=verbatim",
      "-m",
      message,
    ]);
    const mergeCommit = this.#required(integrationPath, [
      "rev-parse",
      "HEAD^{commit}",
    ]);
    return this.#verifyMergeCommit(
      request,
      integrationPath,
      mergeCommit,
      message,
      expectedTree,
      "created",
    );
  }

  rollbackStoryWorkspace(request: RollbackStoryWorkspaceRequest): void {
    assertSafeWorkspaceId(request.runId, "Rollback run id");
    assertSafeWorkspaceId(request.storyId, "Rollback story id");
    if (
      request.storyBranch !== storyBranchForRun(request.runId, request.storyId)
    ) {
      throw new GitWorkspaceError(
        "Rollback story branch does not match the story identity",
      );
    }
    if (!OBJECT_ID_PATTERN.test(request.expectedStoryHead)) {
      throw new GitWorkspaceError("Rollback story head evidence is invalid");
    }
    const checkout = realpathSync(resolve(request.originalCheckout));
    const storyPath = resolve(request.storyWorktreePath);
    const worktrees = this.listWorktrees(checkout);
    const pathWorktree = worktrees.find((record) => record.path === storyPath);
    if (pathWorktree !== undefined) {
      if (
        pathWorktree.branch !== request.storyBranch ||
        pathWorktree.head !== request.expectedStoryHead ||
        pathWorktree.detached ||
        pathWorktree.bare ||
        pathWorktree.prunable ||
        pathWorktree.locked
      ) {
        throw new GitWorkspaceError(
          "Rollback story worktree identity is invalid",
        );
      }
      this.#assertCleanWorktree(storyPath, "Rollback story");
      this.#mutate(checkout, ["worktree", "remove", "--", storyPath]);
      if (
        this.listWorktrees(checkout).some(
          (record) =>
            record.path === storyPath || record.branch === request.storyBranch,
        ) ||
        existsSync(storyPath)
      ) {
        throw new GitWorkspaceError(
          "Git did not completely remove the rollback story worktree",
        );
      }
    } else if (existsSync(storyPath)) {
      throw new GitWorkspaceError(
        "Unregistered content exists at the rollback worktree path",
      );
    }
    const branchHead = this.#optional(checkout, [
      "rev-parse",
      "--verify",
      `refs/heads/${request.storyBranch}^{commit}`,
    ]);
    if (branchHead !== null) {
      if (branchHead !== request.expectedStoryHead) {
        throw new GitWorkspaceError("Rollback branch head identity is invalid");
      }
      this.#mutate(checkout, [
        "update-ref",
        "-d",
        `refs/heads/${request.storyBranch}`,
        request.expectedStoryHead,
      ]);
      if (
        this.#optional(checkout, [
          "rev-parse",
          "--verify",
          `refs/heads/${request.storyBranch}^{commit}`,
        ]) !== null
      ) {
        throw new GitWorkspaceError(
          "Git did not delete the rollback story branch",
        );
      }
    }
  }

  cleanupStoryWorkspace(
    request: CleanupStoryWorkspaceRequest,
  ): CleanupStoryWorkspaceResult {
    assertSafeWorkspaceId(request.operationId, "Cleanup operation id");
    assertSafeWorkspaceId(request.mergeOperationId, "Merge operation id");
    assertSafeWorkspaceId(request.reviewerAgentId, "Reviewer agent id");
    if (request.integrationBranch !== integrationBranchForRun(request.runId)) {
      throw new GitWorkspaceError(
        "Cleanup integration branch does not match the run identity",
      );
    }
    if (
      request.storyBranch !== storyBranchForRun(request.runId, request.storyId)
    ) {
      throw new GitWorkspaceError(
        "Cleanup story branch does not match the story identity",
      );
    }
    if (
      !OBJECT_ID_PATTERN.test(request.candidateCommit) ||
      !OBJECT_ID_PATTERN.test(request.reviewedIntegrationHead) ||
      !OBJECT_ID_PATTERN.test(request.mergeCommit)
    ) {
      throw new GitWorkspaceError("Cleanup commit evidence is invalid");
    }
    const mergeSubject = validateCommitSubject(request.mergeSubject);
    const checkout = realpathSync(resolve(request.originalCheckout));
    const integrationPath = realpathSync(
      resolve(request.integrationWorktreePath),
    );
    const storyRequestedPath = resolve(request.storyWorktreePath);
    const storyPath = existsSync(storyRequestedPath)
      ? realpathSync(storyRequestedPath)
      : storyRequestedPath;
    const worktrees = this.listWorktrees(checkout);
    const integrationWorktree = worktrees.find(
      (record) => record.path === integrationPath,
    );
    const currentIntegrationHead = this.#required(integrationPath, [
      "rev-parse",
      "HEAD^{commit}",
    ]);
    if (
      integrationWorktree?.branch !== request.integrationBranch ||
      integrationWorktree.head !== currentIntegrationHead ||
      integrationWorktree.detached ||
      integrationWorktree.bare ||
      integrationWorktree.prunable
    ) {
      throw new GitWorkspaceError(
        "Cleanup integration worktree identity is invalid",
      );
    }

    const expectedMergeMessage = `${mergeSubject}\n\nAgentworks-Run: ${request.runId}\nAgentworks-Story: ${request.storyId}\nAgentworks-Candidate: ${request.candidateCommit}\nAgentworks-Integration: ${request.reviewedIntegrationHead}\nAgentworks-Reviewer: ${request.reviewerAgentId}\nAgentworks-Operation: ${request.mergeOperationId}`;
    const mergeParents = this.#required(checkout, [
      "show",
      "-s",
      "--format=%P",
      request.mergeCommit,
    ]).split(" ");
    const mergeMessage = this.#required(checkout, [
      "show",
      "-s",
      "--format=%B",
      request.mergeCommit,
    ]);
    if (
      mergeParents.length !== 2 ||
      mergeParents[0] !== request.reviewedIntegrationHead ||
      mergeParents[1] !== request.candidateCommit ||
      mergeMessage !== expectedMergeMessage
    ) {
      throw new GitWorkspaceError(
        "Cleanup merge evidence is not owned by the expected operation",
      );
    }
    const ancestry = this.#run(checkout, [
      "merge-base",
      "--is-ancestor",
      request.mergeCommit,
      currentIntegrationHead,
    ]);
    const storyMergedIntoIntegration = ancestry.status === 0;

    const branchWorktree = worktrees.find(
      (record) => record.branch === request.storyBranch,
    );
    const pathWorktree = worktrees.find((record) => record.path === storyPath);
    if (branchWorktree?.path !== pathWorktree?.path) {
      throw new GitWorkspaceError(
        "Cleanup story branch and worktree registration do not match",
      );
    }
    if (
      pathWorktree !== undefined &&
      (pathWorktree.branch !== request.storyBranch ||
        pathWorktree.head !== request.candidateCommit ||
        pathWorktree.detached ||
        pathWorktree.bare ||
        pathWorktree.prunable ||
        pathWorktree.locked)
    ) {
      throw new GitWorkspaceError("Cleanup story worktree identity is invalid");
    }
    if (pathWorktree === undefined && existsSync(storyPath)) {
      throw new GitWorkspaceError(
        "Unregistered content exists at the cleanup worktree path",
      );
    }
    const branchHead = this.#optional(checkout, [
      "rev-parse",
      "--verify",
      `refs/heads/${request.storyBranch}^{commit}`,
    ]);
    if (branchHead !== null && branchHead !== request.candidateCommit) {
      throw new GitWorkspaceError(
        "Cleanup story branch no longer points to the reviewed candidate",
      );
    }
    if (pathWorktree !== undefined && branchHead === null) {
      throw new GitWorkspaceError(
        "Cleanup story worktree has lost its branch reference",
      );
    }

    let worktreeClean = true;
    if (pathWorktree !== undefined) {
      const changes = parseChangedPaths(
        this.#safeRequired(storyPath, [
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
          "--ignore-submodules=none",
        ]),
        true,
      );
      worktreeClean = changes.length === 0;
    }
    const policy = assessCleanupEligibility({
      controllerLeaseCurrent: request.controllerLeaseCurrent,
      expectedRevisionMatches: request.expectedRevisionMatches,
      worktreeClean,
      storyMergedIntoIntegration,
      writerLeaseReleased: request.writerLeaseReleased,
      agentClosed: request.agentClosed,
      worktreeBelongsToRun: true,
    });
    if (!policy.allowed) {
      throw new GitWorkspaceError(
        `Cleanup policy denied removal: ${policy.reasons.join("; ")}`,
      );
    }

    const hadWorktree = pathWorktree !== undefined;
    const hadBranch = branchHead !== null;
    if (hadWorktree) {
      this.#mutate(checkout, ["worktree", "remove", "--", storyPath]);
      const remainingWorktree = this.listWorktrees(checkout).find(
        (record) =>
          record.path === storyPath || record.branch === request.storyBranch,
      );
      if (remainingWorktree !== undefined || existsSync(storyPath)) {
        throw new GitWorkspaceError(
          "Git did not completely remove the story worktree",
        );
      }
    }
    if (hadBranch) {
      this.#mutate(checkout, [
        "update-ref",
        "-d",
        `refs/heads/${request.storyBranch}`,
        request.candidateCommit,
      ]);
      if (
        this.#optional(checkout, [
          "rev-parse",
          "--verify",
          `refs/heads/${request.storyBranch}^{commit}`,
        ]) !== null
      ) {
        throw new GitWorkspaceError(
          "Git did not delete the exact story branch",
        );
      }
    }
    return Object.freeze({
      status: hadWorktree ? "removed" : hadBranch ? "recovered" : "existing",
      worktreeAbsent: true,
      branchAbsent: true,
      mergeCommit: request.mergeCommit,
    });
  }

  #assertCleanWorktree(worktreePath: string, label: string): void {
    const changed = parseChangedPaths(
      this.#safeRequired(worktreePath, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]),
    );
    if (changed.length > 0) {
      throw new GitWorkspaceError(`${label} worktree is not clean`);
    }
  }

  #mergeCommitMessage(request: MergeCandidateRequest, subject: string): string {
    return `${subject}\n\nAgentworks-Run: ${request.runId}\nAgentworks-Story: ${request.storyId}\nAgentworks-Candidate: ${request.candidateCommit}\nAgentworks-Integration: ${request.reviewedIntegrationHead}\nAgentworks-Reviewer: ${request.reviewerAgentId}\nAgentworks-Operation: ${request.operationId}`;
  }

  #recoverMergeCommit(
    request: MergeCandidateRequest,
    integrationPath: string,
    currentIntegrationHead: string,
    expectedMessage: string,
  ): MergeCandidateResult {
    return this.#verifyMergeCommit(
      request,
      integrationPath,
      currentIntegrationHead,
      expectedMessage,
      null,
      "existing",
    );
  }

  #verifyMergeCommit(
    request: MergeCandidateRequest,
    integrationPath: string,
    mergeCommit: string,
    expectedMessage: string,
    expectedTree: string | null,
    status: MergeCandidateResult["status"],
  ): MergeCandidateResult {
    const parents = this.#required(integrationPath, [
      "show",
      "-s",
      "--format=%P",
      mergeCommit,
    ]).split(" ");
    const message = this.#required(integrationPath, [
      "show",
      "-s",
      "--format=%B",
      mergeCommit,
    ]);
    const tree = this.#required(integrationPath, [
      "show",
      "-s",
      "--format=%T",
      mergeCommit,
    ]);
    if (
      parents.length !== 2 ||
      parents[0] !== request.reviewedIntegrationHead ||
      parents[1] !== request.candidateCommit ||
      message !== expectedMessage ||
      (expectedTree !== null && tree !== expectedTree)
    ) {
      throw new GitWorkspaceError(
        "Integration branch advanced to a merge not owned by this operation",
      );
    }
    this.#assertCleanWorktree(integrationPath, "integration");
    return Object.freeze({
      status,
      mergeCommit,
      integrationParent: request.reviewedIntegrationHead,
      candidateParent: request.candidateCommit,
      tree,
    });
  }

  #candidateCommitMessage(
    request: CreateCandidateCommitRequest,
    subject: string,
  ): string {
    return `${subject}\n\nAgentworks-Run: ${request.runId}\nAgentworks-Story: ${request.storyId}\nAgentworks-Base: ${request.expectedStoryHead}\nAgentworks-Integration: ${request.expectedIntegrationHead}\nAgentworks-Operation: ${request.operationId}`;
  }

  #recoverCandidateCommit(
    request: CreateCandidateCommitRequest,
    worktreePath: string,
    currentStoryHead: string,
    expectedMessage: string,
  ): CandidateCommitResult {
    const parent = this.#optional(worktreePath, [
      "rev-parse",
      "--verify",
      `${currentStoryHead}^1^{commit}`,
    ]);
    const message = this.#required(worktreePath, [
      "show",
      "-s",
      "--format=%B",
      currentStoryHead,
    ]);
    if (parent !== request.expectedStoryHead || message !== expectedMessage) {
      throw new GitWorkspaceError(
        "Story branch advanced to a commit not owned by this candidate operation",
      );
    }
    const remaining = parseChangedPaths(
      this.#safeRequired(worktreePath, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]),
    );
    if (remaining.length > 0) {
      throw new GitWorkspaceError(
        "Recovered candidate worktree contains changes after its commit",
      );
    }
    const changedPaths = Object.freeze(
      this.#required(worktreePath, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        currentStoryHead,
      ])
        .split("\0")
        .filter((path) => path.length > 0)
        .sort(),
    );
    return Object.freeze({
      status: "existing",
      commit: currentStoryHead,
      parent,
      integrationHead: request.expectedIntegrationHead,
      changedPaths,
    });
  }

  #createWorkspace(command: CreateWorkspaceCommand): GitWorkspaceResult {
    const checkout = realpathSync(resolve(command.checkout));
    const repositoryRoot = realpathSync(resolve(command.repositoryRoot));
    const commonGitDirectory = realpathSync(
      resolve(command.commonGitDirectory),
    );
    if (checkout !== repositoryRoot) {
      throw new GitWorkspaceError(
        `${command.label} worktree creation must originate from the original checkout root`,
      );
    }
    this.#validateBranch(checkout, command.baseBranch);
    this.#validateBranch(checkout, command.branch);
    if (!OBJECT_ID_PATTERN.test(command.expectedBaseHead)) {
      throw new GitWorkspaceError(
        `Expected ${command.label.toLowerCase()} base HEAD is invalid`,
      );
    }

    const worktrees = this.listWorktrees(checkout);
    const worktreePath = this.#prepareWorktreePath(
      command.worktreePath,
      repositoryRoot,
      commonGitDirectory,
      worktrees,
    );
    const branchWorktree = worktrees.find(
      (worktree) => worktree.branch === command.branch,
    );
    const pathWorktree = worktrees.find(
      (worktree) => worktree.path === worktreePath,
    );
    if (branchWorktree !== undefined && branchWorktree.path !== worktreePath) {
      throw new GitWorkspaceError(
        `${command.label} branch is already attached at ${branchWorktree.path}`,
      );
    }
    if (pathWorktree !== undefined && pathWorktree.branch !== command.branch) {
      throw new GitWorkspaceError(
        `${command.label} worktree path is registered to another branch`,
      );
    }

    const branchHead = this.#optional(checkout, [
      "rev-parse",
      "--verify",
      `refs/heads/${command.branch}^{commit}`,
    ]);
    if (branchWorktree !== undefined && pathWorktree !== undefined) {
      if (branchHead === null || branchWorktree.head !== branchHead) {
        throw new GitWorkspaceError(
          `Existing ${command.label.toLowerCase()} worktree identity is inconsistent`,
        );
      }
      return Object.freeze({
        status: "existing",
        branch: command.branch,
        branchHead,
        worktreePath,
      });
    }

    if (existsSync(worktreePath)) {
      throw new GitWorkspaceError(
        `Unregistered ${command.label.toLowerCase()} worktree path already exists`,
      );
    }

    let status: GitWorkspaceResult["status"];
    if (branchHead !== null) {
      if (branchHead !== command.expectedBaseHead) {
        throw new GitWorkspaceError(
          `Unattached ${command.label.toLowerCase()} branch does not match the expected base HEAD`,
        );
      }
      this.#mutate(checkout, ["worktree", "add", worktreePath, command.branch]);
      status = "recovered";
    } else {
      const baseHead = this.#required(checkout, [
        "rev-parse",
        "--verify",
        `refs/heads/${command.baseBranch}^{commit}`,
      ]);
      if (
        baseHead !== command.expectedBaseHead &&
        command.allowBaseBranchAdvance !== true
      ) {
        throw new GitWorkspaceError(
          `${command.label} base branch HEAD changed before worktree creation`,
        );
      }
      this.#mutate(checkout, [
        "worktree",
        "add",
        "-b",
        command.branch,
        worktreePath,
        command.expectedBaseHead,
      ]);
      status = "created";
    }

    const verified = this.listWorktrees(checkout).find(
      (worktree) =>
        worktree.path === worktreePath && worktree.branch === command.branch,
    );
    const verifiedHead = this.#required(checkout, [
      "rev-parse",
      "--verify",
      `refs/heads/${command.branch}^{commit}`,
    ]);
    if (verified?.head !== verifiedHead) {
      throw new GitWorkspaceError(
        `Created ${command.label.toLowerCase()} worktree failed identity verification`,
      );
    }
    return Object.freeze({
      status,
      branch: command.branch,
      branchHead: verifiedHead,
      worktreePath,
    });
  }

  #prepareWorktreePath(
    requestedPath: string,
    repositoryRoot: string,
    commonGitDirectory: string,
    worktrees: readonly GitWorktreeRecord[],
  ): string {
    const normalized = resolve(requestedPath);
    if (
      isWithin(normalized, repositoryRoot) ||
      isWithin(normalized, commonGitDirectory)
    ) {
      throw new GitWorkspaceError(
        "Worktree must be outside the original checkout and Git metadata",
      );
    }
    for (const worktree of worktrees) {
      if (
        normalized !== worktree.path &&
        (isWithin(normalized, worktree.path) ||
          isWithin(worktree.path, normalized))
      ) {
        throw new GitWorkspaceError(
          "Worktree path cannot contain or be nested within another worktree",
        );
      }
    }
    const parent = dirname(normalized);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStatus = lstatSync(parent);
    if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
      throw new GitWorkspaceError("Worktree parent must be a real directory");
    }
    const realParent = realpathSync(parent);
    if (realParent !== resolve(parent)) {
      throw new GitWorkspaceError(
        "Worktree parent cannot traverse symbolic links",
      );
    }
    return resolve(realParent, basename(normalized));
  }

  #validateBranch(repositoryPath: string, branch: string): void {
    const result = this.#run(repositoryPath, [
      "check-ref-format",
      "--branch",
      branch,
    ]);
    if (result.status !== 0 || result.stdout !== branch) {
      throw new GitWorkspaceError(`Invalid Git branch ${branch}`, [
        "check-ref-format",
        "--branch",
        branch,
      ]);
    }
  }

  #safeMutationConfiguration(repositoryPath: string): readonly string[] {
    const configurationKeys = this.#optional(repositoryPath, [
      "config",
      "--name-only",
      "--get-regexp",
      "^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver|branch\\..*\\.mergeoptions)$",
    ]);
    const filterPrefixes = new Set<string>();
    const mergePrefixes = new Set<string>();
    const branchMergeOptions = new Set<string>();
    if (configurationKeys !== null) {
      for (const key of configurationKeys.split("\n")) {
        const normalized = key.trim();
        const filter =
          /^(filter\..+)\.(?:clean|smudge|process|required)$/u.exec(normalized);
        if (filter?.[1] !== undefined) filterPrefixes.add(filter[1]);
        const merge = /^(merge\..+)\.driver$/u.exec(normalized);
        if (merge?.[1] !== undefined) mergePrefixes.add(merge[1]);
        if (/^branch\..+\.mergeoptions$/u.test(normalized)) {
          branchMergeOptions.add(normalized);
        }
      }
    }
    const configuration = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "rerere.enabled=false",
      "-c",
      "protocol.file.allow=never",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "-c",
      "user.name=Agentworks Controller",
      "-c",
      "user.email=controller@agentworks.invalid",
    ];
    for (const prefix of filterPrefixes) {
      configuration.push(
        "-c",
        `${prefix}.required=false`,
        "-c",
        `${prefix}.process=`,
        "-c",
        `${prefix}.smudge=/usr/bin/cat`,
        "-c",
        `${prefix}.clean=/usr/bin/cat`,
      );
    }
    for (const prefix of mergePrefixes) {
      configuration.push("-c", `${prefix}.driver=/usr/bin/false`);
    }
    for (const key of branchMergeOptions) {
      configuration.push("-c", `${key}=`);
    }
    return Object.freeze(configuration);
  }

  #safeRun(
    repositoryPath: string,
    arguments_: readonly string[],
  ): GitCommandResult {
    return this.#run(repositoryPath, [
      ...this.#safeMutationConfiguration(repositoryPath),
      ...arguments_,
    ]);
  }

  #safeRequired(repositoryPath: string, arguments_: readonly string[]): string {
    const result = this.#safeRun(repositoryPath, arguments_);
    if (result.status !== 0) {
      throw new GitWorkspaceError(
        `Safe Git operation failed: ${result.stderr || "unknown Git error"}`,
        arguments_,
      );
    }
    return result.stdout;
  }

  #mutate(repositoryPath: string, arguments_: readonly string[]): string {
    return this.#safeRequired(repositoryPath, arguments_);
  }

  #required(repositoryPath: string, arguments_: readonly string[]): string {
    const result = this.#run(repositoryPath, arguments_);
    if (result.status !== 0) {
      throw new GitWorkspaceError(
        `Git workspace operation failed: ${result.stderr || "unknown Git error"}`,
        arguments_,
      );
    }
    return result.stdout;
  }

  #optional(
    repositoryPath: string,
    arguments_: readonly string[],
  ): string | null {
    const result = this.#run(repositoryPath, arguments_);
    if (result.status === 0) return result.stdout;
    if (result.status === 1 || result.status === 128) return null;
    throw new GitWorkspaceError(
      `Git workspace inspection failed: ${result.stderr || "unknown Git error"}`,
      arguments_,
    );
  }

  #run(
    repositoryPath: string,
    arguments_: readonly string[],
  ): GitCommandResult {
    const command = ["-C", repositoryPath, ...arguments_];
    const result = spawnSync(this.#gitPath, command, {
      encoding: "utf8",
      timeout: this.#timeoutMs,
      maxBuffer: this.#maxOutputBytes,
      shell: false,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
    });
    if (result.error !== undefined) {
      throw new GitWorkspaceError(
        `Unable to execute Git: ${result.error.message}`,
        command,
      );
    }
    return Object.freeze({
      status: result.status ?? 1,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    });
  }
}
