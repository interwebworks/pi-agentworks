import {
  transitionRun,
  transitionStory,
  type AgentState,
  type StoryState,
} from "../../domain/controller-state.ts";
import type { OrchestrationAction } from "../../domain/orchestration.ts";
import type {
  ControllerEventInput,
  ControllerSnapshot,
} from "../ports/controller-repository.ts";
import type { GitWorkspaceGateway } from "../ports/git-workspace-gateway.ts";
import type { OrchestrationContext } from "../ports/orchestration-context.ts";
import type {
  OrchestrationEffectResult,
  OrchestrationEffects,
} from "../ports/orchestration-effects.ts";
import type { StoryAgentLauncher } from "../ports/story-agent-launcher.ts";

export class ControllerOrchestrationEffectsError extends Error {
  constructor(message: string) {
    super(`Agentworks orchestration effect failed: ${message}`);
    this.name = "ControllerOrchestrationEffectsError";
  }
}

export interface ControllerOrchestrationEffectsDependencies {
  readonly git: GitWorkspaceGateway;
  readonly launcher: StoryAgentLauncher;
  readonly context: OrchestrationContext;
  readonly clock: () => number;
}

/**
 * The real work behind each orchestration action: launching writer/reviewer
 * agents, merging reviewed candidates, and tearing down merged story
 * worktrees. Git request assembly and state transitions live here and are
 * fully unit-testable; the live Pi launch and the runtime lease/fence/candidate
 * facts are injected through the launcher and context ports.
 */
export class ControllerOrchestrationEffects implements OrchestrationEffects {
  readonly #git: GitWorkspaceGateway;
  readonly #launcher: StoryAgentLauncher;
  readonly #context: OrchestrationContext;
  readonly #clock: () => number;

  constructor(dependencies: ControllerOrchestrationEffectsDependencies) {
    this.#git = dependencies.git;
    this.#launcher = dependencies.launcher;
    this.#context = dependencies.context;
    this.#clock = dependencies.clock;
  }

  async execute(
    action: OrchestrationAction,
    snapshot: ControllerSnapshot,
  ): Promise<OrchestrationEffectResult> {
    switch (action.type) {
      case "assign-project-manager":
        return this.#assignTeamMember(
          "project-manager",
          action.storyId,
          snapshot,
        );
      case "assign-advisor":
        return this.#assignTeamMember("advisor", action.storyId, snapshot);
      case "assign-story":
        return this.#assignStory(action.storyId, snapshot);
      case "assign-reviewer":
        return this.#assignReviewer(action.storyId, snapshot);
      case "request-merge":
        return Promise.resolve(this.#requestMerge(action.storyId, snapshot));
      case "request-cleanup":
        return Promise.resolve(this.#requestCleanup(action.storyId, snapshot));
      case "complete-run":
        return Promise.resolve(this.#completeRun(snapshot));
    }
  }

  #story(storyId: string, snapshot: ControllerSnapshot): StoryState {
    const story = snapshot.stories.find((entry) => entry.id === storyId);
    if (story === undefined) {
      throw new ControllerOrchestrationEffectsError(`unknown story ${storyId}`);
    }
    return story;
  }

  #replaceStory(
    snapshot: ControllerSnapshot,
    updated: StoryState,
  ): readonly StoryState[] {
    return snapshot.stories.map((entry) =>
      entry.id === updated.id ? updated : entry,
    );
  }

