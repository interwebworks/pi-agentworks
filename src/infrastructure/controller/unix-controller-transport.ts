import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { JsonValue } from "../../application/ports/controller-repository.ts";
import {
  assertBoundedJsonValue,
  CONTROLLER_PROTOCOL_VERSION,
  ControllerFrameDecoder,
  DEFAULT_MAX_FRAME_BYTES,
  encodeControllerFrame,
  InvalidControllerProtocolMessageError,
  parseControllerRequest,
  parseControllerResponse,
  type ControllerClientKind,
  type ControllerErrorResponse,
  type ControllerRequest,
  type ControllerResponse,
} from "../../application/protocol/controller-protocol.ts";
import type { AgentHelloRequest } from "../../application/protocol/controller-protocol-extension.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_MAX_QUEUED_FRAMES = 8;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export class ControllerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControllerTransportError";
  }
}

export class ControllerRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(code)) {
      throw new ControllerTransportError("Request error code is invalid");
    }
    if (message.length < 1 || message.length > 512) {
      throw new ControllerTransportError(
        "Request error message length is invalid",
      );
    }
    super(message);
    this.name = "ControllerRequestError";
    this.code = code;
  }
}

export class ControllerRemoteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ControllerRemoteError";
    this.code = code;
  }
}

export interface UnixControllerServerOptions {
  readonly socketPath: string;
  readonly runId: string;
  readonly authToken: string;
  readonly maxFrameBytes?: number;
  readonly maxConnections?: number;
  readonly maxQueuedFrames?: number;
  readonly idleTimeoutMs?: number;
  readonly authorizeIdentity: (
    request: ControllerRequest,
  ) => boolean | Promise<boolean>;
  readonly handleRequest: (
    request: ControllerRequest,
  ) => JsonValue | Promise<JsonValue>;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ControllerTransportError(`${label} cannot be empty`);
  }
  return normalized;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ControllerTransportError(
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function safeTokenMatch(candidate: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(tokenDigest(candidate), expectedDigest);
}

export function deriveChildAuthToken(
  controllerAuthToken: string,
  runId: string,
  agentId: string,
): string {
  const token = nonEmpty(
    controllerAuthToken,
    "controller authentication token",
  );
  if (token.length < 32 || token.length > 512) {
    throw new ControllerTransportError(
      "Controller authentication token length must be from 32 to 512 characters",
    );
  }
  const identity = JSON.stringify([
    nonEmpty(runId, "run id"),
    nonEmpty(agentId, "agent id"),
  ]);
  return createHmac("sha256", token)
    .update("agentworks-child-v1\0", "utf8")
    .update(identity, "utf8")
    .digest("base64url");
}

function validateSocketPath(socketPath: string): string {
  const normalized = resolve(nonEmpty(socketPath, "controller socket path"));
  if (Buffer.byteLength(normalized, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new ControllerTransportError(
      `Controller socket path exceeds ${String(MAX_UNIX_SOCKET_PATH_BYTES)} bytes`,
    );
  }
  return normalized;
}

function protocolErrorResponse(
  requestId: string,
  code: string,
  message: string,
): ControllerErrorResponse {
  return Object.freeze({
    protocolVersion: CONTROLLER_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

export class UnixControllerServer {
  readonly #socketPath: string;
  readonly #runId: string;
  readonly #authToken: string;
  readonly #authTokenDigest: Buffer;
  readonly #maxFrameBytes: number;
  readonly #maxConnections: number;
  readonly #maxQueuedFrames: number;
  readonly #idleTimeoutMs: number;
  readonly #authorizeIdentity: UnixControllerServerOptions["authorizeIdentity"];
  readonly #handleRequest: UnixControllerServerOptions["handleRequest"];
  readonly #server: Server;
  readonly #connections = new Set<Socket>();
  readonly #lastSequences = new Map<string, number>();
  #listening = false;
  #socketIdentity: { readonly device: number; readonly inode: number } | null =
    null;

  constructor(options: UnixControllerServerOptions) {
    this.#socketPath = validateSocketPath(options.socketPath);
    this.#runId = nonEmpty(options.runId, "run id");
    const authToken = nonEmpty(options.authToken, "authentication token");
    if (authToken.length < 32 || authToken.length > 512) {
      throw new ControllerTransportError(
        "Authentication token length must be from 32 to 512 characters",
      );
    }
    this.#authToken = authToken;
    this.#authTokenDigest = tokenDigest(authToken);
    this.#maxFrameBytes = positiveSafeInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "maximum frame bytes",
    );
    this.#maxConnections = positiveSafeInteger(
      options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      "maximum connections",
    );
    this.#maxQueuedFrames = positiveSafeInteger(
      options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES,
      "maximum queued frames",
    );
    this.#idleTimeoutMs = positiveSafeInteger(
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      "idle timeout",
    );
    this.#authorizeIdentity = options.authorizeIdentity;
    this.#handleRequest = options.handleRequest;
    this.#server = createServer((socket) => this.#acceptConnection(socket));
    this.#server.maxConnections = this.#maxConnections;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async listen(): Promise<void> {
    if (this.#listening) {
      throw new ControllerTransportError(
        "Controller socket server is already listening",
      );
    }
    const directory = dirname(this.#socketPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStatus = lstatSync(directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
      throw new ControllerTransportError(
        "Controller socket directory must be a real directory",
      );
    }
    chmodSync(directory, 0o700);
    if (existsSync(this.#socketPath)) {
      throw new ControllerTransportError(
        "Controller socket path already exists and will not be replaced automatically",
      );
    }

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        rejectListen(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolveListen();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#socketPath);
    });
    chmodSync(this.#socketPath, 0o600);
    const socketStatus = lstatSync(this.#socketPath);
    this.#socketIdentity = {
      device: socketStatus.dev,
      inode: socketStatus.ino,
    };
    this.#listening = true;
  }

  async close(): Promise<void> {
    for (const connection of this.#connections) connection.destroy();
    this.#connections.clear();

    if (this.#listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        this.#server.close((error) => {
          if (error === undefined) resolveClose();
          else rejectClose(error);
        });
      });
      this.#listening = false;
    }
    if (existsSync(this.#socketPath) && this.#socketIdentity !== null) {
      const status = lstatSync(this.#socketPath);
      if (
        status.isSocket() &&
        !status.isSymbolicLink() &&
        status.dev === this.#socketIdentity.device &&
        status.ino === this.#socketIdentity.inode
      ) {
        unlinkSync(this.#socketPath);
      }
    }
    this.#socketIdentity = null;
  }

  #acceptConnection(socket: Socket): void {
    if (this.#connections.size >= this.#maxConnections) {
      socket.destroy();
      return;
    }
    this.#connections.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(this.#idleTimeoutMs);
    const decoder = new ControllerFrameDecoder(
      this.#maxFrameBytes,
      this.#maxQueuedFrames,
    );
    let queuedFrames = 0;
    let chain = Promise.resolve();

    const rejectTransport = (): void => {
      socket.destroy();
    };

    socket.on("timeout", rejectTransport);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      this.#connections.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      let messages: readonly unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        rejectTransport();
        return;
      }
      if (queuedFrames + messages.length > this.#maxQueuedFrames) {
        rejectTransport();
        return;
      }
      queuedFrames += messages.length;
      for (const message of messages) {
        chain = chain
          .then(async () => this.#processMessage(socket, message))
          .catch(() => {
            rejectTransport();
          })
          .finally(() => {
            queuedFrames -= 1;
          });
      }
    });
  }

  async #processMessage(socket: Socket, value: unknown): Promise<void> {
    let request: ControllerRequest;
    try {
      request = parseControllerRequest(value);
    } catch (error) {
      if (error instanceof InvalidControllerProtocolMessageError) {
        const requestId = this.#plausibleRequestId(value);
        if (requestId !== null) {
          this.#sendAndClose(
            socket,
            protocolErrorResponse(
              requestId,
              "invalid-request",
              "Request rejected",
            ),
          );
        } else {
          socket.destroy();
        }
        return;
      }
      throw error;
    }

    const expectedTokenDigest =
      request.clientKind === "child" && request.agentId !== null
        ? tokenDigest(
            deriveChildAuthToken(
              this.#authToken,
              request.runId,
              request.agentId,
            ),
          )
        : this.#authTokenDigest;
    if (
      request.runId !== this.#runId ||
      !safeTokenMatch(request.authToken, expectedTokenDigest) ||
      !(await this.#authorizeIdentity(request))
    ) {
      this.#sendAndClose(
        socket,
        protocolErrorResponse(
          request.requestId,
          "unauthorized",
          "Request rejected",
        ),
      );
      return;
    }

    const sequenceKey = `${request.clientKind}:${request.clientId}`;
    const previousSequence = this.#lastSequences.get(sequenceKey) ?? 0;
    if (request.sequence <= previousSequence) {
      this.#sendAndClose(
        socket,
        protocolErrorResponse(
          request.requestId,
          "invalid-sequence",
          "Request sequence must increase",
        ),
      );
      return;
    }
    this.#lastSequences.set(sequenceKey, request.sequence);

    let response: ControllerResponse;
    try {
      const payload = await this.#handleRequest(request);
      assertBoundedJsonValue(payload);
      response = Object.freeze({
        protocolVersion: CONTROLLER_PROTOCOL_VERSION,
        kind: "response",
        requestId: request.requestId,
        ok: true,
        payload,
      });
    } catch (error) {
      if (error instanceof ControllerRequestError) {
        response = protocolErrorResponse(
          request.requestId,
          error.code,
          error.message,
        );
      } else {
        response = protocolErrorResponse(
          request.requestId,
          "internal-error",
          "Controller request failed",
        );
      }
    }
    socket.write(encodeControllerFrame(response, this.#maxFrameBytes));
  }

  #sendAndClose(socket: Socket, response: ControllerErrorResponse): void {
    socket.end(encodeControllerFrame(response, this.#maxFrameBytes));
  }

  #plausibleRequestId(value: unknown): string | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const requestId = (value as Readonly<Record<string, unknown>>).requestId;
    if (
      typeof requestId !== "string" ||
      requestId.length < 1 ||
      requestId.length > 128
    ) {
      return null;
    }
    return requestId;
  }
}

