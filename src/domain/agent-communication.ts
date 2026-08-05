/**
 * Agent communication messages for lifecycle, operation, progress, and supervisor interactions.
 */

export const AGENT_COMMS_PROTOCOL_VERSION = 1 as const

export const SESSION_STATE_READY = "ready"
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
  | { type: "operation_start"; runId: string; agentId: string; taskId: string | null }
  | { type: "operation_progress"; runId: string; agentId: string; taskId: string | null; output: string | null }
  | { type: "operation_complete"; runId: string; agentId: string; taskId: string | null; success: boolean; revision: number | null }

export type HeartbeatMessage =
  | { type: "heartbeat"; runId: string; agentId: string; elapsedMs: number; revision: number | null }

export type SupervisorMessage =
  | { type: "supervisor_nudge"; runId: string; agentId: string; reason: "idle" | "blocked" | "timeout" }
  | { type: "supervisor_completion"; runId: string; agentId: string; outcome: "success" | "early" | "over"; revision: number | null }
  | { type: "supervisor_error"; runId: string; agentId: string; code: string; message: string }

export type OperationResult =
  | { type: "result_for_sending"; runId: string; agentId: string; stage: "launch" | "ready" | "waiting" | "blocked" | "running" | "complete" | "shutting_down" | "shutdown" | "recovery"; output?: string | null; elapsedMs?: number | null }
  | { type: "result_for_sending"; runId: string; agentId: string; stage: "supervisor"; data: SupervisorData }

export type AgentCommunicationMessage = SessionLifecycleMessage | OperationProgressMessage | HeartbeatMessage | SupervisorMessage | OperationResult

export function createSupervisorPayload(runId: string, agentId: string, data: SupervisorData): SupervisorPayload {
  return {
    runId,
    agentId,
    message: data,
  }
}

export function createSessionShutdown(runId: string, agentId: string, sessionId: string): string {
  return JSON.stringify({
    type: "session_shutdown",
    runId,
    agentId,
    sessionId,
  })
}

export function parseSessionShutdownMessage(text: string): string | null {
  try {
    const { type, runId, agentId } = JSON.parse(text) as any
    if (typeof type === "string" && type === "session_shutdown" && typeof runId === "string" && typeof agentId === "string") {
      return JSON.stringify({
        type: "session_shutdown",
        runId,
        agentId,
        sessionId: "ok",
      })
    }
    return null
  } catch {
    return null
  }
}
