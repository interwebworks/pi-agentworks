import type { AgentMessage } from "./agent-communication.ts";

export type SupervisorReaction =
  | { readonly type: "none" }
  | {
      readonly type: "attention-required";
      readonly runId: string;
      readonly agentId: string;
      readonly reason: string;
    };

const NONE: SupervisorReaction = Object.freeze({ type: "none" });

/**
 * Map child-reported failures into a durable supervisor signal.
 * Successful progress and lifecycle messages intentionally do not create
 * attention noise; the supervisor can observe those through state/events.
 */
export function reactionForAgentMessage(
  message: AgentMessage,
): SupervisorReaction {
  switch (message.type) {
    case "agent-blocked":
      return Object.freeze({
        type: "attention-required",
        runId: message.runId,
        agentId: message.agentId,
        reason: message.detail,
      });
    case "operation-completed":
      return message.success
        ? NONE
        : Object.freeze({
            type: "attention-required",
            runId: message.runId,
            agentId: message.agentId,
            reason: "child operation reported failure",
          });
    default:
      return NONE;
  }
}
