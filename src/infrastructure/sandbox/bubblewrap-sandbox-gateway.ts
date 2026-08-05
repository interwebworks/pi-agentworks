import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  SandboxCommandPlan,
  SandboxGateway,
  SandboxLaunchRequest,
} from "../../application/ports/sandbox-gateway.ts";
import type { ProductionSandboxLaunchGate } from "../../application/sandbox/production-sandbox-launch-gate.ts";

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_ARGUMENT_COUNT = 4_096;
const MAX_ARGUMENT_LENGTH = 64 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 256;
const RESERVED_ENVIRONMENT = new Set([
  "HOME",
  "LOGNAME",
  "PATH",
  "PWD",
  "TMPDIR",
  "USER",
]);

export class BubblewrapSandboxConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BubblewrapSandboxConfigurationError";
  }
}

function isWithin(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function canonicalExistingPath(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new BubblewrapSandboxConfigurationError(`${label} must be absolute`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(resolve(path));
  } catch (error) {
    throw new BubblewrapSandboxConfigurationError(
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return canonical;
}

function assertDirectory(path: string, label: string): void {
  if (!statSync(path).isDirectory()) {
    throw new BubblewrapSandboxConfigurationError(
      `${label} must be a directory`,
    );
  }
}

function validateArgument(value: string, label: string): string {
  if (value.length > MAX_ARGUMENT_LENGTH || value.includes("\0")) {
    throw new BubblewrapSandboxConfigurationError(`${label} is invalid`);
  }
  return value;
}

export class BubblewrapSandboxGateway implements SandboxGateway {
  readonly #gate: ProductionSandboxLaunchGate;

  constructor(gate: ProductionSandboxLaunchGate) {
    this.#gate = gate;
  }

  plan(request: SandboxLaunchRequest): SandboxCommandPlan {
    const capabilities = this.#gate.assertAvailable();
    if (
      capabilities.executablePath === null ||
      capabilities.evidence === null
    ) {
      throw new BubblewrapSandboxConfigurationError(
        "Bubblewrap capability report is incomplete",
      );
    }
    if (request.arguments.length > MAX_ARGUMENT_COUNT) {
      throw new BubblewrapSandboxConfigurationError(
        "Sandbox command has too many arguments",
      );
    }

    const command = canonicalExistingPath(request.command, "sandbox command");
    accessSync(command, constants.X_OK);
    if (!statSync(command).isFile()) {
      throw new BubblewrapSandboxConfigurationError(
        "sandbox command must be a regular file",
      );
    }
    const commandArguments = request.arguments.map((argument, index) =>
      validateArgument(argument, `sandbox argument ${String(index)}`),
    );
    const worktree = canonicalExistingPath(
      request.assignedWorktreePath,
      "assigned worktree",
    );
    const session = canonicalExistingPath(request.sessionPath, "session path");
    const runtime = canonicalExistingPath(request.runtimePath, "runtime path");
    assertDirectory(worktree, "assigned worktree");
    assertDirectory(session, "session path");
    assertDirectory(runtime, "runtime path");
    if (isWithin(command, worktree)) {
      throw new BubblewrapSandboxConfigurationError(
        "sandbox command cannot come from the untrusted worktree",
      );
    }
    if (isWithin(worktree, session) || isWithin(session, worktree)) {
      throw new BubblewrapSandboxConfigurationError(
        "assigned worktree and session path cannot overlap",
      );
    }

    const gitMetadata = this.#canonicalUniquePaths(
      request.gitMetadataPaths,
      "Git metadata",
    );
    const readOnly = this.#canonicalUniquePaths(
      [...request.readOnlyPaths, runtime, command],
      "read-only resource",
    );
    if (gitMetadata.length === 0) {
      throw new BubblewrapSandboxConfigurationError(
        "at least one Git metadata path is required",
      );
    }
    const worktreeGitMarker = canonicalExistingPath(
      join(worktree, ".git"),
      "assigned worktree Git marker",
    );
    if (!gitMetadata.includes(worktreeGitMarker)) {
      throw new BubblewrapSandboxConfigurationError(
        "Git metadata must include the assigned worktree .git boundary",
      );
    }
    for (const path of [...gitMetadata, ...readOnly]) {
      if (path === worktree || path === session) {
        throw new BubblewrapSandboxConfigurationError(
          "read-only resources cannot replace a writable boundary",
        );
      }
      if (isWithin(worktree, path) || isWithin(session, path)) {
        throw new BubblewrapSandboxConfigurationError(
          "a read-only parent cannot contain a writable boundary",
        );
      }
    }

    const childEnvironment = this.#environment(request.environment, worktree);
    const arguments_: string[] = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--disable-userns",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--unshare-cgroup-try",
      "--cap-drop",
      "ALL",
    ];
    if (request.networkPolicy === "isolated") arguments_.push("--unshare-net");
    const userHome = homedir();
    const homeMask = userHome.startsWith("/home/") ? "/home" : userHome;
    arguments_.push(
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--perms",
      "1777",
      "--tmpfs",
      "/tmp",
      "--perms",
      "1777",
      "--tmpfs",
      "/var/tmp",
      "--perms",
      "0755",
      "--tmpfs",
      "/run",
      "--perms",
      "0700",
      "--tmpfs",
      homeMask,
      "--perms",
      "0700",
      "--dir",
      userHome,
    );
    for (const path of ["/media", "/mnt"]) {
      if (existsSync(path)) arguments_.push("--tmpfs", path);
    }
    arguments_.push(
      request.worktreeAccess === "read-write" ? "--bind" : "--ro-bind",
      worktree,
      worktree,
      "--bind",
      session,
      session,
    );
    for (const path of [...gitMetadata, ...readOnly].sort()) {
      arguments_.push("--ro-bind", path, path);
    }
    arguments_.push("--clearenv");
    for (const [name, value] of Object.entries(childEnvironment).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      arguments_.push("--setenv", name, value);
    }
    arguments_.push("--hostname", "agentworks", "--chdir", worktree);
    arguments_.push("--", command, ...commandArguments);

    return Object.freeze({
      adapter: "bubblewrap",
      executablePath: capabilities.executablePath,
      arguments: Object.freeze(arguments_),
      hostEnvironment: Object.freeze({
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
      }),
      evidence: Object.freeze({
        ...capabilities.evidence,
        assignedWorktreeWritable: request.worktreeAccess === "read-write",
        networkIsolated: request.networkPolicy === "isolated",
      }),
    });
  }

  #canonicalUniquePaths(
    paths: readonly string[],
    label: string,
  ): readonly string[] {
    const canonical = new Set<string>();
    for (const [index, path] of paths.entries()) {
      canonical.add(canonicalExistingPath(path, `${label} ${String(index)}`));
    }
    return Object.freeze([...canonical]);
  }

  #environment(
    requested: Readonly<Record<string, string>>,
    worktree: string,
  ): Readonly<Record<string, string>> {
    const entries = Object.entries(requested);
    if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
      throw new BubblewrapSandboxConfigurationError(
        "sandbox environment has too many entries",
      );
    }
    const environment: Record<string, string> = {
      HOME: homedir(),
      LOGNAME: userInfo().username,
      PATH: "/usr/bin:/bin",
      PWD: worktree,
      TMPDIR: "/tmp",
      USER: userInfo().username,
    };
    for (const [name, value] of entries) {
      if (
        !ENVIRONMENT_NAME_PATTERN.test(name) ||
        RESERVED_ENVIRONMENT.has(name)
      ) {
        throw new BubblewrapSandboxConfigurationError(
          `sandbox environment name ${name} is invalid or reserved`,
        );
      }
      environment[name] = validateArgument(
        value,
        `sandbox environment ${name}`,
      );
    }
    return Object.freeze(environment);
  }
}
