import type { JsonValue } from "../ports/controller-repository.ts";
import type { AgentMessage } from "../../domain/agent-communication.ts";
import { decodeAgentMessage } from "../../domain/agent-message-codec.ts";

export class InvalidAgentMessageRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentMessageRouteError";
  }
}

/**
 * Decode one authenticated child message and bind its declared identity to the
 * identity already authenticated by the controller transport.
 */
export function decodeAuthenticatedAgentMessage(
  payload: JsonValue,
  expectedRunId: string,
  expectedAgentId: string,
): AgentMessage {
  let message: AgentMessage;
  try {
    message = decodeAgentMessage(JSON.stringify(payload));
  } catch (error) {
    throw new InvalidAgentMessageRouteError(
      error instanceof Error ? error.message : "Child agent message is invalid",
    );
  }
  if (message.runId !== expectedRunId || message.agentId !== expectedAgentId) {
    throw new InvalidAgentMessageRouteError(
      "Child agent message identity does not match the authenticated request",
    );
  }
  return message;
}
