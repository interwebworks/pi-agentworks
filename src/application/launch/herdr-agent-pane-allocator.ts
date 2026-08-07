import type { HerdrGateway, HerdrPane } from "../ports/herdr-gateway.ts";
import type {
  AgentPaneAssignment,
  AgentsTabEvidence,
  AgentsTabLifecycle,
} from "../herdr/agents-tab-lifecycle.ts";

export interface HerdrAgentPaneAllocationRequest {
  readonly runId: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly label: string;
  readonly cwd: string;
  readonly expectedTabId: string | null;
  readonly expectedPaneId: string | null;
  readonly metadataSequence: number;
  readonly expectedAgents?: readonly {
    readonly agentId: string;
    readonly paneId: string;
    readonly label: string;
    readonly cwd: string;
  }[];
}

export class HerdrAgentPaneAllocatorError extends Error {
  constructor(message: string) {
    super(`Herdr agent pane allocation failed: ${message}`);
    this.name = "HerdrAgentPaneAllocatorError";
  }
}

type PaneReader = Pick<HerdrGateway, "getPane" | "listPanes" | "closePane">;

interface ExistingAgentPane {
  readonly pane: HerdrPane;
  readonly slot: number;
  readonly assignment: AgentPaneAssignment;
}

function existingAgentPane(
  pane: HerdrPane,
  runId: string,
): ExistingAgentPane | null {
  if (pane.tokens.aw_kind !== "agent" || pane.tokens.aw_run !== runId) {
    return null;
  }
  if (pane.tokens.aw_operation !== runId) {
    throw new HerdrAgentPaneAllocatorError(
      `pane ${pane.paneId} has stale or spoofed grid operation ownership`,
    );
  }
  const slot = Number.parseInt(pane.tokens.aw_slot ?? "", 10);
  const agentId = pane.tokens.aw_agent;
  const label = pane.label ?? pane.displayAgent;
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    String(slot) !== pane.tokens.aw_slot ||
    agentId === undefined ||
    agentId.length === 0 ||
    label === null ||
    label.length === 0 ||
    pane.cwd === null
  ) {
    throw new HerdrAgentPaneAllocatorError(
      `pane ${pane.paneId} has incomplete grid ownership metadata`,
    );
  }
  return Object.freeze({
    pane,
    slot,
    assignment: Object.freeze({ agentId, label, cwd: pane.cwd }),
  });
}

/** Allocates one lifecycle-owned pane and re-verifies its final ownership. */
export class HerdrAgentPaneAllocator {
  readonly #lifecycle: Pick<AgentsTabLifecycle, "ensure">;
  readonly #herdr: PaneReader;

  constructor(
    lifecycle: Pick<AgentsTabLifecycle, "ensure">,
    herdr: PaneReader,
  ) {
    this.#lifecycle = lifecycle;
    this.#herdr = herdr;
  }

