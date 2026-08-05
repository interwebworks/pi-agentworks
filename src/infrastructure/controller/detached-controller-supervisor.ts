import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { JsonValue } from "../../application/ports/controller-repository.ts";
import {
  discoverControllerRuntime,
  readProcessStartIdentity,
  resolveControllerRuntimePaths,
  type ControllerRuntimeDescriptor,
  type DiscoveredControllerRuntime,
} from "./controller-runtime.ts";
import { UnixControllerClient } from "./unix-controller-transport.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 25_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export type ControllerProcessStatus =
  "absent" | "healthy" | "alive-unhealthy" | "stale";

export interface ControllerProcessInspection {
  readonly status: ControllerProcessStatus;
  readonly descriptor: ControllerRuntimeDescriptor | null;
}

export interface EnsureControllerResult {
  readonly descriptor: ControllerRuntimeDescriptor;
  readonly started: boolean;
}

export interface DetachedControllerSupervisorOptions {
  readonly runtimeRoot: string;
  readonly runId: string;
  readonly entryPath?: string;
  readonly nodePath?: string;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly leaseTtlMs?: number;
  readonly renewIntervalMs?: number;
  readonly clock?: () => number;
}

export class DetachedControllerSupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetachedControllerSupervisorError";
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DetachedControllerSupervisorError(
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processMatches(descriptor: ControllerRuntimeDescriptor): boolean {
  try {
    process.kill(descriptor.processId, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
  if (descriptor.processStartIdentity === null) return true;
  return (
    readProcessStartIdentity(descriptor.processId) ===
    descriptor.processStartIdentity
  );
}

async function ping(discovered: DiscoveredControllerRuntime): Promise<boolean> {
  const client = new UnixControllerClient({
    socketPath: discovered.descriptor.socketPath,
    runId: discovered.descriptor.runId,
    authToken: discovered.authToken,
    clientId: `supervisor-ping-${randomUUID()}`,
    clientKind: "parent",
    agentId: null,
  });
  try {
    await client.connect();
    const response = await client.request({
      action: "controller.ping",
      payload: {},
    });
    return isMatchingPing(response, discovered.descriptor);
  } catch {
    return false;
  } finally {
    client.close();
  }
}

function isMatchingPing(
  value: JsonValue,
  descriptor: ControllerRuntimeDescriptor,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return (
    record.runId === descriptor.runId &&
    record.ownerId === descriptor.ownerId &&
    record.processId === descriptor.processId
  );
}

export class DetachedControllerSupervisor {
  readonly #runtimeRoot: string;
  readonly #runId: string;
  readonly #entryPath: string;
  readonly #nodePath: string;
  readonly #startupTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #leaseTtlMs: number | null;
  readonly #renewIntervalMs: number | null;
  readonly #clock: () => number;

  constructor(options: DetachedControllerSupervisorOptions) {
    this.#runtimeRoot = options.runtimeRoot;
    this.#runId = options.runId;
    this.#entryPath =
      options.entryPath ??
      fileURLToPath(
        new URL("../../controller/process-entry.ts", import.meta.url),
      );
    this.#nodePath = options.nodePath ?? process.execPath;
    this.#startupTimeoutMs = positiveSafeInteger(
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      "startup timeout",
    );
    this.#shutdownTimeoutMs = positiveSafeInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdown timeout",
    );
    this.#pollIntervalMs = positiveSafeInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "poll interval",
    );
    this.#leaseTtlMs =
      options.leaseTtlMs === undefined
        ? null
        : positiveSafeInteger(options.leaseTtlMs, "lease ttl");
    this.#renewIntervalMs =
      options.renewIntervalMs === undefined
        ? null
        : positiveSafeInteger(options.renewIntervalMs, "renew interval");
    if (
      this.#leaseTtlMs !== null &&
      this.#renewIntervalMs !== null &&
      this.#renewIntervalMs >= this.#leaseTtlMs
    ) {
      throw new DetachedControllerSupervisorError(
        "Renew interval must be shorter than the lease ttl",
      );
    }
    this.#clock = options.clock ?? Date.now;
    resolveControllerRuntimePaths(this.#runtimeRoot, this.#runId);
  }

  async inspect(): Promise<ControllerProcessInspection> {
    const discovered = discoverControllerRuntime(
      this.#runtimeRoot,
      this.#runId,
    );
    if (discovered === null) {
      return Object.freeze({ status: "absent", descriptor: null });
    }
    if (await ping(discovered)) {
      return Object.freeze({
        status: "healthy",
        descriptor: discovered.descriptor,
      });
    }
    return Object.freeze({
      status: processMatches(discovered.descriptor)
        ? "alive-unhealthy"
        : "stale",
      descriptor: discovered.descriptor,
    });
  }

  async ensureRunning(): Promise<EnsureControllerResult> {
    const deadline = this.#clock() + this.#startupTimeoutMs;
    let inspection = await this.inspect();
    if (inspection.status === "healthy" && inspection.descriptor !== null) {
      return Object.freeze({
        descriptor: inspection.descriptor,
        started: false,
      });
    }
    if (inspection.status === "alive-unhealthy") {
      throw new DetachedControllerSupervisorError(
        "Controller process is alive but its authenticated health check failed",
      );
    }

    while (
      inspection.status === "stale" &&
      inspection.descriptor !== null &&
      this.#clock() < inspection.descriptor.leaseExpiresAt
    ) {
      if (this.#clock() >= deadline) {
        throw new DetachedControllerSupervisorError(
          "Timed out waiting for the stale controller lease to expire",
        );
      }
      await delay(this.#pollIntervalMs);
      inspection = await this.inspect();
      if (inspection.status === "healthy" && inspection.descriptor !== null) {
        return Object.freeze({
          descriptor: inspection.descriptor,
          started: false,
        });
      }
      if (inspection.status === "alive-unhealthy") {
        throw new DetachedControllerSupervisorError(
          "Controller process became alive but remained unhealthy",
        );
      }
    }

    const ownerId = randomUUID();
    const processId = this.#spawn(ownerId);
    while (this.#clock() < deadline) {
      await delay(this.#pollIntervalMs);
      const discovered = discoverControllerRuntime(
        this.#runtimeRoot,
        this.#runId,
      );
      if (
        discovered !== null &&
        discovered.descriptor.ownerId === ownerId &&
        (await ping(discovered))
      ) {
        return Object.freeze({
          descriptor: discovered.descriptor,
          started: true,
        });
      }
      if (!this.#processExists(processId)) {
        throw new DetachedControllerSupervisorError(
          "Detached controller exited before becoming healthy",
        );
      }
    }

    this.#signal(processId, "SIGTERM");
    throw new DetachedControllerSupervisorError(
      "Timed out waiting for the detached controller to become healthy",
    );
  }

  async stop(): Promise<void> {
    const discovered = discoverControllerRuntime(
      this.#runtimeRoot,
      this.#runId,
    );
    if (discovered === null) return;
    const descriptor = discovered.descriptor;
    if (await ping(discovered)) {
      const client = new UnixControllerClient({
        socketPath: descriptor.socketPath,
        runId: descriptor.runId,
        authToken: discovered.authToken,
        clientId: `supervisor-stop-${randomUUID()}`,
        clientKind: "parent",
        agentId: null,
      });
      try {
        await client.connect();
        await client.request({ action: "controller.shutdown", payload: {} });
      } finally {
        client.close();
      }
    } else if (processMatches(descriptor)) {
      this.#signal(descriptor.processId, "SIGTERM");
    }

    const deadline = this.#clock() + this.#shutdownTimeoutMs;
    while (this.#clock() < deadline) {
      await delay(this.#pollIntervalMs);
      const current = discoverControllerRuntime(this.#runtimeRoot, this.#runId);
      if (current === null && !this.#processExists(descriptor.processId))
        return;
    }
    throw new DetachedControllerSupervisorError(
      "Timed out waiting for the controller to stop",
    );
  }

  #spawn(ownerId: string): number {
    const paths = resolveControllerRuntimePaths(this.#runtimeRoot, this.#runId);
    mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
    const directoryStatus = lstatSync(paths.runtimeDirectory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
      throw new DetachedControllerSupervisorError(
        "Controller runtime directory is unsafe",
      );
    }
    chmodSync(paths.runtimeDirectory, 0o700);
    const logPath = `${paths.runtimeDirectory}/controller.log`;
    if (existsSync(logPath)) {
      const status = lstatSync(logPath);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
        throw new DetachedControllerSupervisorError(
          "Controller log path is unsafe",
        );
      }
    }
    const logDescriptor = openSync(
      logPath,
      constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      chmodSync(logPath, 0o600);
      const child = spawn(
        this.#nodePath,
        [
          "--experimental-strip-types",
          this.#entryPath,
          "--runtime-root",
          this.#runtimeRoot,
          "--run-id",
          this.#runId,
          "--owner-id",
          ownerId,
          ...(this.#leaseTtlMs === null
            ? []
            : ["--lease-ttl-ms", String(this.#leaseTtlMs)]),
          ...(this.#renewIntervalMs === null
            ? []
            : ["--renew-interval-ms", String(this.#renewIntervalMs)]),
        ],
        {
          detached: true,
          shell: false,
          stdio: ["ignore", logDescriptor, logDescriptor],
        },
      );
      if (child.pid === undefined) {
        throw new DetachedControllerSupervisorError(
          "Detached controller did not receive a process id",
        );
      }
      child.unref();
      return child.pid;
    } finally {
      closeSync(logDescriptor);
    }
  }

  #processExists(processId: number): boolean {
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  #signal(processId: number, signal: NodeJS.Signals): void {
    try {
      process.kill(processId, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
