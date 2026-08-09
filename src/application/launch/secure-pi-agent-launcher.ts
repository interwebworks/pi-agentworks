import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  HerdrGateway,
  HerdrPaneProcessInfo,
} from "../ports/herdr-gateway.ts";
import type {
  PiAgentLaunchEvidence,
  PiAgentLauncher,
  PiAgentLaunchRequest,
} from "../ports/pi-agent-launcher.ts";
import type { SandboxGateway } from "../ports/sandbox-gateway.ts";
import { assertAgentLaunchPermitted } from "../../domain/execution-policy.ts";

const MAX_PROMPT_BYTES = 256 * 1024;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const CHILD_AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type LaunchHerdrGateway = Pick<
  HerdrGateway,
  "getPane" | "getPaneProcessInfo" | "runCommand"
>;

export interface SecurePiAgentLauncherOptions {
  readonly processPollAttempts?: number;
  readonly processPollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class SecurePiAgentLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurePiAgentLaunchError";
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SecurePiAgentLaunchError(`${label} must be a positive integer`);
  }
  return value;
}

function isWithin(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalExisting(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new SecurePiAgentLaunchError(`${label} must be absolute`);
  }
  try {
    return realpathSync(resolve(path));
  } catch (error) {
    throw new SecurePiAgentLaunchError(
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const link = lstatSync(path);
  const details = statSync(path);
  if (link.isSymbolicLink() || !details.isDirectory()) {
    throw new SecurePiAgentLaunchError(`${label} must be a real directory`);
  }
  if (details.uid !== process.getuid?.()) {
    throw new SecurePiAgentLaunchError(
      `${label} must be owned by the controller user`,
    );
  }
  if ((details.mode & 0o077) !== 0) {
    throw new SecurePiAgentLaunchError(
      `${label} must not allow group or world access`,
    );
  }
}

function writeDurableArtifact(
  directory: string,
  name: string,
  content: string,
): { readonly path: string; readonly digest: string } {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_PROMPT_BYTES) {
    throw new SecurePiAgentLaunchError(
      `${name} exceeds the prompt artifact bounds`,
    );
  }
  const destination = join(directory, name);
  if (existsSync(destination)) {
    const details = lstatSync(destination);
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      details.uid !== process.getuid?.() ||
      (details.mode & 0o177) !== 0
    ) {
      throw new SecurePiAgentLaunchError(
        `${name} is not a private controller artifact`,
      );
    }
    const existing = readFileSync(destination);
    if (existing.length !== bytes.length || !timingSafeEqual(existing, bytes)) {
      throw new SecurePiAgentLaunchError(
        `${name} already exists with different launch content`,
      );
    }
    return Object.freeze({ path: destination, digest: sha256(existing) });
  }

  const temporary = join(
    directory,
    `.${name}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporary, destination);
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      const existing = readFileSync(destination);
      if (
        existing.length !== bytes.length ||
        !timingSafeEqual(existing, bytes)
      ) {
        throw new SecurePiAgentLaunchError(
          `${name} raced with different launch content`,
        );
      }
    }
    const directoryDescriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return Object.freeze({ path: destination, digest: sha256(bytes) });
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // A crash-safe temporary file may already be absent after cleanup.
    }
  }
}

function assertExistingPiSession(
  sessionDirectory: string,
  sessionId: string,
): string {
  const matching = readdirSync(sessionDirectory).filter((name) =>
    name.endsWith(`_${sessionId}.jsonl`),
  );
  if (matching.length !== 1) {
    throw new SecurePiAgentLaunchError(
      "Exact existing Pi session evidence is missing or ambiguous",
    );
  }
  const sessionFile = join(sessionDirectory, matching[0] ?? "");
  const status = lstatSync(sessionFile);
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.uid !== process.getuid?.() ||
    status.nlink !== 1 ||
    (status.mode & 0o077) !== 0 ||
    status.size < 1
  ) {
    throw new SecurePiAgentLaunchError(
      "Existing Pi session evidence is not one private controller-owned file",
    );
  }
  const descriptor = openSync(
    sessionFile,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.uid !== status.uid ||
      opened.mode !== status.mode ||
      opened.nlink !== status.nlink ||
      opened.size !== status.size ||
      opened.dev !== status.dev ||
      opened.ino !== status.ino
    ) {
      throw new SecurePiAgentLaunchError(
        "Existing Pi session changed while its evidence was opened",
      );
    }
    const bytes = Buffer.alloc(Math.min(opened.size, 4_096));
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    const firstLine = bytes
      .subarray(0, length)
      .toString("utf8")
      .split("\n", 1)[0];
    let header: unknown;
    try {
      header = JSON.parse(firstLine ?? "");
    } catch {
      throw new SecurePiAgentLaunchError(
        "Existing Pi session header is invalid",
      );
    }
    if (
      header === null ||
      typeof header !== "object" ||
      Array.isArray(header) ||
      (header as Readonly<Record<string, unknown>>).type !== "session" ||
      (header as Readonly<Record<string, unknown>>).id !== sessionId
    ) {
      throw new SecurePiAgentLaunchError(
        "Existing Pi session header conflicts with the recorded session id",
      );
    }
  } finally {
    closeSync(descriptor);
  }
  return sessionFile;
}

function shellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new SecurePiAgentLaunchError("Launch command contains a null byte");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function launchScript(
  runtimePath: string,
  agentId: string,
  sessionId: string,
  command: readonly string[],
): string {
  const directory = join(runtimePath, "launch-scripts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(directory, "launch script directory");
  const name = `${agentId}-${sessionId}.sh`;
  const script = writeDurableArtifact(
    directory,
    name,
    `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")}\n`,
  );
  return script.path;
}

