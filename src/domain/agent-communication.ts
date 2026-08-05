/**
 * Agent communication messages for lifecycle, operation, progress, and supervisor interactions.
 */

import { isEmptyObject, toJsonValue, type JsonValue } from "./workspace-naming.ts"

export const AGENT_COMMS_PROTOCOL_VERSION = 1 as const

const SessionStateReady = "ready"
export const SESSION_STATE_READY = SessionStateReady
export const SESSION_STATE_LAUNCHING = "launching"
export const SESSION_STATE_WAITING = "waiting"
export const SESSION_STATE_BLOCKED = "blocked"
export const SESSION_STATE_SHUTTING_DOWN = "shutting_down"

export const OPERATION_STATE_IDLE = "idle"
export const OPERATION_STATE_RUNNING = "running"
export const OPERATION_STATE_FAILED = "failed"
export const OPERATION_STATE_COMPLETE = "complete"

export type SupervisorData =
  | { type: "s"; runId: string; agentId: string; reason: "idle" | "blocked" | "timeout" }
  | { type: "c"; runId: string; agentId: string; outcome: "success" | "early" | "over"; revision: number | null }
  | { type: "e"; runId: string; agentId: string; code: string; message: string }

export interface SupervisorPayload {
  readonly runId: string
  readonly agentId: string
  readonly message: SupervisorData
}

export type SessionLifecycleMessage =
  | { type: "session_start"; runId: string; agentId: string; sessionId: string }
  | { type: "session_shutdown"; runId: string; agentId: string; sessionId: string }

export type OperationProgressMessage =
  | { type: "operation_start"
      readonly runId: string
      readonly agentId: string
      readonly taskId: string | null
    }
  | { type: "operation_progress"
      readonly runId: string
      readonly agentId: string
      readonly taskId: string | null
      readonly output: string | null
    }
  | { type: "operation_complete"
      readonly runId: string
      readonly agentId: string
      readonly taskId: string | null
      readonly success: boolean
      readonly revision: number | null
    }

export type HeartbeatMessage =
  | { type: "heartbeat"
      readonly runId: string
      readonly agentId: string
      readonly elapsedMs: number
      readonly revision: number | null
    }

export type SupervisorMessage =
  | { type: "supervisor_nudge"
      readonly runId: string
      readonly agentId: string
      readonly reason: "idle" | "blocked" | "timeout"
    }
  | {
      type: "supervisor_completion"
      readonly runId: string
      readonly agentId: string
      readonly outcome: "success" | "early" | "over"
      readonly revision: number | null
    }
  | {
      type: "supervisor_error"
      readonly runId: string
      readonly agentId: string
      readonly code: string
      readonly message: string
    }

export type OperationResult =
  | { type: "result_for_sending"
      readonly runId: string
      readonly agentId: string
      readonly stage: "launch" | "ready" | "waiting" | "blocked" | "running" | "complete" | "shutting_down" | "shutdown" | "recovery"
      readonly output: string | null
      readonly elapsedMs: number | null
    }
  | { type: "result_for_sending"
      readonly runId: string
      readonly agentId: string
      readonly stage: "supervisor"
      readonly data: SupervisorData
    }

export type AgentCommunicationMessage =
  | SessionLifecycleMessage
  | OperationProgressMessage
  | HeartbeatMessage
  | SupervisorMessage
  | OperationResult

export function createSupervisorPayload(runId: string, agentId: string, data: SupervisorData): SupervisorPayload {
  return Object.freeze({
    runId,
    agentId,
    message: data,
  })
}

export function createSessionShutdown(runId: string, agentId: string, sessionId: string): string {
  const message: {
    type: "session_shutdown"
    runId: string
    agentId: string
    sessionId: string
  } = Object.freeze({ type: "session_shutdown", runId, agentId, sessionId })
  return JSON.stringify(message)
}

export function parseSessionShutdownMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text)
    if (
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.type === "string" &&
      parsed.type === "session_shutdown"
    ) {
      return JSON.stringify({
        type: "session_shutdown",
        runId: parsed.runId,
        agentId: parsed.agentId,
        sessionId: parsed.sessionId,
      })
    }
    return null
  } catch {
    return null
  }
}