export interface UnixControllerClientOptions {
  readonly socketPath: string;
  readonly runId: string;
  readonly authToken: string;
  readonly clientId: string;
  readonly clientKind: ControllerClientKind;
  readonly agentId: string | null;
  readonly maxFrameBytes?: number;
}

export interface ControllerClientRequest {
  readonly action: string;
  readonly expectedRevision?: number | null;
  readonly idempotencyKey?: string | null;
  readonly payload: JsonValue;
}

export class UnixControllerClient {
  readonly #socketPath: string;
  readonly #runId: string;
  readonly #authToken: string;
  readonly #clientId: string;
  readonly #clientKind: ControllerClientKind;
  readonly #agentId: string | null;
  readonly #maxFrameBytes: number;
  readonly #decoder: ControllerFrameDecoder;
  #socket: Socket | null = null;
  #sequence = 0;
  #pending: {
    readonly requestId: string;
    readonly resolve: (value: JsonValue) => void;
    readonly reject: (error: Error) => void;
  } | null = null;

  constructor(options: UnixControllerClientOptions) {
    this.#socketPath = validateSocketPath(options.socketPath);
    this.#runId = nonEmpty(options.runId, "run id");
    this.#authToken = nonEmpty(options.authToken, "authentication token");
    this.#clientId = nonEmpty(options.clientId, "client id");
    this.#clientKind = options.clientKind;
    this.#agentId = options.agentId;
    this.#maxFrameBytes = positiveSafeInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "maximum frame bytes",
    );
    this.#decoder = new ControllerFrameDecoder(this.#maxFrameBytes, 1);
  }

  async connect(): Promise<void> {
    if (this.#socket !== null) {
      throw new ControllerTransportError(
        "Controller client is already connected",
      );
    }
    const socket = createConnection(this.#socketPath);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      const onConnect = (): void => {
        socket.off("error", onError);
        resolveConnect();
      };
      const onError = (error: Error): void => {
        socket.off("connect", onConnect);
        rejectConnect(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("error", (error) => this.#failPending(error));
    socket.on("close", () => {
      this.#socket = null;
      this.#failPending(
        new ControllerTransportError("Controller connection closed"),
      );
    });
    this.#socket = socket;
  }

  request(input: ControllerClientRequest): Promise<JsonValue> {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) {
      return Promise.reject(
        new ControllerTransportError("Controller client is not connected"),
      );
    }
    if (this.#pending !== null) {
      return Promise.reject(
        new ControllerTransportError(
          "Controller client permits one in-flight request",
        ),
      );
    }

    this.#sequence += 1;
    const requestId = randomUUID();
    const request: ControllerRequest = {
      protocolVersion: CONTROLLER_PROTOCOL_VERSION,
      kind: "request",
      requestId,
      runId: this.#runId,
      clientId: this.#clientId,
      clientKind: this.#clientKind,
      agentId: this.#agentId,
      sequence: this.#sequence,
      authToken: this.#authToken,
      action: input.action,
      expectedRevision: input.expectedRevision ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      payload: input.payload,
    };
    parseControllerRequest(request);

    return new Promise<JsonValue>((resolveRequest, rejectRequest) => {
      this.#pending = {
        requestId,
        resolve: resolveRequest,
        reject: rejectRequest,
      };
      socket.write(
        encodeControllerFrame(request, this.#maxFrameBytes),
        (error) => {
          if (error !== null && error !== undefined) this.#failPending(error);
        },
      );
    });
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
    this.#failPending(new ControllerTransportError("Controller client closed"));
  }

  #receive(chunk: Buffer): void {
    let messages: readonly unknown[];
    try {
      messages = this.#decoder.push(chunk);
    } catch (error) {
      this.#failPending(
        error instanceof Error
          ? error
          : new ControllerTransportError(String(error)),
      );
      this.close();
      return;
    }
    for (const value of messages) {
      let response: ControllerResponse;
      try {
        response = parseControllerResponse(value);
      } catch (error) {
        this.#failPending(
          error instanceof Error
            ? error
            : new ControllerTransportError(String(error)),
        );
        this.close();
        return;
      }
      const pending = this.#pending;
      if (pending?.requestId !== response.requestId) {
        this.#failPending(
          new ControllerTransportError("Unexpected controller response"),
        );
        this.close();
        return;
      }
      this.#pending = null;
      if (response.ok) pending.resolve(response.payload);
      else
        pending.reject(
          new ControllerRemoteError(
            response.error.code,
            response.error.message,
          ),
        );
    }
  }

  #failPending(error: Error): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    pending.reject(error);
  }
}
