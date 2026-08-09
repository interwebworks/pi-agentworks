import type { AgentMessage } from "../../domain/agent-communication.ts";
import {
  applyAgentMessage,
  type AgentMessageStateResult,
} from "../../domain/agent-message-state.ts";
import {
  reactionForAgentMessage,
  type SupervisorReaction,
} from "../../domain/supervisor-reaction.ts";
import type {
  ControllerEventInput,
  ControllerRepository,
  FencedWrite,
} from "../ports/controller-repository.ts";

export class AgentMessageControllerError extends Error {
  constructor(message: string) {
    super(`Agent message controller failed: ${message}`);
    this.name = "AgentMessageControllerError";
  }
}

export interface AgentMessageCommitResult {
  readonly revision: number;
  readonly changed: boolean;
  readonly replayed: boolean;
  readonly reaction: SupervisorReaction;
}

function messageEvent(
  message: AgentMessage,
  requestId: string,
  occurredAt: number,
): ControllerEventInput {
  const payload =
    message.type === "review-submitted"
      ? Object.freeze({
          type: message.type,
          outcome: message.outcome,
          candidateStoryHead: message.candidateStoryHead,
          integrationHead: message.integrationHead,
        })
      : Object.freeze({ type: message.type });
  return Object.freeze({
    eventId: requestId,
    type: `agent-${message.type}`,
    entityType: "agent",
    entityId: message.agentId,
    payload,
    occurredAt,
  });
}

function requiresDurableControllerHandling(message: AgentMessage): boolean {
  return ["candidate-ready", "review-submitted", "session-shutdown"].includes(
    message.type,
  );
}

/** Applies authenticated child messages through the fenced repository boundary. */
export class AgentMessageController {
  readonly #repository: ControllerRepository;
  readonly #clock: () => number;

  constructor(repository: ControllerRepository, clock: () => number) {
    this.#repository = repository;
    this.#clock = clock;
  }

  apply(
    message: AgentMessage,
    write: FencedWrite,
    requestId: string,
  ): AgentMessageCommitResult {
    const snapshot = this.#repository.loadSnapshot(message.runId);
    if (snapshot === null) {
      throw new AgentMessageControllerError(`unknown run ${message.runId}`);
    }
    const agent = snapshot.agents.find(
      (candidate) => candidate.id === message.agentId,
    );
    if (agent === undefined) {
      throw new AgentMessageControllerError(`unknown agent ${message.agentId}`);
    }

    const at = this.#clock();
    let state: AgentMessageStateResult;
    try {
      state = applyAgentMessage(agent, message, at);
    } catch (error) {
      throw new AgentMessageControllerError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const reaction = reactionForAgentMessage(message);
    const durableControlSignal = requiresDurableControllerHandling(message);
    if (!state.changed && !durableControlSignal) {
      return Object.freeze({
        revision: snapshot.revision,
        changed: false,
        replayed: false,
        reaction,
      });
    }

    const events = [messageEvent(message, requestId, at)];
    if (reaction.type === "attention-required") {
      events.push({
        eventId: `${requestId}-supervisor`,
        type: "supervisor-attention-required",
        entityType: "agent",
        entityId: message.agentId,
        payload: Object.freeze({ reason: reaction.reason }),
        occurredAt: at,
      });
    }
    const result = this.#repository.commitSnapshot({
      write,
      runId: message.runId,
      expectedRevision: snapshot.revision,
      idempotencyKey: `agent-message-${requestId}`,
      request: Object.freeze({
        command: "agent.message",
        requestId,
        type: message.type,
      }),
      run: snapshot.run,
      stories: snapshot.stories,
      agents: snapshot.agents.map((candidate) =>
        candidate.id === state.agent.id ? state.agent : candidate,
      ),
      events,
    });
    return Object.freeze({
      revision: result.revision,
      changed: true,
      replayed: result.replayed,
      reaction,
    });
  }
}