function rolePrompt(request: PiAgentLaunchRequest): string {
  return `# Agentworks role: ${request.role.label}

${request.rolePrompt.trim()}

## Authority and safety boundary

- Role ID: ${request.role.id}
- Authority: ${request.role.authority}
- Write policy: ${request.role.writePolicy}
- Controller actions: ${request.role.controllerActions.join(", ")}
- Use agentworks_submit_work for submit-work authority and agentworks_submit_review for submit-review authority.
- You are one member of an Agentworks team and must remain inside the assigned task specification.
- The Agentworks controller is the sole Git mutator. Never create commits, branches, worktrees, merges, resets, rebases, or cleanup operations directly.
- Use only the enabled tools and controller bridge actions.
- Treat task completion as a structured controller report, not terminal exit or prose alone.
`;
}

function taskPrompt(request: PiAgentLaunchRequest): string {
  return `# Agentworks assignment

Execute the following strict task specification without widening its scope.
Escalate when an escalation condition is reached or required detail is missing.

\`\`\`json
${JSON.stringify(request.task, null, 2)}
\`\`\`

Begin by checking the assigned worktree and reporting your first meaningful operation through the Agentworks child bridge.
`;
}

export class SecurePiAgentLauncher implements PiAgentLauncher {
  readonly #sandbox: SandboxGateway;
  readonly #herdr: LaunchHerdrGateway;
  readonly #processPollAttempts: number;
  readonly #processPollIntervalMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(
    sandbox: SandboxGateway,
    herdr: LaunchHerdrGateway,
    options: SecurePiAgentLauncherOptions = {},
  ) {
    this.#sandbox = sandbox;
    this.#herdr = herdr;
    this.#processPollAttempts = positiveSafeInteger(
      options.processPollAttempts ?? 20,
      "process poll attempts",
    );
    this.#processPollIntervalMs = positiveSafeInteger(
      options.processPollIntervalMs ?? 100,
      "process poll interval",
    );
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolvePromise) =>
          setTimeout(resolvePromise, milliseconds),
        ));
  }

  async launch(request: PiAgentLaunchRequest): Promise<PiAgentLaunchEvidence> {
    this.#assertRequest(request);
    const pane = await this.#herdr.getPane(request.paneId);
    if (
      pane.cwd !== request.task.worktreePath ||
      pane.tokens.aw_kind !== "agent" ||
      pane.tokens.aw_run !== request.task.runId ||
      pane.tokens.aw_agent !== request.task.assignedAgentId
    ) {
      throw new SecurePiAgentLaunchError(
        "Herdr pane ownership or working directory does not match the assignment",
      );
    }

    const sessionPath = canonicalExisting(
      request.sessionPath,
      "agent session path",
    );
    assertPrivateDirectory(sessionPath, "agent session path");
    const requestedConfigPath = resolve(request.configPath);
    if (!isWithin(requestedConfigPath, sessionPath)) {
      throw new SecurePiAgentLaunchError(
        "Pi config must be dedicated inside the private agent session path",
      );
    }
    mkdirSync(requestedConfigPath, { recursive: true, mode: 0o700 });
    const configPath = canonicalExisting(requestedConfigPath, "Pi config path");
    assertPrivateDirectory(configPath, "Pi config path");
    const piSessionPath = join(sessionPath, "pi-sessions");
    mkdirSync(piSessionPath, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(piSessionPath, "Pi session storage path");
    if (request.requireExistingSession === true) {
      const existingSessionFile = assertExistingPiSession(
        piSessionPath,
        request.sessionId,
      );
      if (
        request.expectedSessionFile !== undefined &&
        canonicalExisting(
          request.expectedSessionFile,
          "recorded Pi session file",
        ) !== existingSessionFile
      ) {
        throw new SecurePiAgentLaunchError(
          "Existing Pi session file conflicts with the controller-recorded path",
        );
      }
    }

    const artifacts = Object.freeze({
      role: writeDurableArtifact(
        sessionPath,
        "role-system-prompt.md",
        rolePrompt(request),
      ),
      task: writeDurableArtifact(
        sessionPath,
        "task-assignment.md",
        taskPrompt(request),
      ),
      capability: writeDurableArtifact(
        sessionPath,
        "controller-child-capability.token",
        `${request.controllerChildAuthToken}\n`,
      ),
    });
    const nodePath = canonicalExisting(request.nodePath, "Node executable");
    const piCliPath = canonicalExisting(request.piCliPath, "Pi CLI path");
    const piPackagePath = canonicalExisting(
      request.piPackagePath,
      "Pi package path",
    );
    const agentworksPackagePath = canonicalExisting(
      request.agentworksPackagePath,
      "Agentworks package path",
    );
    const childBridgePath = canonicalExisting(
      request.childBridgePath,
      "Agentworks child bridge path",
    );
    if (!isWithin(piCliPath, piPackagePath)) {
      throw new SecurePiAgentLaunchError(
        "Pi CLI must belong to the approved Pi package",
      );
    }
    if (!isWithin(childBridgePath, agentworksPackagePath)) {
      throw new SecurePiAgentLaunchError(
        "Child bridge must belong to the approved Agentworks package",
      );
    }
    const runtimePath = canonicalExisting(
      request.runtimePath,
      "Agentworks runtime path",
    );
    const controllerSocketPath = canonicalExisting(
      request.controllerSocketPath,
      "controller socket path",
    );
    if (!isWithin(controllerSocketPath, runtimePath)) {
      throw new SecurePiAgentLaunchError(
        "Controller socket must stay inside the approved runtime path",
      );
    }

    const cliArguments = [
      piCliPath,
      "--provider",
      request.provider,
      "--model",
      request.model,
      "--thinking",
      request.thinking,
      "--system-prompt",
      artifacts.role.path,
      "--tools",
      request.task.allowedTools.join(","),
      "--no-extensions",
      "--extension",
      childBridgePath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-approve",
      "--session-dir",
      piSessionPath,
      "--session-id",
      request.sessionId,
      "--name",
      `${request.role.label} · ${request.task.storyId}`,
      `@${artifacts.task.path}`,
      "Execute this assignment and keep the controller informed.",
    ];
    const plan = this.#sandbox.plan({
      command: nodePath,
      arguments: cliArguments,
      assignedWorktreePath: request.task.worktreePath,
      worktreeAccess:
        request.task.writePolicy === "story-writer"
          ? "read-write"
          : "read-only",
      gitMetadataPaths: request.gitMetadataPaths,
      sessionPath,
      runtimePath,
      readOnlyPaths: [
        piPackagePath,
        agentworksPackagePath,
        artifacts.role.path,
        artifacts.task.path,
        artifacts.capability.path,
        ...request.additionalReadOnlyPaths,
      ],
      environment: {
        AGENTWORKS_AGENT_ID: request.task.assignedAgentId,
        AGENTWORKS_CHILD_MODE: "1",
        AGENTWORKS_CONTROLLER_SOCKET: controllerSocketPath,
        AGENTWORKS_CONTROLLER_TOKEN_FILE: artifacts.capability.path,
        AGENTWORKS_CONTROLLER_ACTIONS: request.role.controllerActions.join(","),
        AGENTWORKS_RUN_ID: request.task.runId,
        PI_CODING_AGENT_DIR: configPath,
        PI_CODING_AGENT_SESSION_DIR: piSessionPath,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      networkPolicy:
        request.role.networkAccess === "required" ? "host" : "isolated",
    });
    assertAgentLaunchPermitted({
      complexity: request.complexity,
      task: request.task,
      sandbox: plan.evidence,
      roleRequiresNetwork: request.role.networkAccess === "required",
    });

    const command = [plan.executablePath, ...plan.arguments];
    const expectedProcessArgv = Object.freeze([nodePath, ...cliArguments]);
    let processIds = await this.#inspectProcessEvidence(
      request.paneId,
      expectedProcessArgv,
    );
    if (processIds === null) {
      const scriptPath = launchScript(
        runtimePath,
        request.task.assignedAgentId,
        request.sessionId,
        command,
      );
      await this.#herdr.runCommand(request.paneId, ["/bin/sh", scriptPath]);
      processIds = await this.#awaitProcessEvidence(
        request.paneId,
        expectedProcessArgv,
      );
    }
    return Object.freeze({
      paneId: request.paneId,
      sessionId: request.sessionId,
      processIds,
      sandbox: plan.evidence,
      rolePromptPath: artifacts.role.path,
      taskPromptPath: artifacts.task.path,
      controllerCapabilityPath: artifacts.capability.path,
      rolePromptSha256: artifacts.role.digest,
      taskPromptSha256: artifacts.task.digest,
      commandSha256: sha256(command.join("\0")),
    });
  }

  #assertRequest(request: PiAgentLaunchRequest): void {
    if (!SESSION_ID_PATTERN.test(request.sessionId)) {
      throw new SecurePiAgentLaunchError("Pi session id must be an exact UUID");
    }
    if (!CHILD_AUTH_TOKEN_PATTERN.test(request.controllerChildAuthToken)) {
      throw new SecurePiAgentLaunchError(
        "Controller child authentication capability is invalid",
      );
    }
    if (!PROVIDER_PATTERN.test(request.provider)) {
      throw new SecurePiAgentLaunchError("Pi provider is invalid");
    }
    if (!MODEL_PATTERN.test(request.model)) {
      throw new SecurePiAgentLaunchError("Pi model is invalid");
    }
    const roleRuntimeId =
      "runtimeId" in request.role && typeof request.role.runtimeId === "string"
        ? request.role.runtimeId
        : request.role.id;
    if (
      roleRuntimeId !== request.task.assignedRole ||
      request.role.writePolicy !== request.task.writePolicy
    ) {
      throw new SecurePiAgentLaunchError(
        "Role identity or write policy does not match the task specification",
      );
    }
    const roleTools = new Set(request.role.tools);
    if (request.task.allowedTools.some((tool) => !roleTools.has(tool))) {
      throw new SecurePiAgentLaunchError(
        "Task tools exceed the selected role tool authority",
      );
    }
    if (
      request.task.writePolicy === "story-writer" &&
      !request.writerLeaseActive
    ) {
      throw new SecurePiAgentLaunchError(
        "A story writer requires an active durable writer lease",
      );
    }
    if (!request.controllerFenceCurrent || !request.expectedRevisionMatches) {
      throw new SecurePiAgentLaunchError(
        "Controller fence and run revision must be current before launch",
      );
    }
    if (
      request.rolePrompt.trim().length < 1 ||
      Buffer.byteLength(request.rolePrompt) > MAX_PROMPT_BYTES
    ) {
      throw new SecurePiAgentLaunchError("Role prompt is empty or oversized");
    }
  }

  async #inspectProcessEvidence(
    paneId: string,
    expectedArgv: readonly string[],
  ): Promise<readonly number[] | null> {
    const info: HerdrPaneProcessInfo =
      await this.#herdr.getPaneProcessInfo(paneId);
    if (info.paneId !== paneId) {
      throw new SecurePiAgentLaunchError(
        "Herdr process evidence belongs to a different pane",
      );
    }
    const [nodePath, piCliPath] = expectedArgv;
    const exact = info.foregroundProcesses.filter((process) => {
      const argv = process.argv ?? [];
      const directMatch =
        argv.length === expectedArgv.length &&
        argv.every((argument, index) => argument === expectedArgv[index]);
      const executable = argv[0] ?? "";
      const separator = argv.lastIndexOf("--");
      const sandboxedCommand = argv.slice(separator + 1);
      const bubblewrapMatch =
        (executable === "bwrap" || executable.endsWith("/bwrap")) &&
        argv.includes("--unshare-pid") &&
        separator >= 0 &&
        sandboxedCommand.length === expectedArgv.length &&
        sandboxedCommand.every(
          (argument, index) => argument === expectedArgv[index],
        );
      return directMatch || bubblewrapMatch;
    });
    const conflictingPi = info.foregroundProcesses.some((process) => {
      const argv = process.argv ?? [];
      return (
        argv[0] === nodePath &&
        argv[1] === piCliPath &&
        !exact.includes(process)
      );
    });
    if (conflictingPi || exact.length > 1) {
      throw new SecurePiAgentLaunchError(
        "Herdr pane contains conflicting or duplicate interactive Pi process evidence",
      );
    }
    return exact.length === 1
      ? Object.freeze(exact.map((process) => process.pid))
      : null;
  }

  async #awaitProcessEvidence(
    paneId: string,
    expectedArgv: readonly string[],
  ): Promise<readonly number[]> {
    for (let attempt = 0; attempt < this.#processPollAttempts; attempt += 1) {
      const processIds = await this.#inspectProcessEvidence(
        paneId,
        expectedArgv,
      );
      if (processIds !== null) return processIds;
      if (attempt + 1 < this.#processPollAttempts) {
        await this.#sleep(this.#processPollIntervalMs);
      }
    }
    throw new SecurePiAgentLaunchError(
      "Herdr did not report the exact interactive Pi child process before timeout",
    );
  }
}
