import type { HerdrGateway, HerdrPane } from "../ports/herdr-gateway.ts";
import type {
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
}

export class HerdrAgentPaneAllocatorError extends Error {
  constructor(message: string) {
    super(`Herdr agent pane allocation failed: ${message}`);
    this.name = "HerdrAgentPaneAllocatorError";
  }
}

type PaneReader = Pick<HerdrGateway, "getPane" | "closePane">;

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
    const evidence: AgentsTabEvidence = await this.#lifecycle.ensure({
      runId: request.runId,
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      expectedTabId: request.expectedTabId,
      expectedPaneIds: [request.expectedPaneId],
      assignments: [
        {
          agentId: request.agentId,
          label: request.label,
          cwd: request.cwd,
        },
      ],
      metadataSequence: request.metadataSequence,
    });
    const paneId = evidence.paneIds[0];
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
