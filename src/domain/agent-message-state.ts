import { transitionAgent, type AgentState } from "./controller-state.ts";
import type { AgentMessage } from "./agent-communication.ts";

export class InvalidAgentMessageStateError extends Error {
  constructor(message: string) {
    super(`Agent message state transition failed: ${message}`);
    this.name = "InvalidAgentMessageStateError";
  }
}

export interface AgentMessageStateResult {
  readonly agent: AgentState;
  readonly changed: boolean;
}

function unchanged(agent: AgentState): AgentMessageStateResult {
  return Object.freeze({ agent, changed: false });
}

/**
 * Apply the stateful subset of an authenticated child message.
 *
 * This reducer deliberately does not process supervisor-directed messages or
 * infer completion from session shutdown: those require controller-owned
 * policy and are handled by the transport/orchestration layer.
 */
export function applyAgentMessage(
  current: AgentState,
  message: AgentMessage,
  at: number,
): AgentMessageStateResult {
  if (message.runId !== current.runId || message.agentId !== current.id) {
    throw new InvalidAgentMessageStateError(
      "message identity does not match the agent state",
    );
  }

  switch (message.type) {
    case "session-started": {
      if (message.piSessionPath === null) return unchanged(current);
      if (
        current.status === "idle" &&
        current.piSessionPath === message.piSessionPath
      ) {
        return unchanged(current);
      }
      return Object.freeze({
        agent: transitionAgent(current, {
          type: "session-ready",
          at,
          piSessionPath: message.piSessionPath,
        }),
        changed: true,
      });
    }
    case "operation-started":
      return Object.freeze({
        agent: transitionAgent(current, {
          type: "operation-started",
          at,
          operation: message.taskId ?? "agent operation",
        }),
        changed: true,
      });
    case "operation-progress":
      return Object.freeze({
        agent: transitionAgent(current, { type: "heartbeat", at }),
        changed: true,
      });
    case "operation-completed":
      return Object.freeze({
        agent: message.success
          ? transitionAgent(current, { type: "operation-finished", at })
          : transitionAgent(current, {
              type: "agent-failed",
              at,
              reason: "child operation reported failure",
            }),
        changed: true,
      });
    case "heartbeat":
      return Object.freeze({
        agent: transitionAgent(current, { type: "heartbeat", at }),
        changed: true,
      });
    case "agent-blocked":
      return Object.freeze({
        agent: transitionAgent(current, {
          type: "agent-blocked",
          at,
          reason: message.detail,
        }),
        changed: true,
      });
    case "session-shutdown":
      return unchanged(current);
    case "supervisor-nudge":
    case "supervisor-completion":
    case "supervisor-error":
      throw new InvalidAgentMessageStateError(
        `controller-directed message ${message.type} cannot update child state`,
      );
  }
}
