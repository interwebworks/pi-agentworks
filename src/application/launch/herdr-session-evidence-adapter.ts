import type { RunState, StoryState } from "../../domain/controller-state.ts";
import type { HerdrPane } from "../ports/herdr-gateway.ts";
import type {
  AssignmentInfrastructureEvidence,
  GitAssignmentEvidence,
  PrivateSessionEvidence,
} from "./assignment-resource-evidence.ts";
import { assertAssignmentInfrastructureEvidence } from "./assignment-resource-evidence.ts";

export interface HerdrPaneProvider {
  getPane(paneId: string): Promise<HerdrPane>;
}

export interface PrivateSessionProvider {
  create(
    run: RunState,
    story: StoryState,
    agentId: string,
  ): Promise<PrivateSessionEvidence>;
  cleanup(session: PrivateSessionEvidence, reason: string): Promise<void>;
}

export interface ControllerEndpointEvidence {
  readonly controllerSocketPath: string;
  readonly runtimePath: string;
  readonly controllerFenceCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
}

export class HerdrSessionEvidenceAdapterError extends Error {
  constructor(message: string) {
    super(`Herdr/session evidence adapter failed: ${message}`);
    this.name = "HerdrSessionEvidenceAdapterError";
  }
}

/**
 * Verifies a controller-owned Herdr pane, then creates private session
 * evidence. Any failure after session creation invokes cleanup before the
 * error escapes, preventing orphaned launch capabilities.
 */
export class HerdrSessionEvidenceAdapter {
  readonly #panes: HerdrPaneProvider;
  readonly #sessions: PrivateSessionProvider;

  constructor(
    dependencies: {
      readonly panes: HerdrPaneProvider;
      readonly sessions: PrivateSessionProvider;
    } | null,
  ) {
    if (dependencies === null) {
      throw new HerdrSessionEvidenceAdapterError(
        "pane and session providers are required",
      );
    }
    this.#panes = dependencies.panes;
    this.#sessions = dependencies.sessions;
  }

  async provision(
    run: RunState,
    story: StoryState,
    agentId: string,
    paneId: string,
    git: GitAssignmentEvidence,
    endpoint: ControllerEndpointEvidence,
  ): Promise<AssignmentInfrastructureEvidence> {
    const pane = await this.#panes.getPane(paneId);
    if (
      pane.paneId !== paneId ||
      pane.cwd !== story.worktreePath ||
      pane.tokens.aw_kind !== "agent" ||
      pane.tokens.aw_run !== run.id ||
      pane.tokens.aw_agent !== agentId
    ) {
      throw new HerdrSessionEvidenceAdapterError(
        "Herdr pane identity, cwd, or ownership tokens do not match",
      );
    }
    let session: PrivateSessionEvidence | null = null;
    try {
      session = await this.#sessions.create(run, story, agentId);
      const evidence: AssignmentInfrastructureEvidence = {
        git,
        herdr: {
          paneId: pane.paneId,
          cwd: pane.cwd,
          tokens: pane.tokens,
        },
        session,
        ...endpoint,
      };
      assertAssignmentInfrastructureEvidence(evidence, run, story, agentId);
      return Object.freeze(evidence);
    } catch (error) {
      if (session !== null) {
        await this.#sessions.cleanup(
          session,
          error instanceof Error ? error.message : "session evidence failed",
        );
      }
      throw error;
    }
  }
}
