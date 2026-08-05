import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  GitRemote,
  GitRepositoryInspection,
  GitRepositoryInspector,
} from "../../application/ports/git-repository-inspector.ts";

const DEFAULT_GIT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export class GitRepositoryInspectionError extends Error {
  readonly command: readonly string[];

  constructor(message: string, command: readonly string[]) {
    super(message);
    this.name = "GitRepositoryInspectionError";
    this.command = command;
  }
}

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCliRepositoryInspectorOptions {
  readonly gitPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitRepositoryInspectionError(`${label} must be positive`, []);
  }
  return value;
}

function lines(value: string): readonly string[] {
  if (value.length === 0) return [];
  return Object.freeze(
    value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (url.username.length > 0 || url.password.length > 0) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return value.replace(/^(\w+:\/\/)[^/@]+@/u, "$1");
  }
}

export class GitCliRepositoryInspector implements GitRepositoryInspector {
  readonly #gitPath: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: GitCliRepositoryInspectorOptions = {}) {
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

  inspect(path: string): GitRepositoryInspection {
    const requestedPath = realpathSync(resolve(path));
    const bare = this.#required(requestedPath, [
      "rev-parse",
      "--is-bare-repository",
    ]);
    if (bare !== "true" && bare !== "false") {
      throw new GitRepositoryInspectionError(
        "Git returned an invalid bare-repository result",
        ["rev-parse", "--is-bare-repository"],
      );
    }

    const repositoryRoot =
      bare === "true"
        ? null
        : this.#required(requestedPath, [
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
          ]);
    const gitDirectory = this.#required(requestedPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]);
    const commonGitDirectory = this.#required(requestedPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const currentBranch = this.#optional(requestedPath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const headCommit = this.#optional(requestedPath, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const localBranches = [
      ...lines(
        this.#required(requestedPath, [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
        ]),
      ),
    ].sort((left, right) => left.localeCompare(right));
    const remoteNames = [
      ...lines(this.#required(requestedPath, ["remote"])),
    ].sort((left, right) => left.localeCompare(right));
    const remotes = remoteNames.map((name) =>
      this.#readRemote(requestedPath, name),
    );
    const defaultBranch = this.#detectDefaultBranch(
      requestedPath,
      localBranches,
      remoteNames,
    );
    const protectedPatterns = lines(
      this.#optional(requestedPath, [
        "config",
        "--get-all",
        "agentworks.protectedBranch",
      ]) ?? "",
    );
    const objectFormat = this.#required(requestedPath, [
      "rev-parse",
      "--show-object-format",
    ]);
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      throw new GitRepositoryInspectionError(
        "Git returned an unsupported object format",
        ["rev-parse", "--show-object-format"],
      );
    }

    return Object.freeze({
      requestedPath,
      repositoryRoot:
        repositoryRoot === null ? null : realpathSync(repositoryRoot),
      gitDirectory: realpathSync(gitDirectory),
      commonGitDirectory: realpathSync(commonGitDirectory),
      bare: bare === "true",
      currentBranch,
      headCommit,
      localBranches: Object.freeze(localBranches),
      defaultBranch: defaultBranch.branch,
      defaultBranchSource: defaultBranch.source,
      remotes: Object.freeze(remotes),
      repositoryProtectedPatterns: Object.freeze(protectedPatterns),
      objectFormat,
    });
  }

  assertBranchExists(
    inspection: GitRepositoryInspection,
    branch: string,
  ): void {
    if (!inspection.localBranches.includes(branch)) {
      throw new GitRepositoryInspectionError(
        `Local branch ${branch} does not exist`,
        ["show-ref", "--verify", `refs/heads/${branch}`],
      );
    }
  }

  #detectDefaultBranch(
    repositoryPath: string,
    localBranches: readonly string[],
    remoteNames: readonly string[],
  ): {
    readonly branch: string | null;
    readonly source: GitRepositoryInspection["defaultBranchSource"];
  } {
    const configuredRemote = this.#optional(repositoryPath, [
      "config",
      "--get",
      "checkout.defaultRemote",
    ]);
    const defaultRemote =
      configuredRemote !== null && remoteNames.includes(configuredRemote)
        ? configuredRemote
        : remoteNames.includes("origin")
          ? "origin"
          : remoteNames.length === 1
            ? remoteNames[0]
            : null;
    if (defaultRemote !== null && defaultRemote !== undefined) {
      const reference = this.#optional(repositoryPath, [
        "symbolic-ref",
        "--quiet",
        `refs/remotes/${defaultRemote}/HEAD`,
      ]);
      const prefix = `refs/remotes/${defaultRemote}/`;
      if (reference?.startsWith(prefix)) {
        return Object.freeze({
          branch: reference.slice(prefix.length),
          source: "remote-head",
        });
      }
    }

    for (const conventional of ["main", "master", "trunk"]) {
      if (localBranches.includes(conventional)) {
        return Object.freeze({
          branch: conventional,
          source: "conventional-local-branch",
        });
      }
    }
    if (localBranches.length === 1) {
      return Object.freeze({
        branch: localBranches[0] ?? null,
        source: "single-local-branch",
      });
    }
    return Object.freeze({ branch: null, source: null });
  }

  #readRemote(repositoryPath: string, name: string): GitRemote {
    const fetchUrl = this.#optional(repositoryPath, [
      "config",
      "--get",
      `remote.${name}.url`,
    ]);
    const pushUrl = this.#optional(repositoryPath, [
      "config",
      "--get",
      `remote.${name}.pushurl`,
    ]);
    return Object.freeze({
      name,
      fetchUrl: fetchUrl === null ? null : redactUrlCredentials(fetchUrl),
      pushUrl: pushUrl === null ? null : redactUrlCredentials(pushUrl),
    });
  }

  #required(repositoryPath: string, arguments_: readonly string[]): string {
    const result = this.#run(repositoryPath, arguments_);
    if (result.status !== 0) {
      throw new GitRepositoryInspectionError(
        `Git repository inspection failed: ${result.stderr || "unknown Git error"}`,
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
    throw new GitRepositoryInspectionError(
      `Git repository inspection failed: ${result.stderr || "unknown Git error"}`,
      arguments_,
    );
  }

  #run(repositoryPath: string, arguments_: readonly string[]): GitResult {
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
      throw new GitRepositoryInspectionError(
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