  async allocate(request: HerdrAgentPaneAllocationRequest): Promise<HerdrPane> {
    const livePanes = await this.#herdr.listPanes(request.workspaceId);
    const discovered = livePanes
      .map((pane) => existingAgentPane(pane, request.runId))
      .filter((pane): pane is ExistingAgentPane => pane !== null);
    let existing: ExistingAgentPane[];
    if (request.expectedAgents === undefined) {
      existing = discovered.sort((left, right) => left.slot - right.slot);
    } else {
      const expectedIds = new Set(
        request.expectedAgents.map((agent) => agent.agentId),
      );
      if (expectedIds.size !== request.expectedAgents.length) {
        throw new HerdrAgentPaneAllocatorError(
          "controller agent roster contains duplicate identities",
        );
      }
      const unknown = discovered.find(
        (candidate) =>
          !expectedIds.has(candidate.assignment.agentId) &&
          candidate.assignment.agentId !== request.agentId,
      );
      if (unknown !== undefined) {
        throw new HerdrAgentPaneAllocatorError(
          `pane ${unknown.pane.paneId} is absent from the controller agent roster`,
        );
      }
      for (const expected of request.expectedAgents) {
        const candidate = discovered.find(
          (pane) => pane.assignment.agentId === expected.agentId,
        );
        if (candidate === undefined) {
          throw new HerdrAgentPaneAllocatorError(
            `controller agent ${expected.agentId} has no live pane`,
          );
        }
        if (
          candidate.pane.paneId !== expected.paneId ||
          candidate.assignment.cwd !== expected.cwd
        ) {
          throw new HerdrAgentPaneAllocatorError(
            `pane ${candidate.pane.paneId} disagrees with the controller agent roster`,
          );
        }
      }
      existing = discovered.sort((left, right) => left.slot - right.slot);
    }
    for (const [index, candidate] of existing.entries()) {
      if (candidate.slot !== index) {
        throw new HerdrAgentPaneAllocatorError(
          "existing agent grid slots are not contiguous",
        );
      }
      if (
        existing.some(
          (other) =>
            other !== candidate &&
            other.assignment.agentId === candidate.assignment.agentId,
        )
      ) {
        throw new HerdrAgentPaneAllocatorError(
          `agent ${candidate.assignment.agentId} owns multiple panes`,
        );
      }
    }
    const tabIds = new Set(existing.map((candidate) => candidate.pane.tabId));
    if (tabIds.size > 1) {
      throw new HerdrAgentPaneAllocatorError(
        "existing agent grid is split across multiple tabs",
      );
    }
    const existingIndex = existing.findIndex(
      (candidate) => candidate.assignment.agentId === request.agentId,
    );
    const requestedAssignment = Object.freeze({
      agentId: request.agentId,
      label: request.label,
      cwd: request.cwd,
    });
    const expectedByAgentId = new Map(
      request.expectedAgents?.map((expected) => [expected.agentId, expected]),
    );
    const assignments = existing.map((candidate) => {
      const expected = expectedByAgentId.get(candidate.assignment.agentId);
      return expected === undefined
        ? candidate.assignment
        : Object.freeze({
            agentId: expected.agentId,
            label: expected.label,
            cwd: expected.cwd,
          });
    });
    const expectedPaneIds: (string | null)[] = existing.map(
      (candidate) => candidate.pane.paneId,
    );
    const requestedSlot =
      existingIndex >= 0 ? existingIndex : assignments.length;
    if (existingIndex >= 0) {
      assignments[existingIndex] = requestedAssignment;
      if (
        request.expectedPaneId !== null &&
        expectedPaneIds[existingIndex] !== request.expectedPaneId
      ) {
        throw new HerdrAgentPaneAllocatorError(
          "controller pane identity disagrees with the live agent grid",
        );
      }
    } else {
      assignments.push(requestedAssignment);
      expectedPaneIds.push(request.expectedPaneId);
    }
    const liveTabId = existing[0]?.pane.tabId ?? null;
    if (
      request.expectedTabId !== null &&
      liveTabId !== null &&
      request.expectedTabId !== liveTabId
    ) {
      throw new HerdrAgentPaneAllocatorError(
        "controller tab identity disagrees with the live agent grid",
      );
    }

    const evidence: AgentsTabEvidence = await this.#lifecycle.ensure({
      runId: request.runId,
      // Grid ownership must remain stable while per-agent launch operations
      // and controller revisions change.
      operationId: request.runId,
      workspaceId: request.workspaceId,
      expectedTabId: request.expectedTabId ?? liveTabId,
      expectedPaneIds,
      assignments,
      metadataSequence: request.metadataSequence,
    });
    const paneId = evidence.paneIds[requestedSlot];
    if (
      paneId === undefined ||
      (paneId !== request.expectedPaneId && request.expectedPaneId !== null)
    ) {
      throw new HerdrAgentPaneAllocatorError(
        "lifecycle returned an unexpected pane identity",
      );
    }
    const pane = await this.#herdr.getPane(paneId);
    if (
      pane.paneId !== paneId ||
      pane.cwd !== request.cwd ||
      pane.tokens.aw_kind !== "agent" ||
      pane.tokens.aw_run !== request.runId ||
      pane.tokens.aw_operation !== request.runId ||
      pane.tokens.aw_slot !== String(requestedSlot) ||
      pane.tokens.aw_agent !== request.agentId
    ) {
      throw new HerdrAgentPaneAllocatorError(
        "allocated pane failed final ownership verification",
      );
    }
    return pane;
  }

  async release(paneId: string): Promise<void> {
    await this.#herdr.closePane(paneId);
  }
}
