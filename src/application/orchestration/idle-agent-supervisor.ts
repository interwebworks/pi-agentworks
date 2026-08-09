import { randomUUID } from "node:crypto";
import type {
  ControllerSnapshot,
  ControllerEventInput,
  ControllerRepository,
  FencedWrite,
} from "../ports/controller-repository.ts";
import type { HerdrGateway } from "../ports/herdr-gateway.ts";
import {
  assessAgentLiveness,
  transitionAgent,
  type AgentState,
} from "../../domain/controller-state.ts";

export interface IdleAgentSupervisionResult {
  readonly action: "none" | "nudge" | "escalate";
  readonly agentId?: string;
  readonly reason?: string;
  readonly revision: number;
}

export interface IdleAgentSupervisorDependencies {
  readonly repository: ControllerRepository;
  readonly herdr: Pick<HerdrGateway, "getPane" | "sendText">;
  readonly clock: () => number;
}

/**
 * Sends at most one bounded liveness nudge per orchestration tick. The pane
 * token check is deliberately exact: an idle agent never receives input from
 * a pane that has been reused for another run or agent.
 */
export class IdleAgentSupervisor {
  readonly #repository: ControllerRepository;
  readonly #herdr: Pick<HerdrGateway, "getPane" | "sendText">;
  readonly #clock: () => number;

  constructor(dependencies: IdleAgentSupervisorDependencies) {
    this.#repository = dependencies.repository;
    this.#herdr = dependencies.herdr;
    this.#clock = dependencies.clock;
  }

  async supervise(
    snapshot: ControllerSnapshot,
    write: FencedWrite,
  ): Promise<IdleAgentSupervisionResult> {
    for (const agent of snapshot.agents) {
      const decision = assessAgentLiveness(agent, write.now);
      if (decision.action === "none") continue;
      if (decision.action === "nudge") {
        if (agent.paneId === null) continue;
        const pane = await this.#herdr.getPane(agent.paneId);
        if (
          pane.tokens.aw_kind !== "agent" ||
          pane.tokens.aw_run !== snapshot.run.id ||
          pane.tokens.aw_agent !== agent.id
        ) {
          continue;
        }
        await this.#herdr.sendText(agent.paneId, ".");
        const nudged = transitionAgent(agent, {
          type: "nudge-sent",
          at: this.#clock(),
        });
        const result = this.#commit(snapshot, write, nudged, "agent-nudged", {
          attempt: decision.attempt,
        });
        return Object.freeze({
          action: "nudge",
          agentId: agent.id,
          revision: result.revision,
        });
      }
      const blocked = transitionAgent(agent, {
        type: "agent-blocked",
        at: this.#clock(),
        reason: `idle supervision: ${decision.reason}`,
      });
      const result = this.#commit(
        snapshot,
        write,
        blocked,
        "agent-liveness-escalated",
        { reason: decision.reason },
      );
      return Object.freeze({
        action: "escalate",
        agentId: agent.id,
        reason: decision.reason,
        revision: result.revision,
      });
    }
    return Object.freeze({ action: "none", revision: snapshot.revision });
  }

  #commit(
    snapshot: ControllerSnapshot,
    write: FencedWrite,
    agent: AgentState,
    type: string,
    payload: Record<string, string | number>,
  ) {
    const events: readonly ControllerEventInput[] = [
      {
        eventId: randomUUID(),
        type,
        entityType: "agent",
        entityId: agent.id,
        payload,
        occurredAt: agent.updatedAt,
      },
    ];
    return this.#repository.commitSnapshot({
      write,
      runId: snapshot.run.id,
      expectedRevision: snapshot.revision,
      idempotencyKey: `idle-supervision-r${String(snapshot.revision)}-${agent.id}`,
      request: { command: "idle-supervision", agentId: agent.id },
      run: snapshot.run,
      stories: snapshot.stories,
      agents: snapshot.agents.map((candidate) =>
        candidate.id === agent.id ? agent : candidate,
      ),
      events,
    });
  }
}
