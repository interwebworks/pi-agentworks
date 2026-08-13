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
    case "operation-completed": {
      if (message.success && current.status === "blocked") {
        const resumed = transitionAgent(current, {
          type: "agent-unblocked",
          at,
          operation: "agent operation",
        });
        return Object.freeze({
          agent: transitionAgent(resumed, { type: "operation-finished", at }),
          changed: true,
        });
      }
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
    }
    case "heartbeat":
      return Object.freeze({
        agent: transitionAgent(current, { type: "heartbeat", at }),
        changed: true,
      });
    case "agent-blocked":
      // Tool hooks and explicit child status reports can describe the same
      // blocker. The first report is authoritative; repeats must not turn an
      // already-visible blocker into a transport failure.
      if (current.status === "blocked") return unchanged(current);
      return Object.freeze({
        agent: transitionAgent(current, {
          type: "agent-blocked",
          at,
          reason: message.detail,
        }),
        changed: true,
      });
    case "agent-unblocked":
      if (current.status !== "blocked") return unchanged(current);
      return Object.freeze({
        agent: transitionAgent(current, {
          type: "agent-unblocked",
          at,
          operation: message.operation,
        }),
        changed: true,
      });
    case "session-shutdown":
    case "candidate-ready":
    case "review-submitted":
      return unchanged(current);
    case "supervisor-nudge":
    case "supervisor-completion":
    case "supervisor-error":
      throw new InvalidAgentMessageStateError(
        `controller-directed message ${message.type} cannot update child state`,
      );
  }
}
