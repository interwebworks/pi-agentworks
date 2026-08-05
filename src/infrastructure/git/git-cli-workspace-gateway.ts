import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  CreateIntegrationWorkspaceRequest,
  GitWorkspaceGateway,
  GitWorktreeRecord,
  IntegrationWorkspaceResult,
} from "../../application/ports/git-workspace-gateway.ts";
import { integrationBranchForRun } from "../../domain/workspace-naming.ts";

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
  ): IntegrationWorkspaceResult {
    const checkout = realpathSync(resolve(request.originalCheckout));
    const repositoryRoot = realpathSync(resolve(request.repositoryRoot));
    const commonGitDirectory = realpathSync(
      resolve(request.commonGitDirectory),
    );
    if (checkout !== repositoryRoot) {
      throw new GitWorkspaceError(
        "Integration worktree creation must originate from the original checkout root",
      );
    }
    if (request.integrationBranch !== integrationBranchForRun(request.runId)) {
      throw new GitWorkspaceError(
        "Integration branch does not match the run identity",
      );
    }
    this.#validateBranch(checkout, request.baseBranch);
    this.#validateBranch(checkout, request.integrationBranch);
    if (!OBJECT_ID_PATTERN.test(request.expectedBaseHead)) {
      throw new GitWorkspaceError("Expected base HEAD is invalid");
    }

    const worktreePath = this.#prepareWorktreePath(
      request.worktreePath,
      repositoryRoot,
      commonGitDirectory,
    );
    const worktrees = this.listWorktrees(checkout);
    const branchWorktree = worktrees.find(
      (worktree) => worktree.branch === request.integrationBranch,
    );
    const pathWorktree = worktrees.find(
      (worktree) => worktree.path === worktreePath,
    );
    if (branchWorktree !== undefined && branchWorktree.path !== worktreePath) {
      throw new GitWorkspaceError(
        `Integration branch is already attached at ${branchWorktree.path}`,
      );
    }
    if (
      pathWorktree !== undefined &&
      pathWorktree.branch !== request.integrationBranch
    ) {
      throw new GitWorkspaceError(
        "Integration worktree path is registered to another branch",
      );
    }

    const integrationHead = this.#optional(checkout, [
      "rev-parse",
      "--verify",
      `refs/heads/${request.integrationBranch}^{commit}`,
    ]);
    if (branchWorktree !== undefined && pathWorktree !== undefined) {
      if (integrationHead === null || branchWorktree.head !== integrationHead) {
        throw new GitWorkspaceError(
          "Existing integration worktree identity is inconsistent",
        );
      }
      return Object.freeze({
        status: "existing",
        branch: request.integrationBranch,
        branchHead: integrationHead,
        worktreePath,
      });
    }

    if (existsSync(worktreePath)) {
      throw new GitWorkspaceError(
        "Unregistered integration worktree path already exists",
      );
    }

    let status: IntegrationWorkspaceResult["status"];
    if (integrationHead !== null) {
      if (integrationHead !== request.expectedBaseHead) {
        throw new GitWorkspaceError(
          "Unattached integration branch does not match the expected base HEAD",
        );
      }
      this.#mutate(checkout, [
        "worktree",
        "add",
        worktreePath,
        request.integrationBranch,
      ]);
      status = "recovered";
    } else {
      const baseHead = this.#required(checkout, [
        "rev-parse",
        "--verify",
        `refs/heads/${request.baseBranch}^{commit}`,
      ]);
      if (baseHead !== request.expectedBaseHead) {
        throw new GitWorkspaceError(
          "Base branch HEAD changed before integration worktree creation",
        );
      }
      this.#mutate(checkout, [
        "worktree",
        "add",
        "-b",
        request.integrationBranch,
        worktreePath,
        request.expectedBaseHead,
      ]);
      status = "created";
    }

    const verified = this.listWorktrees(checkout).find(
      (worktree) =>
        worktree.path === worktreePath &&
        worktree.branch === request.integrationBranch,
    );
    const verifiedHead = this.#required(checkout, [
      "rev-parse",
      "--verify",
      `refs/heads/${request.integrationBranch}^{commit}`,
    ]);
    if (verified?.head !== verifiedHead) {
      throw new GitWorkspaceError(
        "Created integration worktree failed identity verification",
      );
    }
    return Object.freeze({
      status,
      branch: request.integrationBranch,
      branchHead: verifiedHead,
      worktreePath,
    });
  }

  #prepareWorktreePath(
    requestedPath: string,
    repositoryRoot: string,
    commonGitDirectory: string,
  ): string {
    const normalized = resolve(requestedPath);
    if (
      isWithin(normalized, repositoryRoot) ||
      isWithin(normalized, commonGitDirectory)
    ) {
      throw new GitWorkspaceError(
        "Integration worktree must be outside the original checkout and Git metadata",
      );
    }
    const parent = dirname(normalized);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStatus = lstatSync(parent);
    if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
      throw new GitWorkspaceError(
        "Integration worktree parent must be a real directory",
      );
    }
    const realParent = realpathSync(parent);
    if (realParent !== resolve(parent)) {
      throw new GitWorkspaceError(
        "Integration worktree parent cannot traverse symbolic links",
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
