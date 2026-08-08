import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AgentMessage } from "../../domain/agent-communication.ts";
import type { ControllerAction } from "../../domain/role-pack.ts";
import {
  transitionAgent,
  transitionStory,
  type AgentState,
  type StoryState,
} from "../../domain/controller-state.ts";
import type {
  ControllerEventInput,
  ControllerRepository,
  ControllerSnapshot,
  FencedWrite,
  JsonValue,
} from "../ports/controller-repository.ts";
import type {
  GitWorkspaceGateway,
  GitWorktreeRecord,
} from "../ports/git-workspace-gateway.ts";
import type { RoleCatalog } from "../launch/role-resource-resolver.ts";

export class ControllerAgentLifecycleError extends Error {
  constructor(message: string) {
    super(`Controller agent lifecycle failed: ${message}`);
    this.name = "ControllerAgentLifecycleError";
  }
}

export interface ControllerAgentLifecycleDependencies {
  readonly repository: ControllerRepository;
  readonly git: GitWorkspaceGateway;
  readonly roleCatalog: RoleCatalog;
  readonly clock: () => number;
  readonly writerLeaseTtlMs: number;
}

export interface ControllerAgentLifecycleResult {
  readonly accepted: boolean;
  readonly action:
    | "none"
    | "writer-lease-renewed"
    | "candidate-created"
    | "review-approved"
    | "review-changes-requested"
    | "agent-closed";
  readonly revision: number;
}

function staleRevision(error: unknown): boolean {
  return error instanceof Error && error.name === "StaleRunRevisionError";
}

/**
 * Converts identity-bound child control signals into controller-owned Git,
 * lease, story, and terminal-agent transitions.
 *
 * Child messages never supply candidate commits or authoritative Git state.
 * Candidate heads come only from the registered worktrees and the controller's
 * Git gateway. Review messages repeat the exact heads the controller placed in
 * the assignment, and those claims are checked against both durable and live
 * controller evidence before a decision is accepted.
 */
export class ControllerAgentLifecycle {
  readonly #repository: ControllerRepository;
  readonly #git: GitWorkspaceGateway;
  readonly #roleCatalog: RoleCatalog;
  readonly #clock: () => number;
  readonly #writerLeaseTtlMs: number;

  constructor(dependencies: ControllerAgentLifecycleDependencies) {
    if (!Number.isSafeInteger(dependencies.writerLeaseTtlMs)) {
      throw new ControllerAgentLifecycleError(
        "writer lease ttl must be a safe integer",
      );
    }
    if (dependencies.writerLeaseTtlMs < 1) {
      throw new ControllerAgentLifecycleError(
        "writer lease ttl must be positive",
      );
    }
    this.#repository = dependencies.repository;
    this.#git = dependencies.git;
    this.#roleCatalog = dependencies.roleCatalog;
    this.#clock = dependencies.clock;
    this.#writerLeaseTtlMs = dependencies.writerLeaseTtlMs;
  }

