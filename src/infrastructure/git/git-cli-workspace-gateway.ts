import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  CreateIntegrationWorkspaceRequest,
  CreateStoryWorkspaceRequest,
  GitWorkspaceGateway,
  GitWorktreeRecord,
  GitWorkspaceResult,
} from "../../application/ports/git-workspace-gateway.ts";
import {
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
      if (baseHead !== command.expectedBaseHead) {
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
    const filterKeys = this.#optional(repositoryPath, [
      "config",
      "--local",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ]);
    const prefixes = new Set<string>();
    if (filterKeys !== null) {
      for (const key of filterKeys.split("\n")) {
        const match = /^(filter\..+)\.(?:clean|smudge|process|required)$/u.exec(
          key.trim(),
        );
        if (match?.[1] !== undefined) prefixes.add(match[1]);
      }
    }
    const configuration = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.file.allow=never",
    ];
    for (const prefix of prefixes) {
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
    return Object.freeze(configuration);
  }

  #mutate(repositoryPath: string, arguments_: readonly string[]): string {
    return this.#required(repositoryPath, [
      ...this.#safeMutationConfiguration(repositoryPath),
      ...arguments_,
    ]);
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
