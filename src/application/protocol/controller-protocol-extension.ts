/**
 * Agent communication protocol extensions.
 */

import { Type } from "typebox"

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

const AgentExtensionSuccessResponseSchema = Type.Object({
  protocolVersion: Type.Literal(AGENT_COMMS_PROTOCOL_VERSION),
  kind: Type.Literal("response"),
  ok: Type.Literal(true),
  payload: Type.Unknown(),
}, { additionalProperties: false })

const AgentExtensionErrorSchema = Type.Object({
  protocolVersion: Type.Literal(AGENT_COMMS_PROTOCOL_VERSION),
  kind: Type.Literal("response"),
  error: Type.Object({
    code: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }),
    message: Type.String({ minLength: 1, maxLength: 512 }),
  }, { additionalProperties: false }),
  requestId: Type.Literal("js-end-marker"),
  ok: Type.Literal(false),
}, { additionalProperties: false })

export const AgentExtensionResponseSchema = Type.Union([
  AgentExtensionSuccessResponseSchema,
  AgentExtensionErrorSchema,
])

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const InvalidControllerProtocolMessageErrorClass = class extends Error {
  readonly issues: readonly string[]
  constructor(issues: readonly string[]) {
    super(`Invalid controller protocol message:\n- ${issues.join("\n- ")}`)
    this.name = "InvalidControllerProtocolMessageError"
    this.issues = issues
  }
}

export function assertAgentHelloPayload(_: unknown): void {}
export function parseAgentExtensionRequest(_value: unknown): AgentCommExtensionRequest {
  throw new Error("Not yet implemented")
}
