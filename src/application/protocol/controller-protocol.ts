import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { JsonValue } from "../ports/controller-repository.ts";

export const CONTROLLER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
export const DEFAULT_MAX_JSON_DEPTH = 32;
export const DEFAULT_MAX_JSON_NODES = 10_000;

const BoundedIdentifier = Type.String({ minLength: 1, maxLength: 128 });
const NullableIdentifier = Type.Union([Type.Null(), BoundedIdentifier]);
const NullableRevision = Type.Union([
  Type.Null(),
  Type.Integer({ minimum: 0 }),
]);
const NullableIdempotencyKey = Type.Union([
  Type.Null(),
  Type.String({ minLength: 1, maxLength: 256 }),
]);

export const ControllerRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(CONTROLLER_PROTOCOL_VERSION),
    kind: Type.Literal("request"),
    requestId: BoundedIdentifier,
    runId: BoundedIdentifier,
    clientId: BoundedIdentifier,
    clientKind: Type.Union([
      Type.Literal("parent"),
      Type.Literal("management"),
      Type.Literal("child"),
    ]),
    agentId: NullableIdentifier,
    sequence: Type.Integer({ minimum: 1 }),
    authToken: Type.String({ minLength: 32, maxLength: 512 }),
    action: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9.-]*$",
    }),
    expectedRevision: NullableRevision,
    idempotencyKey: NullableIdempotencyKey,
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

