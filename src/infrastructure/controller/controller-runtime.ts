import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import {
  assessStartupRecovery,
  type StartupRecoveryAssessment,
} from "../../domain/recovery.ts";
import type {
  ControllerLease,
  ControllerRepository,
} from "../../application/ports/controller-repository.ts";
import {
  assertControllerDatabaseNotQuarantined,
  isControllerDatabaseCorruption,
  quarantineControllerDatabase,
} from "./controller-database-quarantine.ts";
import { SqliteControllerRepository } from "./sqlite-controller-repository.ts";
import {
  UnixControllerServer,
  type UnixControllerServerOptions,
} from "./unix-controller-transport.ts";

export const CONTROLLER_RUNTIME_SCHEMA_VERSION = 1 as const;
const DEFAULT_LEASE_TTL_MS = 15_000;
const DEFAULT_RENEW_INTERVAL_MS = 5_000;
const STALE_SOCKET_PROBE_TIMEOUT_MS = 250;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const ControllerRuntimeDescriptorSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CONTROLLER_RUNTIME_SCHEMA_VERSION),
    runId: Type.String({ minLength: 1, maxLength: 64 }),
    ownerId: Type.String({ minLength: 1, maxLength: 128 }),
    processId: Type.Integer({ minimum: 1 }),
    processStartIdentity: Type.Union([
      Type.Null(),
      Type.String({ minLength: 1, maxLength: 128 }),
    ]),
    startedAt: Type.Integer({ minimum: 0 }),
    leaseExpiresAt: Type.Integer({ minimum: 0 }),
    fencingToken: Type.Integer({ minimum: 1 }),
    recovery: Type.Object(
      {
        status: Type.Union([
          Type.Literal("ready"),
          Type.Literal("reconciliation-required"),
        ]),
        reasons: Type.Array(
          Type.Object(
            {
              code: Type.Union([
                Type.Literal("agent-operation-interrupted"),
                Type.Literal("candidate-commit-interrupted"),
                Type.Literal("merge-interrupted"),
                Type.Literal("terminal-run-has-active-agent"),
              ]),
              entityId: Type.String({ minLength: 1, maxLength: 128 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 1_000 },
        ),
      },
      { additionalProperties: false },
    ),
    runtimeDirectory: Type.String({ minLength: 1 }),
    databasePath: Type.String({ minLength: 1 }),
    socketPath: Type.String({ minLength: 1 }),
    tokenPath: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export interface ControllerRuntimeDescriptor {
  readonly schemaVersion: typeof CONTROLLER_RUNTIME_SCHEMA_VERSION;
  readonly runId: string;
  readonly ownerId: string;
  readonly processId: number;
  readonly processStartIdentity: string | null;
  readonly startedAt: number;
  readonly leaseExpiresAt: number;
  readonly fencingToken: number;
  readonly recovery: StartupRecoveryAssessment;
  readonly runtimeDirectory: string;
  readonly databasePath: string;
  readonly socketPath: string;
  readonly tokenPath: string;
}

export interface ControllerRuntimePaths {
  readonly runtimeDirectory: string;
  readonly databasePath: string;
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly descriptorPath: string;
  readonly quarantineMarkerPath: string;
}

export interface DiscoveredControllerRuntime {
  readonly descriptor: ControllerRuntimeDescriptor;
  readonly authToken: string;
}

export interface ControllerRuntimeOptions {
  readonly runtimeRoot: string;
  readonly runId: string;
  readonly ownerId?: string;
  readonly leaseTtlMs?: number;
  readonly renewIntervalMs?: number;
  readonly autoRenew?: boolean;
  readonly clock?: () => number;
  readonly processId?: number;
  readonly processStartIdentity?: string | null;
  readonly repositoryFactory?: (databasePath: string) => ControllerRepository;
  readonly serverFactory?: (
    options: UnixControllerServerOptions,
  ) => UnixControllerServer;
  readonly authorizeIdentity: UnixControllerServerOptions["authorizeIdentity"];
  readonly handleRequest: UnixControllerServerOptions["handleRequest"];
  readonly onFatalError?: (error: Error) => void;
}

export class ControllerRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControllerRuntimeError";
  }
}

export class ControllerRecoveryRequiredError extends ControllerRuntimeError {
  readonly assessment: StartupRecoveryAssessment;

  constructor(assessment: StartupRecoveryAssessment) {
    super(
      "Controller recovery reconciliation is required before accepting work",
    );
    this.name = "ControllerRecoveryRequiredError";
    this.assessment = assessment;
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ControllerRuntimeError(
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function safeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ControllerRuntimeError(
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

export function readProcessStartIdentity(processId: number): string | null {
  positiveSafeInteger(processId, "process id");
  try {
    const stat = readFileSync(`/proc/${String(processId)}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u);
    const startTime = fields[19];
    return startTime === undefined ? null : `linux:${startTime}`;
  } catch {
    return null;
  }
}

function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ControllerRuntimeError(
      "Run id must contain only letters, digits, dots, underscores, and hyphens",
    );
  }
  return runId;
}

export function resolveControllerRuntimePaths(
  runtimeRoot: string,
  runId: string,
): ControllerRuntimePaths {
  const normalizedRoot = resolve(runtimeRoot);
  const normalizedRunId = assertRunId(runId);
  const runtimeDirectory = join(normalizedRoot, normalizedRunId);
  return Object.freeze({
    runtimeDirectory,
    databasePath: join(runtimeDirectory, "controller.sqlite"),
    socketPath: join(runtimeDirectory, "controller.sock"),
    tokenPath: join(runtimeDirectory, "auth-token"),
    descriptorPath: join(runtimeDirectory, "controller.json"),
    quarantineMarkerPath: join(runtimeDirectory, "quarantine.json"),
  });
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new ControllerRuntimeError(
      "Controller runtime path must be a real directory",
    );
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new ControllerRuntimeError(
      "Controller runtime directory has a different owner",
    );
  }
  chmodSync(path, 0o700);
}

interface PrivateFileRead {
  readonly content: string;
  readonly device: number;
  readonly inode: number;
}

function readPrivateRegularFile(path: string, label: string): PrivateFileRead {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.nlink !== 1) {
      throw new ControllerRuntimeError(
        `${label} must be one private regular file`,
      );
    }
    if (
      typeof process.getuid === "function" &&
      status.uid !== process.getuid()
    ) {
      throw new ControllerRuntimeError(`${label} has a different owner`);
    }
    fchmodSync(descriptor, 0o600);
    return Object.freeze({
      content: readFileSync(descriptor, "utf8"),
      device: status.dev,
      inode: status.ino,
    });
  } finally {
    closeSync(descriptor);
  }
}

function readExistingToken(tokenPath: string): string {
  let file: PrivateFileRead;
  try {
    file = readPrivateRegularFile(tokenPath, "Controller token");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ControllerRuntimeError("Controller token file is missing");
    }
    throw error;
  }
  const token = file.content.trim();
  if (token.length < 32 || token.length > 512) {
    throw new ControllerRuntimeError(
      "Controller token file has invalid content",
    );
  }
  return token;
}

function createOrReadToken(tokenPath: string): string {
  if (existsSync(tokenPath)) return readExistingToken(tokenPath);

  const token = randomBytes(32).toString("base64url");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      tokenPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${token}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  readPrivateRegularFile(tokenPath, "Controller token");
  return token;
}

function parseDescriptor(serialized: string): ControllerRuntimeDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new ControllerRuntimeError(
      "Controller descriptor contains invalid JSON",
    );
  }
  if (!Check(ControllerRuntimeDescriptorSchema, value)) {
    const issues = [...Errors(ControllerRuntimeDescriptorSchema, value)]
      .map((error) => `${error.instancePath || "/"}: ${error.message}`)
      .join("; ");
    throw new ControllerRuntimeError(
      `Controller descriptor is invalid: ${issues}`,
    );
  }
  return Object.freeze(value);
}

function writeDescriptorAtomically(
  descriptorPath: string,
  descriptor: ControllerRuntimeDescriptor,
): void {
  const temporaryPath = `${descriptorPath}.${descriptor.ownerId}.${randomUUID()}.tmp`;
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(
      fileDescriptor,
      `${JSON.stringify(descriptor, null, 2)}\n`,
      "utf8",
    );
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;
    renameSync(temporaryPath, descriptorPath);
    chmodSync(descriptorPath, 0o600);
    const directoryDescriptor = openSync(
      dirname(descriptorPath),
      constants.O_RDONLY,
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function removeOwnedDescriptor(descriptorPath: string, ownerId: string): void {
  if (!existsSync(descriptorPath)) return;
  try {
    const file = readPrivateRegularFile(
      descriptorPath,
      "Controller descriptor",
    );
    const descriptor = parseDescriptor(file.content);
    if (descriptor.ownerId === ownerId) {
      const current = lstatSync(descriptorPath);
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === file.device &&
        current.ino === file.inode
      ) {
        unlinkSync(descriptorPath);
      }
    }
  } catch {
    // A malformed or replaced descriptor is not safe to remove automatically.
  }
}

type SocketProbeResult = "active" | "stale" | "indeterminate";

async function probeSocket(socketPath: string): Promise<SocketProbeResult> {
  return await new Promise<SocketProbeResult>((resolveProbe) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (result: SocketProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(result);
    };
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ECONNREFUSED" || error.code === "ENOENT"
          ? "stale"
          : "indeterminate",
      );
    });
    socket.setTimeout(STALE_SOCKET_PROBE_TIMEOUT_MS, () =>
      finish("indeterminate"),
    );
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const status = lstatSync(socketPath);
  if (!status.isSocket() || status.isSymbolicLink()) {
    throw new ControllerRuntimeError(
      "Controller socket path exists but is not a removable stale socket",
    );
  }
  const probe = await probeSocket(socketPath);
  if (probe !== "stale") {
    throw new ControllerRuntimeError(
      probe === "active"
        ? "Controller socket still accepts connections and will not be replaced"
        : "Controller socket state is indeterminate and will not be replaced",
    );
  }
  unlinkSync(socketPath);
}

export function discoverControllerRuntime(
  runtimeRoot: string,
  runId: string,
): DiscoveredControllerRuntime | null {
  const paths = resolveControllerRuntimePaths(runtimeRoot, runId);
  assertControllerDatabaseNotQuarantined(paths.quarantineMarkerPath);
  let descriptorFile: PrivateFileRead;
  try {
    descriptorFile = readPrivateRegularFile(
      paths.descriptorPath,
      "Controller descriptor",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const descriptor = parseDescriptor(descriptorFile.content);
  if (
    descriptor.runId !== runId ||
    descriptor.runtimeDirectory !== paths.runtimeDirectory ||
    descriptor.databasePath !== paths.databasePath ||
    descriptor.socketPath !== paths.socketPath ||
    descriptor.tokenPath !== paths.tokenPath
  ) {
    throw new ControllerRuntimeError(
      "Controller descriptor paths do not match the requested runtime",
    );
  }
  const authToken = readExistingToken(paths.tokenPath);
  return Object.freeze({ descriptor, authToken });
}

export class ControllerRuntime {
  readonly #paths: ControllerRuntimePaths;
  readonly #runId: string;
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  readonly #renewIntervalMs: number;
  readonly #autoRenew: boolean;
  readonly #clock: () => number;
  readonly #processId: number;
  readonly #processStartIdentity: string | null;
  readonly #repositoryFactory: (databasePath: string) => ControllerRepository;
  readonly #usesDefaultRepositoryFactory: boolean;
  readonly #serverFactory: (
    options: UnixControllerServerOptions,
  ) => UnixControllerServer;
  readonly #authorizeIdentity: UnixControllerServerOptions["authorizeIdentity"];
  readonly #handleRequest: UnixControllerServerOptions["handleRequest"];
  readonly #onFatalError: (error: Error) => void;
  #repository: ControllerRepository | null = null;
  #server: UnixControllerServer | null = null;
  #lease: ControllerLease | null = null;
  #authToken: string | null = null;
  #startedAt: number | null = null;
  #recoveryAssessment: StartupRecoveryAssessment = Object.freeze({
    status: "ready",
    reasons: Object.freeze([]),
  });
  #renewalTimer: NodeJS.Timeout | null = null;
  #state: "new" | "starting" | "running" | "stopping" | "stopped" = "new";

  constructor(options: ControllerRuntimeOptions) {
    this.#paths = resolveControllerRuntimePaths(
      options.runtimeRoot,
      options.runId,
    );
    this.#runId = options.runId;
    this.#ownerId = options.ownerId ?? randomUUID();
    this.#leaseTtlMs = positiveSafeInteger(
      options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      "lease ttl",
    );
    this.#renewIntervalMs = positiveSafeInteger(
      options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS,
      "lease renewal interval",
    );
    if (this.#renewIntervalMs >= this.#leaseTtlMs) {
      throw new ControllerRuntimeError(
        "Lease renewal interval must be shorter than the lease ttl",
      );
    }
    this.#autoRenew = options.autoRenew ?? true;
    this.#clock = options.clock ?? Date.now;
    this.#processId = positiveSafeInteger(
      options.processId ?? process.pid,
      "controller process id",
    );
    this.#processStartIdentity =
      options.processStartIdentity ?? readProcessStartIdentity(this.#processId);
    this.#usesDefaultRepositoryFactory =
      options.repositoryFactory === undefined;
    this.#repositoryFactory =
      options.repositoryFactory ??
      ((databasePath) => new SqliteControllerRepository(databasePath));
    this.#serverFactory =
      options.serverFactory ??
      ((serverOptions) => new UnixControllerServer(serverOptions));
    this.#authorizeIdentity = options.authorizeIdentity;
    this.#handleRequest = options.handleRequest;
    this.#onFatalError = options.onFatalError ?? (() => undefined);
  }

  get paths(): ControllerRuntimePaths {
    return this.#paths;
  }

  get descriptor(): ControllerRuntimeDescriptor | null {
    if (
      this.#state !== "running" ||
      this.#lease === null ||
      this.#startedAt === null
    ) {
      return null;
    }
    return this.#buildDescriptor(this.#lease);
  }

  get repository(): ControllerRepository {
    if (this.#state !== "running" || this.#repository === null) {
      throw new ControllerRuntimeError("Controller runtime is not running");
    }
    return this.#repository;
  }

  get authToken(): string {
    if (this.#state !== "running" || this.#authToken === null) {
      throw new ControllerRuntimeError("Controller runtime is not running");
    }
    return this.#authToken;
  }

  assertReadyForWork(): void {
    if (this.#state !== "running") {
      throw new ControllerRuntimeError("Controller runtime is not running");
    }
    if (this.#recoveryAssessment.status === "reconciliation-required") {
      throw new ControllerRecoveryRequiredError(this.#recoveryAssessment);
    }
  }

  async start(): Promise<ControllerRuntimeDescriptor> {
    if (this.#state !== "new") {
      throw new ControllerRuntimeError(
        "Controller runtime can only be started once",
      );
    }
    this.#state = "starting";
    ensurePrivateDirectory(this.#paths.runtimeDirectory);
    assertControllerDatabaseNotQuarantined(this.#paths.quarantineMarkerPath);
    const startupTime = safeTimestamp(this.#clock(), "controller start time");
    let repository: ControllerRepository;
    try {
      repository = this.#repositoryFactory(this.#paths.databasePath);
    } catch (error) {
      if (
        this.#usesDefaultRepositoryFactory &&
        isControllerDatabaseCorruption(error)
      ) {
        quarantineControllerDatabase({
          databasePath: this.#paths.databasePath,
          markerPath: this.#paths.quarantineMarkerPath,
          occurredAt: startupTime,
          reason: "sqlite-corruption",
        });
      }
      this.#state = "stopped";
      throw error;
    }
    this.#repository = repository;

    try {
      try {
        repository.assertIntegrity();
      } catch (error) {
        if (
          this.#usesDefaultRepositoryFactory &&
          isControllerDatabaseCorruption(error)
        ) {
          repository.close();
          this.#repository = null;
          quarantineControllerDatabase({
            databasePath: this.#paths.databasePath,
            markerPath: this.#paths.quarantineMarkerPath,
            occurredAt: startupTime,
            reason: "sqlite-corruption",
          });
        }
        throw error;
      }
      try {
        this.#recoveryAssessment = assessStartupRecovery(
          repository.loadSnapshot(this.#runId),
        );
      } catch (error) {
        if (
          this.#usesDefaultRepositoryFactory &&
          isControllerDatabaseCorruption(error)
        ) {
          repository.close();
          this.#repository = null;
          quarantineControllerDatabase({
            databasePath: this.#paths.databasePath,
            markerPath: this.#paths.quarantineMarkerPath,
            occurredAt: startupTime,
            reason: "persisted-state-invalid",
          });
        }
        throw error;
      }
      const startedAt = startupTime;
      this.#startedAt = startedAt;
      const lease = repository.acquireLease(
        this.#ownerId,
        startedAt,
        this.#leaseTtlMs,
      );
      this.#lease = lease;
      const authToken = createOrReadToken(this.#paths.tokenPath);
      this.#authToken = authToken;
      await removeStaleSocket(this.#paths.socketPath);

      const server = this.#serverFactory({
        socketPath: this.#paths.socketPath,
        runId: this.#runId,
        authToken,
        authorizeIdentity: this.#authorizeIdentity,
        handleRequest: this.#handleRequest,
      });
      this.#server = server;
      await server.listen();
      const descriptor = this.#buildDescriptor(lease);
      writeDescriptorAtomically(this.#paths.descriptorPath, descriptor);
      this.#state = "running";
      if (this.#autoRenew) {
        this.#renewalTimer = setInterval(() => {
          try {
            this.renewLeaseNow();
          } catch (error) {
            const failure =
              error instanceof Error
                ? error
                : new ControllerRuntimeError(String(error));
            try {
              this.#onFatalError(failure);
            } catch {
              // Fatal reporting must not prevent fail-stop shutdown.
            }
            void this.shutdown({ releaseLease: false });
          }
        }, this.#renewIntervalMs);
        this.#renewalTimer.unref();
      }
      return descriptor;
    } catch (error) {
      await this.#rollbackFailedStart();
      throw error;
    }
  }

  renewLeaseNow(): ControllerRuntimeDescriptor {
    if (
      this.#state !== "running" ||
      this.#repository === null ||
      this.#lease === null
    ) {
      throw new ControllerRuntimeError("Controller runtime is not running");
    }
    const now = safeTimestamp(this.#clock(), "lease renewal time");
    const lease = this.#repository.renewLease(
      {
        ownerId: this.#ownerId,
        fencingToken: this.#lease.fencingToken,
        now,
      },
      this.#leaseTtlMs,
    );
    this.#lease = lease;
    const descriptor = this.#buildDescriptor(lease);
    writeDescriptorAtomically(this.#paths.descriptorPath, descriptor);
    return descriptor;
  }

  async shutdown(
    options: { readonly releaseLease?: boolean } = {},
  ): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state === "new") {
      this.#state = "stopped";
      return;
    }
    if (this.#state === "stopping") return;
    this.#state = "stopping";
    if (this.#renewalTimer !== null) {
      clearInterval(this.#renewalTimer);
      this.#renewalTimer = null;
    }

    let shutdownFailure: unknown = null;
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      try {
        await server.close();
      } catch (error) {
        shutdownFailure = error;
      }
    }

    const repository = this.#repository;
    const lease = this.#lease;
    if (
      repository !== null &&
      lease !== null &&
      (options.releaseLease ?? true)
    ) {
      try {
        repository.releaseLease({
          ownerId: this.#ownerId,
          fencingToken: lease.fencingToken,
          now: safeTimestamp(this.#clock(), "controller shutdown time"),
        });
      } catch {
        // An expired or superseded lease is already unusable and must not block shutdown.
      }
    }
    removeOwnedDescriptor(this.#paths.descriptorPath, this.#ownerId);
    try {
      repository?.close();
    } catch (error) {
      shutdownFailure ??= error;
    }
    this.#repository = null;
    this.#lease = null;
    this.#authToken = null;
    this.#state = "stopped";
    if (shutdownFailure !== null) {
      throw shutdownFailure instanceof Error
        ? shutdownFailure
        : new ControllerRuntimeError("Unknown controller shutdown failure");
    }
  }

  async #rollbackFailedStart(): Promise<void> {
    if (this.#server !== null) {
      await this.#server.close().catch(() => undefined);
      this.#server = null;
    }
    if (this.#repository !== null && this.#lease !== null) {
      try {
        this.#repository.releaseLease({
          ownerId: this.#ownerId,
          fencingToken: this.#lease.fencingToken,
          now: safeTimestamp(this.#clock(), "startup rollback time"),
        });
      } catch {
        // The lease may already be expired or fenced by another owner.
      }
    }
    removeOwnedDescriptor(this.#paths.descriptorPath, this.#ownerId);
    this.#repository?.close();
    this.#repository = null;
    this.#lease = null;
    this.#authToken = null;
    this.#state = "stopped";
  }

  #buildDescriptor(lease: ControllerLease): ControllerRuntimeDescriptor {
    if (this.#startedAt === null) {
      throw new ControllerRuntimeError("Controller start time is unavailable");
    }
    return Object.freeze({
      schemaVersion: CONTROLLER_RUNTIME_SCHEMA_VERSION,
      runId: this.#runId,
      ownerId: this.#ownerId,
      processId: this.#processId,
      processStartIdentity: this.#processStartIdentity,
      startedAt: this.#startedAt,
      leaseExpiresAt: lease.expiresAt,
      fencingToken: lease.fencingToken,
      recovery: this.#recoveryAssessment,
      runtimeDirectory: this.#paths.runtimeDirectory,
      databasePath: this.#paths.databasePath,
      socketPath: this.#paths.socketPath,
      tokenPath: this.#paths.tokenPath,
    });
  }
}