  async handle(
    message: AgentMessage,
    write: FencedWrite,
    requestId: string,
  ): Promise<ControllerAgentLifecycleResult> {
    const snapshot = this.#snapshot(message.runId);
    const agent = this.#agent(snapshot, message.agentId);
    if (message.type === "candidate-ready") {
      await this.#requireLifecycleAuthority(
        agent,
        "submit-work",
        ["idle", "working"],
        "writer candidate",
      );
    } else if (message.type === "review-submitted") {
      // Child turns currently report the generic operation-started signal, so
      // an active reviewer is represented as working rather than reviewing.
      await this.#requireLifecycleAuthority(
        agent,
        "submit-review",
        ["idle", "working", "reviewing"],
        "review submission",
      );
    }
    switch (message.type) {
      case "operation-started":
      case "operation-progress":
      case "heartbeat":
        return this.#renewWriterLease(snapshot, agent, write);
      case "candidate-ready":
        return this.#createCandidate(snapshot, agent, write, requestId);
      case "review-submitted":
        return this.#recordReview(snapshot, agent, message, write, requestId);
      case "session-shutdown":
        return this.#closeSettledAgent(snapshot, agent, write, requestId);
      default:
        return Object.freeze({
          accepted: true,
          action: "none",
          revision: snapshot.revision,
        });
    }
  }

  async #requireLifecycleAuthority(
    agent: AgentState,
    requiredAction: ControllerAction,
    allowedStatuses: readonly AgentState["status"][],
    label: string,
  ): Promise<void> {
    const role = await this.#roleCatalog.find(agent.roleRuntimeId);
    if (role?.runtimeId !== agent.roleRuntimeId) {
      throw new ControllerAgentLifecycleError(
        `agent ${agent.id} has no exact controller role authority`,
      );
    }
    if (!role.controllerActions.includes(requiredAction)) {
      throw new ControllerAgentLifecycleError(
        `role ${role.runtimeId} lacks ${requiredAction} authority`,
      );
    }
    if (!allowedStatuses.includes(agent.status)) {
      throw new ControllerAgentLifecycleError(
        `agent ${agent.id} cannot perform ${label} from terminal or inactive status ${agent.status}`,
      );
    }
  }

  #snapshot(runId: string): ControllerSnapshot {
    const snapshot = this.#repository.loadSnapshot(runId);
    if (snapshot === null) {
      throw new ControllerAgentLifecycleError(`unknown run ${runId}`);
    }
    return snapshot;
  }

  #agent(snapshot: ControllerSnapshot, agentId: string): AgentState {
    const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) {
      throw new ControllerAgentLifecycleError(`unknown agent ${agentId}`);
    }
    return agent;
  }

  #storyForTask(
    snapshot: ControllerSnapshot,
    agent: AgentState,
  ): StoryState | null {
    if (agent.taskId === null) return null;
    return snapshot.stories.find((story) => story.id === agent.taskId) ?? null;
  }

  #requiredTaskStory(
    snapshot: ControllerSnapshot,
    agent: AgentState,
  ): StoryState {
    const story = this.#storyForTask(snapshot, agent);
    if (story === null) {
      throw new ControllerAgentLifecycleError(
        `agent ${agent.id} has no exact story assignment`,
      );
    }
    return story;
  }

  #registeredWorktree(
    snapshot: ControllerSnapshot,
    path: string,
    branch: string,
    label: string,
  ): GitWorktreeRecord & { readonly head: string } {
    const matches = this.#git
      .listWorktrees(snapshot.run.originalCheckout)
      .filter((worktree) => worktree.path === resolve(path));
    if (matches.length !== 1) {
      throw new ControllerAgentLifecycleError(
        `${label} worktree registration is missing or ambiguous`,
      );
    }
    const worktree = matches[0];
    if (
      worktree?.branch !== branch ||
      worktree.head === null ||
      worktree.bare ||
      worktree.detached ||
      worktree.prunable ||
      worktree.locked
    ) {
      throw new ControllerAgentLifecycleError(
        `${label} worktree evidence is incomplete or unsafe`,
      );
    }
    return worktree as GitWorktreeRecord & { readonly head: string };
  }

  #event(
    requestId: string,
    suffix: string,
    entityType: ControllerEventInput["entityType"],
    entityId: string,
    payload: JsonValue,
    occurredAt: number,
  ): ControllerEventInput {
    return Object.freeze({
      eventId: `${requestId}-${suffix}`,
      type: suffix,
      entityType,
      entityId,
      payload,
      occurredAt,
    });
  }

  #commit(
    snapshot: ControllerSnapshot,
    write: FencedWrite,
    requestId: string,
    command: string,
    stories: readonly StoryState[],
    agents: readonly AgentState[],
    events: readonly ControllerEventInput[],
  ): number {
    try {
      return this.#repository.commitSnapshot({
        write,
        runId: snapshot.run.id,
        expectedRevision: snapshot.revision,
        idempotencyKey: `agent-lifecycle-${requestId}`,
        request: Object.freeze({ command, requestId }),
        run: snapshot.run,
        stories,
        agents,
        events,
      }).revision;
    } catch (error) {
      if (staleRevision(error)) {
        throw new ControllerAgentLifecycleError(
          "snapshot changed during a privileged lifecycle effect; retry is required",
        );
      }
      throw error;
    }
  }

  #replaceStory(
    snapshot: ControllerSnapshot,
    story: StoryState,
  ): readonly StoryState[] {
    return snapshot.stories.map((candidate) =>
      candidate.id === story.id ? story : candidate,
    );
  }

  #replaceAgent(
    snapshot: ControllerSnapshot,
    agent: AgentState,
  ): readonly AgentState[] {
    return snapshot.agents.map((candidate) =>
      candidate.id === agent.id ? agent : candidate,
    );
  }

  #renewWriterLease(
    snapshot: ControllerSnapshot,
    agent: AgentState,
    write: FencedWrite,
  ): ControllerAgentLifecycleResult {
    const story = this.#storyForTask(snapshot, agent);
    if (
      story?.assignedAgentId !== agent.id ||
      !["assigned", "working"].includes(story.status)
    ) {
      return Object.freeze({
        accepted: true,
        action: "none",
        revision: snapshot.revision,
      });
    }
    const lease = this.#repository.readWriterLease(snapshot.run.id, story.id);
    if (lease?.ownerAgentId !== agent.id || lease.expiresAt === null) {
      throw new ControllerAgentLifecycleError(
        `writer ${agent.id} lacks its controller-owned lease`,
      );
    }
    this.#repository.renewWriterLease(
      {
        write,
        runId: snapshot.run.id,
        storyId: story.id,
        ownerAgentId: agent.id,
        leaseToken: lease.leaseToken,
      },
      this.#writerLeaseTtlMs,
    );
    return Object.freeze({
      accepted: true,
      action: "writer-lease-renewed",
      revision: snapshot.revision,
    });
  }

  #createCandidate(
    snapshot: ControllerSnapshot,
    agent: AgentState,
    write: FencedWrite,
    requestId: string,
  ): ControllerAgentLifecycleResult {
    const story = this.#requiredTaskStory(snapshot, agent);
    if (story.assignedAgentId !== agent.id) {
      throw new ControllerAgentLifecycleError(
        `agent ${agent.id} is not the assigned writer for ${story.id}`,
      );
    }
    if (
      story.status === "awaiting-review" &&
      story.candidateStoryHead !== null &&
      story.reviewedIntegrationHead !== null
    ) {
      return Object.freeze({
        accepted: true,
        action: "none",
        revision: snapshot.revision,
      });
    }
    let working = story;
    if (working.status === "assigned") {
      working = transitionStory(working, {
        type: "story-work-started",
        at: this.#clock(),
      });
    }
    if (working.status !== "working") {
      throw new ControllerAgentLifecycleError(
        `story ${story.id} is not accepting a writer candidate from ${story.status}`,
      );
    }

    const lease = this.#repository.readWriterLease(snapshot.run.id, story.id);
    if (lease?.ownerAgentId !== agent.id || lease.expiresAt === null) {
      throw new ControllerAgentLifecycleError(
        `writer ${agent.id} lacks its controller-owned lease`,
      );
    }
    const storyWorktree = this.#registeredWorktree(
      snapshot,
      story.worktreePath,
      story.branchName,
      "story",
    );
    const integrationWorktree = this.#registeredWorktree(
      snapshot,
      snapshot.run.integrationWorktree,
      snapshot.run.integrationBranch,
      "integration",
    );
    this.#repository.releaseWriterLease({
      write,
      runId: snapshot.run.id,
      storyId: story.id,
      ownerAgentId: agent.id,
      leaseToken: lease.leaseToken,
    });
    const awaitingCandidate = transitionStory(working, {
      type: "candidate-requested",
      at: this.#clock(),
      writerLeaseReleased: true,
    });
    const result = this.#git.createCandidateCommit({
      runId: snapshot.run.id,
      storyId: story.id,
      operationId: `candidate-${createHash("sha256")
        .update(
          `${snapshot.run.id}\0${story.id}\0${storyWorktree.head}\0${integrationWorktree.head}`,
        )
        .digest("hex")
        .slice(0, 40)}`,
      originalCheckout: snapshot.run.originalCheckout,
      integrationBranch: snapshot.run.integrationBranch,
      expectedIntegrationHead: integrationWorktree.head,
      storyBranch: story.branchName,
      expectedStoryHead: storyWorktree.head,
      worktreePath: story.worktreePath,
      subject: `Candidate ${story.title} (${story.id})`,
      writerLeaseReleased: true,
    });
    const candidate = transitionStory(awaitingCandidate, {
      type: "candidate-created",
      at: this.#clock(),
      storyHead: result.commit,
      integrationHead: result.integrationHead,
    });
    const revision = this.#commit(
      snapshot,
      write,
      requestId,
      "create-candidate",
      this.#replaceStory(snapshot, candidate),
      snapshot.agents,
      [
        this.#event(
          requestId,
          "candidate-created",
          "story",
          story.id,
          Object.freeze({
            candidateCommit: result.commit,
            integrationHead: result.integrationHead,
            changedPaths: result.changedPaths,
          }),
          candidate.updatedAt,
        ),
      ],
    );
    return Object.freeze({
      accepted: true,
      action: "candidate-created",
      revision,
    });
  }

  #recordReview(
    snapshot: ControllerSnapshot,
    agent: AgentState,
    message: Extract<AgentMessage, { readonly type: "review-submitted" }>,
    write: FencedWrite,
    requestId: string,
  ): ControllerAgentLifecycleResult {
    const story = this.#requiredTaskStory(snapshot, agent);
    if (story.assignedAgentId === agent.id) {
      throw new ControllerAgentLifecycleError(
        "a story writer cannot review its own candidate",
      );
    }
    if (story.reviewerAgentId !== agent.id) {
      throw new ControllerAgentLifecycleError(
        `agent ${agent.id} is not the assigned reviewer for ${story.id}`,
      );
    }
    const alreadyRecorded =
      (message.outcome === "approved" &&
        ["approved", "merging", "merged"].includes(story.status)) ||
      (message.outcome === "changes-requested" &&
        story.status === "changes-requested");
    if (alreadyRecorded) {
      if (
        message.candidateStoryHead !== story.candidateStoryHead ||
        message.integrationHead !== story.reviewedIntegrationHead
      ) {
        throw new ControllerAgentLifecycleError(
          "retried review evidence differs from the durable decision",
        );
      }
      return Object.freeze({
        accepted: true,
        action: "none",
        revision: snapshot.revision,
      });
    }
    if (
      story.status !== "awaiting-review" ||
      story.candidateStoryHead === null ||
      story.reviewedIntegrationHead === null
    ) {
      throw new ControllerAgentLifecycleError(
        `story ${story.id} is not awaiting exact review evidence`,
      );
    }
    if (
      message.candidateStoryHead !== story.candidateStoryHead ||
      message.integrationHead !== story.reviewedIntegrationHead
    ) {
      throw new ControllerAgentLifecycleError(
        "review evidence is stale and does not match the assigned heads",
      );
    }
    const storyWorktree = this.#registeredWorktree(
      snapshot,
      story.worktreePath,
      story.branchName,
      "review candidate",
    );
    const integrationWorktree = this.#registeredWorktree(
      snapshot,
      snapshot.run.integrationWorktree,
      snapshot.run.integrationBranch,
      "review integration",
    );
    if (
      storyWorktree.head !== story.candidateStoryHead ||
      integrationWorktree.head !== story.reviewedIntegrationHead
    ) {
      throw new ControllerAgentLifecycleError(
        "live Git heads changed after the review assignment",
      );
    }
    const reviewed =
      message.outcome === "approved"
        ? transitionStory(story, {
            type: "review-approved",
            at: this.#clock(),
            reviewerAgentId: agent.id,
            storyHead: storyWorktree.head,
            integrationHead: integrationWorktree.head,
            checksPassed: true,
          })
        : transitionStory(story, {
            type: "review-changes-requested",
            at: this.#clock(),
            reviewerAgentId: agent.id,
          });
    const eventType =
      message.outcome === "approved"
        ? "review-approved"
        : "review-changes-requested";
    const revision = this.#commit(
      snapshot,
      write,
      requestId,
      "record-review",
      this.#replaceStory(snapshot, reviewed),
      snapshot.agents,
      [
        this.#event(
          requestId,
          eventType,
          "story",
          story.id,
          Object.freeze({
            reviewerAgentId: agent.id,
            candidateStoryHead: storyWorktree.head,
            integrationHead: integrationWorktree.head,
          }),
          reviewed.updatedAt,
        ),
      ],
    );
    return Object.freeze({
      accepted: true,
      action:
        message.outcome === "approved"
          ? "review-approved"
          : "review-changes-requested",
      revision,
    });
  }

  #closeSettledAgent(
    snapshot: ControllerSnapshot,
    agent: AgentState,
    write: FencedWrite,
    requestId: string,
  ): ControllerAgentLifecycleResult {
    if (agent.status === "closed") {
      return Object.freeze({
        accepted: true,
        action: "none",
        revision: snapshot.revision,
      });
    }
    const story = this.#storyForTask(snapshot, agent);
    if (story === null) {
      return Object.freeze({
        accepted: true,
        action: "none",
        revision: snapshot.revision,
      });
    }
    const isSettledWriter =
      story.assignedAgentId === agent.id &&
      ["awaiting-review", "approved", "merging", "merged"].includes(
        story.status,
      ) &&
      (this.#repository.readWriterLease(snapshot.run.id, story.id)
        ?.ownerAgentId ?? null) === null;
    const isSettledReviewer =
      story.reviewerAgentId === agent.id &&
      ["changes-requested", "approved", "merging", "merged"].includes(
        story.status,
      );
    if (!isSettledWriter && !isSettledReviewer) {
      return Object.freeze({
        accepted: true,
        action: "none",
        revision: snapshot.revision,
      });
    }

    let terminal = agent;
    if (["idle", "working", "reviewing"].includes(terminal.status)) {
      terminal = transitionAgent(terminal, {
        type: "agent-completed",
        at: this.#clock(),
      });
    }
    if (!["completed", "failed", "disconnected"].includes(terminal.status)) {
      throw new ControllerAgentLifecycleError(
        `agent ${agent.id} cannot close safely from ${terminal.status}`,
      );
    }
    terminal = transitionAgent(terminal, {
      type: "agent-closed",
      at: this.#clock(),
      writerLeaseReleased: true,
    });
    const revision = this.#commit(
      snapshot,
      write,
      requestId,
      "close-settled-agent",
      snapshot.stories,
      this.#replaceAgent(snapshot, terminal),
      [
        this.#event(
          requestId,
          "agent-closed",
          "agent",
          agent.id,
          Object.freeze({ storyId: story.id, writerLeaseReleased: true }),
          terminal.updatedAt,
        ),
      ],
    );
    return Object.freeze({
      accepted: true,
      action: "agent-closed",
      revision,
    });
  }
}