const ProtocolErrorSchema = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9-]*$",
    }),
    message: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export const ControllerSuccessResponseSchema = Type.Object(
  {
    protocolVersion: Type.Literal(CONTROLLER_PROTOCOL_VERSION),
    kind: Type.Literal("response"),
    requestId: BoundedIdentifier,
    ok: Type.Literal(true),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const ControllerErrorResponseSchema = Type.Object(
  {
    protocolVersion: Type.Literal(CONTROLLER_PROTOCOL_VERSION),
    kind: Type.Literal("response"),
    requestId: BoundedIdentifier,
    ok: Type.Literal(false),
    error: ProtocolErrorSchema,
  },
  { additionalProperties: false },
);

export const ControllerResponseSchema = Type.Union([
  ControllerSuccessResponseSchema,
  ControllerErrorResponseSchema,
]);

export type ControllerClientKind = "parent" | "management" | "child";

export interface ControllerRequest {
  readonly protocolVersion: typeof CONTROLLER_PROTOCOL_VERSION;
  readonly kind: "request";
  readonly requestId: string;
  readonly runId: string;
  readonly clientId: string;
  readonly clientKind: ControllerClientKind;
  readonly agentId: string | null;
  readonly sequence: number;
  readonly authToken: string;
  readonly action: string;
  readonly expectedRevision: number | null;
  readonly idempotencyKey: string | null;
  readonly payload: JsonValue;
}

export interface ControllerSuccessResponse {
  readonly protocolVersion: typeof CONTROLLER_PROTOCOL_VERSION;
  readonly kind: "response";
  readonly requestId: string;
  readonly ok: true;
  readonly payload: JsonValue;
}

export interface ControllerErrorResponse {
  readonly protocolVersion: typeof CONTROLLER_PROTOCOL_VERSION;
  readonly kind: "response";
  readonly requestId: string;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type ControllerResponse =
  ControllerSuccessResponse | ControllerErrorResponse;

export class InvalidControllerProtocolMessageError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid controller protocol message:\n- ${issues.join("\n- ")}`);
    this.name = "InvalidControllerProtocolMessageError";
    this.issues = issues;
  }
}

export class ControllerFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControllerFrameError";
  }
}

function validationIssues(
  schema: typeof ControllerRequestSchema | typeof ControllerResponseSchema,
  value: unknown,
): readonly string[] {
  return [...Errors(schema, value)].map(
    (error) => `${error.instancePath || "/"}: ${error.message}`,
  );
}

export function assertBoundedJsonValue(
  value: unknown,
  maxDepth = DEFAULT_MAX_JSON_DEPTH,
  maxNodes = DEFAULT_MAX_JSON_NODES,
): asserts value is JsonValue {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new InvalidControllerProtocolMessageError([
      "JSON depth limit must be a positive safe integer",
    ]);
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new InvalidControllerProtocolMessageError([
      "JSON node limit must be a positive safe integer",
    ]);
  }

  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 0 },
  ];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    visited += 1;
    if (visited > maxNodes) {
      throw new InvalidControllerProtocolMessageError([
        `JSON payload exceeds ${String(maxNodes)} nodes`,
      ]);
    }
    if (current.depth > maxDepth) {
      throw new InvalidControllerProtocolMessageError([
        `JSON payload exceeds depth ${String(maxDepth)}`,
      ]);
    }

    const item = current.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new InvalidControllerProtocolMessageError([
          "JSON payload numbers must be finite",
        ]);
      }
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof item === "object") {
      const prototype = Object.getPrototypeOf(item) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new InvalidControllerProtocolMessageError([
          "JSON payload objects must have a plain prototype",
        ]);
      }
      for (const child of Object.values(item)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    throw new InvalidControllerProtocolMessageError([
      `JSON payload contains unsupported value type ${typeof item}`,
    ]);
  }
}

export function parseControllerRequest(value: unknown): ControllerRequest {
  if (!Check(ControllerRequestSchema, value)) {
    throw new InvalidControllerProtocolMessageError(
      validationIssues(ControllerRequestSchema, value),
    );
  }
  assertBoundedJsonValue(value.payload);
  if (value.clientKind === "child" && value.agentId === null) {
    throw new InvalidControllerProtocolMessageError([
      "child clients require an agentId",
    ]);
  }
  if (value.clientKind !== "child" && value.agentId !== null) {
    throw new InvalidControllerProtocolMessageError([
      "parent and management clients cannot claim an agentId",
    ]);
  }
  return Object.freeze(value) as ControllerRequest;
}

export function parseControllerResponse(value: unknown): ControllerResponse {
  if (!Check(ControllerResponseSchema, value)) {
    throw new InvalidControllerProtocolMessageError(
      validationIssues(ControllerResponseSchema, value),
    );
  }
  if (value.ok) assertBoundedJsonValue(value.payload);
  return Object.freeze(value) as ControllerResponse;
}

export function encodeControllerFrame(
  value: unknown,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  assertFrameLimit(maxFrameBytes);
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new ControllerFrameError("Protocol frame is not JSON serializable");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ControllerFrameError("Protocol frame is not JSON serializable");
  }
  const payload = Buffer.from(serialized, "utf8");
  if (payload.length === 0 || payload.length > maxFrameBytes) {
    throw new ControllerFrameError(
      `Protocol frame length must be from 1 to ${String(maxFrameBytes)} bytes`,
    );
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function assertFrameLimit(maxFrameBytes: number): void {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new ControllerFrameError(
      "Maximum frame length must be a positive safe integer",
    );
  }
}

export class ControllerFrameDecoder {
  readonly #maxFrameBytes: number;
  readonly #maxQueuedFrames: number;
  #buffer = Buffer.alloc(0);

  constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, maxQueuedFrames = 8) {
    assertFrameLimit(maxFrameBytes);
    if (!Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames < 1) {
      throw new ControllerFrameError(
        "Maximum queued frames must be a positive safe integer",
      );
    }
    this.#maxFrameBytes = maxFrameBytes;
    this.#maxQueuedFrames = maxQueuedFrames;
  }

  push(chunk: Buffer): readonly unknown[] {
    if (chunk.length === 0) return [];
    const maximumBuffer = (this.#maxFrameBytes + 4) * this.#maxQueuedFrames;
    if (this.#buffer.length + chunk.length > maximumBuffer) {
      throw new ControllerFrameError("Protocol receive buffer limit exceeded");
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];

    while (this.#buffer.length >= 4) {
      const payloadLength = this.#buffer.readUInt32BE(0);
      if (payloadLength < 1 || payloadLength > this.#maxFrameBytes) {
        throw new ControllerFrameError(
          `Announced protocol frame length must be from 1 to ${String(this.#maxFrameBytes)} bytes`,
        );
      }
      const frameLength = payloadLength + 4;
      if (this.#buffer.length < frameLength) break;
      if (messages.length >= this.#maxQueuedFrames) {
        throw new ControllerFrameError("Protocol queued frame limit exceeded");
      }

      const payload = this.#buffer.subarray(4, frameLength);
      this.#buffer = this.#buffer.subarray(frameLength);
      try {
        messages.push(JSON.parse(payload.toString("utf8")) as unknown);
      } catch {
        throw new ControllerFrameError("Protocol frame contains invalid JSON");
      }
    }

    return Object.freeze(messages);
  }

  get bufferedBytes(): number {
    return this.#buffer.length;
  }
}

export type ControllerRequestShape = Static<typeof ControllerRequestSchema>;