  #upsertAgent(
    snapshot: ControllerSnapshot,
    agent: AgentState,
  ): readonly AgentState[] {
    const exists = snapshot.agents.some((entry) => entry.id === agent.id);
    return exists
      ? snapshot.agents.map((entry) => (entry.id === agent.id ? agent : entry))
      : [...snapshot.agents, agent];
  }

  #event(
    type: string,
    entityType: ControllerEventInput["entityType"],
    entityId: string,
    payload: ControllerEventInput["payload"],
    occurredAt: number,
  ): ControllerEventInput {
    return {
      eventId: `${type}-${entityId}-${String(occurredAt)}`,
      type,
      entityType,
      entityId,
      payload,
      occurredAt,
    };
  }

  async #assignTeamMember(
    kind: "project-manager" | "advisor",
    storyId: string,
    snapshot: ControllerSnapshot,
  ): Promise<OrchestrationEffectResult> {
    const story = this.#story(storyId, snapshot);
    const launch =
      kind === "project-manager"
        ? await this.#launcher.launchProjectManager(
            story,
            snapshot.run,
            snapshot,
          )
        : await this.#launcher.launchAdvisor(story, snapshot.run, snapshot);
    return Object.freeze({
      run: snapshot.run,
      stories: snapshot.stories,
      agents: this.#upsertAgent(snapshot, launch.agent),
      events: launch.events,
    });
  }

  async #assignStory(
    storyId: string,
    snapshot: ControllerSnapshot,
  ): Promise<OrchestrationEffectResult> {
    const story = this.#story(storyId, snapshot);
    const launch = await this.#launcher.launchWriter(
      story,
      snapshot.run,
      snapshot,
    );
    const ready =
      story.status === "changes-requested"
        ? transitionStory(story, {
            type: "story-reassignment-requested",
            at: this.#clock(),
            reason:
              "review requested changes; launching a fresh writer attempt",
            writerLeaseReleased: true,
          })
        : story;
    const assigned = transitionStory(ready, {
      type: "story-assigned",
      at: this.#clock(),
      agentId: launch.agent.id,
    });
    return Object.freeze({
      run: snapshot.run,
      stories: this.#replaceStory(snapshot, assigned),
      agents: this.#upsertAgent(snapshot, launch.agent),
      events: launch.events,
    });
  }

  async #assignReviewer(
    storyId: string,
    snapshot: ControllerSnapshot,
  ): Promise<OrchestrationEffectResult> {
    const story = this.#story(storyId, snapshot);
    const launch = await this.#launcher.launchReviewer(
      story,
      snapshot.run,
      snapshot,
    );
    // Persist the reviewer assignment immediately so the next orchestration
    // tick cannot launch a duplicate reviewer while the review is in flight.
    // The review transition still records the same identity and validates the
    // exact candidate/base heads before approval.
    const assigned = Object.freeze({
      ...story,
      reviewerAgentId: launch.agent.id,
      updatedAt: this.#clock(),
    });
    return Object.freeze({
      run: snapshot.run,
      stories: this.#replaceStory(snapshot, assigned),
      agents: this.#upsertAgent(snapshot, launch.agent),
      events: [
        ...launch.events,
        this.#event(
          "reviewer-assigned",
          "story",
          story.id,
          { reviewerAgentId: launch.agent.id },
          assigned.updatedAt,
        ),
      ],
    });
  }

  #requestMerge(
    storyId: string,
    snapshot: ControllerSnapshot,
  ): OrchestrationEffectResult {
    const story = this.#story(storyId, snapshot);
    const run = snapshot.run;
    if (
      story.reviewedIntegrationHead === null ||
      story.reviewerAgentId === null ||
      story.assignedAgentId === null ||
      story.candidateStoryHead === null
    ) {
      throw new ControllerOrchestrationEffectsError(
        `story ${storyId} is not ready to merge (missing review or writer evidence)`,
      );
    }
    const facts = this.#context.mergeFacts(story, snapshot);
    const result = this.#git.mergeCandidate({
      runId: run.id,
      storyId: story.id,
      operationId: facts.operationId,
      originalCheckout: run.originalCheckout,
      integrationBranch: run.integrationBranch,
      integrationWorktreePath: run.integrationWorktree,
      reviewedIntegrationHead: story.reviewedIntegrationHead,
      storyBranch: story.branchName,
      storyWorktreePath: story.worktreePath,
      candidateCommit: story.candidateStoryHead,
      writerAgentId: story.assignedAgentId,
      reviewerAgentId: story.reviewerAgentId,
      requesterRole: facts.requesterRole,
      requiredChecksPassed: facts.requiredChecksPassed,
      writerLeaseReleased: facts.writerLeaseReleased,
      controllerLeaseCurrent: facts.controllerLeaseCurrent,
      expectedRevisionMatches: facts.expectedRevisionMatches,
      targetIsDefaultOrProtected: facts.targetIsDefaultOrProtected,
      protectedTargetUserApproval: facts.protectedTargetUserApproval,
      subject: facts.subject,
    });
    const started = transitionStory(story, {
      type: "merge-started",
      at: this.#clock(),
    });
    const merged = transitionStory(started, {
      type: "story-merged",
      at: this.#clock(),
      mergeHead: result.mergeCommit,
    });
    return Object.freeze({
      run,
      stories: this.#replaceStory(snapshot, merged),
      agents: snapshot.agents,
      events: [
        this.#event(
          "story-merged",
          "story",
          story.id,
          { mergeCommit: result.mergeCommit },
          merged.updatedAt,
        ),
      ],
    });
  }

  #requestCleanup(
    storyId: string,
    snapshot: ControllerSnapshot,
  ): OrchestrationEffectResult {
    const story = this.#story(storyId, snapshot);
    const run = snapshot.run;
    if (
      story.mergeHead === null ||
      story.reviewedIntegrationHead === null ||
      story.candidateStoryHead === null
    ) {
      throw new ControllerOrchestrationEffectsError(
        `story ${storyId} cannot be cleaned up before it is merged`,
      );
    }
    const facts = this.#context.cleanupFacts(story, snapshot);
    this.#git.cleanupStoryWorkspace({
      runId: run.id,
      storyId: story.id,
      operationId: facts.operationId,
      originalCheckout: run.originalCheckout,
      integrationBranch: run.integrationBranch,
      integrationWorktreePath: run.integrationWorktree,
      storyBranch: story.branchName,
      storyWorktreePath: story.worktreePath,
      candidateCommit: story.candidateStoryHead,
      reviewedIntegrationHead: story.reviewedIntegrationHead,
      mergeCommit: story.mergeHead,
      mergeOperationId: facts.mergeOperationId,
      mergeSubject: facts.mergeSubject,
      reviewerAgentId: story.reviewerAgentId ?? "",
      writerLeaseReleased: facts.writerLeaseReleased,
      agentClosed: facts.agentClosed,
      controllerLeaseCurrent: facts.controllerLeaseCurrent,
      expectedRevisionMatches: facts.expectedRevisionMatches,
    });
    // Cleanup is worktree teardown; the story remains merged and records the
    // one durable bit that prevents repeated cleanup effects on later ticks.
    const cleaned = Object.freeze({
      ...story,
      workspaceCleaned: true as const,
      updatedAt: this.#clock(),
    });
    return Object.freeze({
      run,
      stories: this.#replaceStory(snapshot, cleaned),
      agents: snapshot.agents,
      events: [
        this.#event(
          "story-workspace-cleaned",
          "story",
          story.id,
          { mergeCommit: story.mergeHead },
          cleaned.updatedAt,
        ),
      ],
    });
  }

  #completeRun(snapshot: ControllerSnapshot): OrchestrationEffectResult {
    const unfinishedStoryIds = snapshot.stories
      .filter((story) => story.status !== "merged")
      .map((story) => story.id);
    const completed = transitionRun(snapshot.run, {
      type: "run-completed",
      at: this.#clock(),
      unfinishedStoryIds,
    });
    return Object.freeze({
      run: completed,
      stories: snapshot.stories,
      agents: snapshot.agents,
      events: [
        this.#event(
          "run-completed",
          "run",
          snapshot.run.id,
          { unfinishedStoryIds },
          completed.updatedAt,
        ),
      ],
    });
  }
}
