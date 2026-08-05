import { type Static, Type } from "typebox"
import { Check, Errors } from "typebox/value"
import type { JsonValue } from "../ports/controller-repository.ts"

/**
 * Agent communication protocol extensions.
 */

export const AGENT_COMMS_PROTOCOL_VERSION = 1 as const

export interface AgentHelloRequest {
  readonly protocolVersion: typeof AGENT_COMMS_PROTOCOL_VERSION
  readonly action: "agent.hello"
  readonly payload: {
    runId: string
    agentId: string
    sessionId: string
    state: string
    operation: {
      type: "idle" | "running" | "complete" | "failed"
      revision: number | null
      exitCode: number | null
      taskId: string | null
      reason: string | null
    }
  }
}

export interface AgentHelloResponseData {
  readonly runId: string
  readonly agentId: string
  readonly revision: number | null
  readonly status: string
}

export interface SessionShutdownRequest {
  readonly protocolVersion: typeof AGENT_COMMS_PROTOCOL_VERSION
  readonly action: "session.shutdown"
  readonly payload: {
    runId: string
    agentId: string
    sessionId: string
  }
}

export interface OperationHeartbeatRequest {
  readonly protocolVersion: typeof AGENT_COMMS_PROTOCOL_VERSION
  readonly action: "operation.heartbeat"
  readonly payload: {
    runId: string
    agentId: string
    sessionId: string
    taskId: string | null
    revision: number | null
    exitCode: number | null
    elapsedMs: number
  }
}

export type AgentCommExtensionRequest =
  | AgentHelloRequest
  | SessionShutdownRequest
  | OperationHeartbeatRequest

const AgentExtensionSuccessResponseSchema = Type.Object(
  {
    protocolVersion: Type.Literal(AGENT_COMMS_PROTOCOL_VERSION),
    kind: Type.Literal("response"),
    ok: Type.Literal(true),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
)

const AgentExtensionErrorSchema = Type.Union([
  Type.Object(
    {
      protocolVersion: Type.Literal(AGENT_COMMS_PROTOCOL_VERSION),
      kind: Type.Literal("response"),
      error: Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }),
          message: Type.String({ minLength: 1, maxLength: 512 }),
        },
        { additionalProperties: false },
      ),
      requestId: Type.Literal("js-end-marker"),
      ok: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      error: Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }),
          message: Type.String({ minLength: 1, maxLength: 512 }),
        },
        { additionalProperties: false },
      ),
      kind: Type.Literal("error"),
      requestId: Type.Literal("js-end-marker"),
      version: Type.Literal(AGENT_COMMS_PROTOCOL_VERSION),
    },
    { additionalProperties: false },
  ),
])

export const AgentExtensionResponseSchema = Type.Union([
  AgentExtensionSuccessResponseSchema,
  AgentExtensionErrorSchema,
])

/**
 * Supervisor messages for bound supervisor-to-child control.
 */

export const SUPERVISOR_MESSAGE_PAYLOAD_MAX_BYTES = 32 * 1024

export interface SupervisorNudgeMessage {
  readonly runId: string
  readonly agentId: string
  readonly reason: "idle" | "blocked" | "timeout"
}

export interface SupervisorCompletionMessage {
  readonly runId: string
  readonly agentId: string
  readonly outcome: "success" | "early" | "over"
  readonly revision: number | null
}

export interface SupervisorError_Message {
  readonly runId: string
  readonly agentId: string
  readonly code: string
  readonly message: string
}

export type SupervisorPayload =
  | {
      type: "nudge"
      data: SupervisorNudgeMessage
    }
  | {
      type: "completion"
      data: SupervisorCompletionMessage
    }
  | {
      type: "error"
      data: SupervisorError_Message
    }

export interface SupervisorMessagePayload {
  readonly runId: string
  readonly agentId: string
  readonly message: SupervisorPayload
}

/**
 * Pedestrian result messages.
 */

export interface OperationResult {
  readonly runId: string
  readonly agentId: string
  readonly stage:
    | "launch"
    | "ready"
    | "waiting"
    | "blocked"
    | "running"
    | "complete"
    | "shutting_down"
    | "shutdown"
    | "recovery"
  readonly output?: string | null
  readonly elapsedMs?: number | null
}

/**
 * Assert that this value is a proper agent communication payload.
 */

export function assertAgentHelloPayload(
  value: unknown,
  maxDepth = 2,
  maxNodes = 1_000,
): asserts value is AgentCommExtensionRequest | SupervisorMessagePayload {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new Error("JSON depth limit must be a positive safe integer")
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new Error("JSON node limit must be a positive safe integer")
  }

  const pending:
    | { readonly value: unknown; readonly depth: number; readonly count: number }
    | undefined = { value, depth: 0, count: 0 }
  let visited = 0

  while (pending) {
    const item = (pending as { readonly value: unknown }).value
    if (item === undefined) break
    if (item === null) {
      pending = undefined
      continue
    }
    if (
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      if (visited++ > maxNodes) {
        throw new Error(`JSON payload exceeds ${String(maxNodes)} nodes`)
      }
      pending = undefined
      continue
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new Error("JSON payload numbers must be finite")
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        pending = { value: child, depth: (pending as { readonly depth: number }).depth + 1, count: 0 }
        if (pending.depth > maxDepth) {
          throw new Error(`JSON payload exceeds depth ${String(maxDepth)}`)
        }
        if (pending.count > maxNodes) {
          throw new Error(`JSON payload exceeds ${String(maxNodes)} nodes`)
        }
      }
      continue
    }
    if (typeof item === "object") {
      const { keys } = Object
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("JSON payload objects must have a plain prototype")
      }
      for (const child of keys(item)) {
        pending = {
          value: item,
          depth: (pending?.depth ?? 0) + 1,
          count: (pending?.count ?? 0) + 1,
        }
        if (pending.depth > maxDepth) {
          throw new Error(`JSON payload exceeds depth ${String(maxDepth)}`)
        }
        if (pending.count > maxNodes) {
          throw new Error(`JSON payload exceeds ${String(maxNodes)} nodes`)
        }
      }
      continue
    }
    throw new Error(`JSON payload contains unsupported value type ${typeof item}`)
  }
}

/**
 * Parse an agent extension request into a typed variant.
 */

export function parseAgentExtensionRequest(
  value: unknown,
): AgentCommExtensionRequest {
  if (!Check(
    Type.Union([
      AgentHelloRequest,
      SessionShutdownRequest,
      OperationHeartbeatRequest,
    ]),
    value,
  )) {
    const issues = Errors(
      Type.Union([
        AgentHelloRequest,
        SessionShutdownRequest,
        OperationHeartbeatRequest,
      ]),
      value,
    ).map((error) => `${error.instancePath || "/"}: ${error.message}`)
    throw new Error(`Invalid agent extension request:\n- ${issues.join("\n- ")}`)
  }
  assertAgentHelloPayload(value)
  return Object.freeze(value as AgentCommExtensionRequest)
}
