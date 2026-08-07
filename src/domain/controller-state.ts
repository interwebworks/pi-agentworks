import { Type } from "typebox";
import { Check } from "typebox/value";
import { getComplexityPolicy, type ComplexityMode } from "./complexity.ts";

export const CONTROLLER_STATE_SCHEMA_VERSION = 2 as const;

export type RunStatus =
  | "planning"
  | "awaiting-approval"
  | "ready"
  | "active"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type StoryStatus =
  | "planned"
  | "awaiting-approval"
  | "ready"
  | "assigned"
  | "working"
  | "awaiting-candidate"
  | "awaiting-review"
  | "changes-requested"
  | "approved"
  | "merging"
  | "merged"
  | "blocked"
  | "failed";

export type AgentStatus =
  | "planned"
  | "launching"
  | "idle"
  | "working"
  | "waiting"
  | "blocked"
  | "reviewing"
  | "completed"
  | "failed"
  | "disconnected"
  | "closed";

export interface ManagementPaneOrigin {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

export interface RunState {
  readonly schemaVersion: typeof CONTROLLER_STATE_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly complexity: ComplexityMode;
  readonly status: RunStatus;
  readonly repositoryRoot: string;
  readonly originalCheckout: string;
  readonly baseBranch: string;
  readonly integrationBranch: string;
  readonly integrationWorktree: string;
  /** Immutable launch ownership used for fail-closed management recovery. */
  readonly managementPaneOrigin?: ManagementPaneOrigin;
  readonly blockedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoryPlanningMetadata {
  readonly narrative: string;
  readonly objective: string;
  readonly taskKinds: readonly string[];
  readonly writable: boolean;
  readonly scope: {
    readonly included: readonly string[];
    readonly excluded: readonly string[];
  };
  readonly technologyChoices: readonly string[];
  readonly constraints: readonly string[];
  readonly dependencies: readonly string[];
  readonly deliverables: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly validation: readonly {
    readonly command: string;
    readonly expected: string;
  }[];
  readonly escalationConditions: readonly string[];
}

export interface StoryState {
  readonly schemaVersion: typeof CONTROLLER_STATE_SCHEMA_VERSION;
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly status: StoryStatus;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly planning?: StoryPlanningMetadata;
  readonly assignedAgentId: string | null;
  readonly candidateStoryHead: string | null;
  readonly reviewedIntegrationHead: string | null;
  readonly reviewerAgentId: string | null;
  readonly mergeHead: string | null;
  readonly blockedReason: string | null;
  readonly blockedFrom: Exclude<
    StoryStatus,
    "blocked" | "merged" | "failed"
  > | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentState {
  readonly schemaVersion: typeof CONTROLLER_STATE_SCHEMA_VERSION;
  readonly id: string;
  readonly runId: string;
  readonly roleRuntimeId: string;
  readonly status: AgentStatus;
  readonly taskId: string | null;
  readonly worktreePath: string;
  readonly paneId: string | null;
  readonly piSessionPath: string | null;
  readonly currentOperation: string | null;
  readonly waitingReason: string | null;
  readonly blockedReason: string | null;
  readonly nudgeCount: number;
  readonly lastNudgeAt: number | null;
  readonly lastHeartbeatAt: number;
  readonly lastMeaningfulActivityAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const NonEmptyStateString = Type.String({ minLength: 1 });
const NullableStateString = Type.Union([Type.Null(), NonEmptyStateString]);
const NonEmptyStateStringArray = Type.Array(NonEmptyStateString, {
  minItems: 1,
});
const StoryPlanningMetadataSchema = Type.Object(
  {
    narrative: NonEmptyStateString,
    objective: NonEmptyStateString,
    taskKinds: NonEmptyStateStringArray,
    writable: Type.Boolean(),
    scope: Type.Object(
      {
        included: NonEmptyStateStringArray,
        excluded: NonEmptyStateStringArray,
      },
      { additionalProperties: false },
    ),
    technologyChoices: NonEmptyStateStringArray,
    constraints: NonEmptyStateStringArray,
    dependencies: Type.Array(NonEmptyStateString),
    deliverables: NonEmptyStateStringArray,
    acceptanceCriteria: NonEmptyStateStringArray,
    validation: Type.Array(
      Type.Object(
        {
          command: NonEmptyStateString,
          expected: NonEmptyStateString,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    escalationConditions: NonEmptyStateStringArray,
  },
  { additionalProperties: false },
);
const StateTimestamp = Type.Integer({ minimum: 0 });
const RunStatusSchema = Type.Union([
  Type.Literal("planning"),
  Type.Literal("awaiting-approval"),
  Type.Literal("ready"),
  Type.Literal("active"),
  Type.Literal("blocked"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
const StoryStatusSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("awaiting-approval"),
  Type.Literal("ready"),
  Type.Literal("assigned"),
  Type.Literal("working"),
  Type.Literal("awaiting-candidate"),
  Type.Literal("awaiting-review"),
  Type.Literal("changes-requested"),
  Type.Literal("approved"),
  Type.Literal("merging"),
  Type.Literal("merged"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
]);
const ResumableStoryStatusSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("awaiting-approval"),
  Type.Literal("ready"),
  Type.Literal("assigned"),
  Type.Literal("working"),
  Type.Literal("awaiting-candidate"),
  Type.Literal("awaiting-review"),
  Type.Literal("changes-requested"),
  Type.Literal("approved"),
  Type.Literal("merging"),
]);
const AgentStatusSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("launching"),
  Type.Literal("idle"),
  Type.Literal("working"),
  Type.Literal("waiting"),
  Type.Literal("blocked"),
  Type.Literal("reviewing"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("disconnected"),
  Type.Literal("closed"),
]);

export const RunStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CONTROLLER_STATE_SCHEMA_VERSION),
    id: NonEmptyStateString,
    title: NonEmptyStateString,
    complexity: Type.Union([
      Type.Literal("LOW"),
      Type.Literal("NORMAL"),
      Type.Literal("HIGH"),
    ]),
    status: RunStatusSchema,
    repositoryRoot: NonEmptyStateString,
    originalCheckout: NonEmptyStateString,
    baseBranch: NonEmptyStateString,
    integrationBranch: NonEmptyStateString,
    integrationWorktree: NonEmptyStateString,
    managementPaneOrigin: Type.Optional(
      Type.Object(
        {
          workspaceId: NonEmptyStateString,
          tabId: NonEmptyStateString,
          paneId: NonEmptyStateString,
        },
        { additionalProperties: false },
      ),
    ),
    blockedReason: NullableStateString,
    createdAt: StateTimestamp,
    updatedAt: StateTimestamp,
  },
  { additionalProperties: false },
);

export const StoryStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CONTROLLER_STATE_SCHEMA_VERSION),
    id: NonEmptyStateString,
    runId: NonEmptyStateString,
    title: NonEmptyStateString,
    status: StoryStatusSchema,
    branchName: NonEmptyStateString,
    worktreePath: NonEmptyStateString,
    planning: Type.Optional(StoryPlanningMetadataSchema),
    assignedAgentId: NullableStateString,
    candidateStoryHead: NullableStateString,
    reviewedIntegrationHead: NullableStateString,
    reviewerAgentId: NullableStateString,
    mergeHead: NullableStateString,
    blockedReason: NullableStateString,
    blockedFrom: Type.Union([Type.Null(), ResumableStoryStatusSchema]),
    createdAt: StateTimestamp,
    updatedAt: StateTimestamp,
  },
  { additionalProperties: false },
);

export const AgentStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CONTROLLER_STATE_SCHEMA_VERSION),
    id: NonEmptyStateString,
    runId: NonEmptyStateString,
    roleRuntimeId: NonEmptyStateString,
    status: AgentStatusSchema,
    taskId: NullableStateString,
    worktreePath: NonEmptyStateString,
    paneId: NullableStateString,
    piSessionPath: NullableStateString,
    currentOperation: NullableStateString,
    waitingReason: NullableStateString,
    blockedReason: NullableStateString,
    nudgeCount: Type.Integer({ minimum: 0 }),
    lastNudgeAt: Type.Union([Type.Null(), StateTimestamp]),
    lastHeartbeatAt: StateTimestamp,
    lastMeaningfulActivityAt: StateTimestamp,
    createdAt: StateTimestamp,
    updatedAt: StateTimestamp,
  },
  { additionalProperties: false },
);

export function isRunState(value: unknown): value is RunState {
  return Check(RunStateSchema, value);
}

export function isStoryState(value: unknown): value is StoryState {
  return Check(StoryStateSchema, value);
}

export function isAgentState(value: unknown): value is AgentState {
  return Check(AgentStateSchema, value);
}

export type RunTransition =
  | { readonly type: "plan-prepared"; readonly at: number }
  | { readonly type: "plan-approved"; readonly at: number }
  | { readonly type: "plan-revision-requested"; readonly at: number }
  | {
      readonly type: "run-started";
      readonly at: number;
      readonly integrationWorktreeReady: boolean;
    }
  | {
      readonly type: "run-blocked";
      readonly at: number;
      readonly reason: string;
    }
  | { readonly type: "run-resumed"; readonly at: number }
  | {
      readonly type: "run-completed";
      readonly at: number;
      readonly unfinishedStoryIds: readonly string[];
    }
  | {
      readonly type: "run-failed";
      readonly at: number;
      readonly reason: string;
    }
  | {
      readonly type: "run-cancelled";
      readonly at: number;
      readonly reason: string;
    };

export type StoryTransition =
  | {
      readonly type: "story-prepared";
      readonly at: number;
      readonly complexity: ComplexityMode;
    }
  | { readonly type: "story-plan-approved"; readonly at: number }
  | {
      readonly type: "story-assigned";
      readonly at: number;
      readonly agentId: string;
    }
  | { readonly type: "story-work-started"; readonly at: number }
  | {
      readonly type: "story-reassignment-requested";
      readonly at: number;
      readonly reason: string;
      readonly writerLeaseReleased: boolean;
    }
  | {
      readonly type: "candidate-requested";
      readonly at: number;
      readonly writerLeaseReleased: boolean;
    }
  | {
      readonly type: "candidate-created";
      readonly at: number;
      readonly storyHead: string;
      readonly integrationHead: string;
    }
  | {
      readonly type: "review-approved";
      readonly at: number;
      readonly reviewerAgentId: string;
      readonly storyHead: string;
      readonly integrationHead: string;
      readonly checksPassed: boolean;
    }
  | {
      readonly type: "review-changes-requested";
      readonly at: number;
      readonly reviewerAgentId: string;
    }
  | {
      readonly type: "review-invalidated";
      readonly at: number;
      readonly integrationHead: string;
    }
  | { readonly type: "merge-started"; readonly at: number }
  | {
      readonly type: "story-merged";
      readonly at: number;
      readonly mergeHead: string;
    }
  | {
      readonly type: "story-blocked";
      readonly at: number;
      readonly reason: string;
    }
  | { readonly type: "story-resumed"; readonly at: number }
  | {
      readonly type: "story-failed";
      readonly at: number;
      readonly reason: string;
    };

export type AgentTransition =
  | {
      readonly type: "launch-requested";
      readonly at: number;
      readonly paneId: string;
    }
  | {
      readonly type: "session-ready";
      readonly at: number;
      readonly piSessionPath: string;
    }
  | {
      readonly type: "operation-started";
      readonly at: number;
      readonly operation: string;
    }
  | { readonly type: "operation-finished"; readonly at: number }
  | {
      readonly type: "waiting-for-input";
      readonly at: number;
      readonly reason: string;
    }
  | { readonly type: "input-received"; readonly at: number }
  | {
      readonly type: "agent-blocked";
      readonly at: number;
      readonly reason: string;
    }
  | { readonly type: "agent-unblocked"; readonly at: number }
  | {
      readonly type: "review-started";
      readonly at: number;
      readonly operation: string;
    }
  | { readonly type: "heartbeat"; readonly at: number }
  | { readonly type: "nudge-sent"; readonly at: number }
  | { readonly type: "agent-completed"; readonly at: number }
  | {
      readonly type: "agent-failed";
      readonly at: number;
      readonly reason: string;
    }
  | { readonly type: "pane-lost"; readonly at: number }
  | {
      readonly type: "recovery-requested";
      readonly at: number;
      readonly paneId: string;
    }
  | {
      readonly type: "agent-closed";
      readonly at: number;
      readonly writerLeaseReleased: boolean;
    };

export class InvalidStateTransitionError extends Error {
  readonly entity: "run" | "story" | "agent";
  readonly currentStatus: string;
  readonly transitionType: string;

  constructor(
    entity: "run" | "story" | "agent",
    currentStatus: string,
    transitionType: string,
    reason?: string,
  ) {
    super(
      `Invalid ${entity} transition ${currentStatus} -> ${transitionType}${reason === undefined ? "" : `: ${reason}`}`,
    );
    this.name = "InvalidStateTransitionError";
    this.entity = entity;
    this.currentStatus = currentStatus;
    this.transitionType = transitionType;
  }
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
  return normalized;
}

function assertForwardTime(
  current: { readonly updatedAt: number },
  at: number,
): void {
  if (!Number.isSafeInteger(at) || at < current.updatedAt) {
    throw new Error("transition timestamp cannot move backwards");
  }
}

function invalid(
  entity: "run" | "story" | "agent",
  status: string,
  transition: { readonly type: string },
  reason?: string,
): never {
  throw new InvalidStateTransitionError(
    entity,
    status,
    transition.type,
    reason,
  );
}

export function createRunState(
  input: Omit<
    RunState,
    "schemaVersion" | "status" | "blockedReason" | "updatedAt"
  >,
): RunState {
  return Object.freeze({
    ...input,
    schemaVersion: CONTROLLER_STATE_SCHEMA_VERSION,
    title: nonEmpty(input.title, "run title"),
    status: "planning",
    blockedReason: null,
    updatedAt: input.createdAt,
  });
}

export function transitionRun(
  current: RunState,
  transition: RunTransition,
): RunState {
  assertForwardTime(current, transition.at);

  switch (transition.type) {
    case "plan-prepared": {
      if (current.status !== "planning")
        invalid("run", current.status, transition);
      const policy = getComplexityPolicy(current.complexity);
      return Object.freeze({
        ...current,
        status: policy.requiresPlanConfirmation ? "awaiting-approval" : "ready",
        updatedAt: transition.at,
      });
    }
    case "plan-approved":
      if (current.status !== "awaiting-approval")
        invalid("run", current.status, transition);
      return Object.freeze({
        ...current,
        status: "ready",
        updatedAt: transition.at,
      });
    case "plan-revision-requested":
      if (current.status !== "awaiting-approval")
        invalid("run", current.status, transition);
      return Object.freeze({
        ...current,
        status: "planning",
        updatedAt: transition.at,
      });
    case "run-started":
      if (current.status !== "ready")
        invalid("run", current.status, transition);
      if (!transition.integrationWorktreeReady) {
        invalid(
          "run",
          current.status,
          transition,
          "integration worktree is not ready",
        );
      }
      return Object.freeze({
        ...current,
        status: "active",
        updatedAt: transition.at,
      });
    case "run-blocked":
      if (current.status !== "active")
        invalid("run", current.status, transition);
      return Object.freeze({
        ...current,
        status: "blocked",
        blockedReason: nonEmpty(transition.reason, "blocked reason"),
        updatedAt: transition.at,
      });
    case "run-resumed":
      if (current.status !== "blocked")
        invalid("run", current.status, transition);
      return Object.freeze({
        ...current,
        status: "active",
        blockedReason: null,
        updatedAt: transition.at,
      });
    case "run-completed":
      if (current.status !== "active")
        invalid("run", current.status, transition);
      if (transition.unfinishedStoryIds.length > 0) {
        invalid(
          "run",
          current.status,
          transition,
          `unfinished stories: ${transition.unfinishedStoryIds.join(", ")}`,
        );
      }
      return Object.freeze({
        ...current,
        status: "completed",
        updatedAt: transition.at,
      });
    case "run-failed":
      if (["completed", "failed", "cancelled"].includes(current.status)) {
        invalid("run", current.status, transition);
      }
      return Object.freeze({
        ...current,
        status: "failed",
        blockedReason: nonEmpty(transition.reason, "failure reason"),
        updatedAt: transition.at,
      });
    case "run-cancelled":
      if (["completed", "failed", "cancelled"].includes(current.status)) {
        invalid("run", current.status, transition);
      }
      return Object.freeze({
        ...current,
        status: "cancelled",
        blockedReason: nonEmpty(transition.reason, "cancellation reason"),
        updatedAt: transition.at,
      });
  }
}

export function createStoryState(
  input: Omit<
    StoryState,
    | "schemaVersion"
    | "status"
    | "assignedAgentId"
    | "candidateStoryHead"
    | "reviewedIntegrationHead"
    | "reviewerAgentId"
    | "mergeHead"
    | "blockedReason"
    | "blockedFrom"
    | "updatedAt"
  >,
): StoryState {
  return Object.freeze({
    ...input,
    schemaVersion: CONTROLLER_STATE_SCHEMA_VERSION,
    title: nonEmpty(input.title, "story title"),
    status: "planned",
    assignedAgentId: null,
    candidateStoryHead: null,
    reviewedIntegrationHead: null,
    reviewerAgentId: null,
    mergeHead: null,
    blockedReason: null,
    blockedFrom: null,
    updatedAt: input.createdAt,
  });
}

function assertStoryStatus(
  current: StoryState,
  transition: StoryTransition,
  allowed: readonly StoryStatus[],
): void {
  if (!allowed.includes(current.status)) {
    invalid("story", current.status, transition);
  }
}

export function transitionStory(
  current: StoryState,
  transition: StoryTransition,
): StoryState {
  assertForwardTime(current, transition.at);

  switch (transition.type) {
    case "story-prepared": {
      assertStoryStatus(current, transition, ["planned"]);
      const policy = getComplexityPolicy(transition.complexity);
      return Object.freeze({
        ...current,
        status: policy.requiresPlanConfirmation ? "awaiting-approval" : "ready",
        updatedAt: transition.at,
      });
    }
    case "story-plan-approved":
      assertStoryStatus(current, transition, ["awaiting-approval"]);
      return Object.freeze({
        ...current,
        status: "ready",
        updatedAt: transition.at,
      });
    case "story-assigned":
      assertStoryStatus(current, transition, ["ready"]);
      return Object.freeze({
        ...current,
        status: "assigned",
        assignedAgentId: nonEmpty(transition.agentId, "assigned agent id"),
        updatedAt: transition.at,
      });
    case "story-work-started":
      assertStoryStatus(current, transition, ["assigned", "changes-requested"]);
      return Object.freeze({
        ...current,
        status: "working",
        candidateStoryHead: null,
        reviewedIntegrationHead: null,
        reviewerAgentId: null,
        updatedAt: transition.at,
      });
    case "story-reassignment-requested":
      assertStoryStatus(current, transition, [
        "assigned",
        "working",
        "awaiting-candidate",
        "changes-requested",
      ]);
      if (!transition.writerLeaseReleased) {
        invalid(
          "story",
          current.status,
          transition,
          "writer lease is still active",
        );
      }
      nonEmpty(transition.reason, "reassignment reason");
      return Object.freeze({
        ...current,
        status: "ready",
        assignedAgentId: null,
        candidateStoryHead: null,
        reviewedIntegrationHead: null,
        reviewerAgentId: null,
        blockedReason: null,
        updatedAt: transition.at,
      });
    case "candidate-requested":
      assertStoryStatus(current, transition, ["working"]);
      if (!transition.writerLeaseReleased) {
        invalid(
          "story",
          current.status,
          transition,
          "writer lease is still active",
        );
      }
      return Object.freeze({
        ...current,
        status: "awaiting-candidate",
        updatedAt: transition.at,
      });
    case "candidate-created":
      assertStoryStatus(current, transition, ["awaiting-candidate"]);
      return Object.freeze({
        ...current,
        status: "awaiting-review",
        candidateStoryHead: nonEmpty(transition.storyHead, "story HEAD"),
        reviewedIntegrationHead: nonEmpty(
          transition.integrationHead,
          "integration HEAD",
        ),
        reviewerAgentId: null,
        updatedAt: transition.at,
      });
    case "review-approved":
      assertStoryStatus(current, transition, ["awaiting-review"]);
      if (!transition.checksPassed) {
        invalid(
          "story",
          current.status,
          transition,
          "required checks did not pass",
        );
      }
      if (current.candidateStoryHead !== transition.storyHead) {
        invalid(
          "story",
          current.status,
          transition,
          "reviewed story HEAD does not match candidate",
        );
      }
      if (current.reviewedIntegrationHead !== transition.integrationHead) {
        invalid(
          "story",
          current.status,
          transition,
          "reviewed integration HEAD does not match candidate base",
        );
      }
      return Object.freeze({
        ...current,
        status: "approved",
        reviewerAgentId: nonEmpty(
          transition.reviewerAgentId,
          "reviewer agent id",
        ),
        updatedAt: transition.at,
      });
    case "review-changes-requested":
      assertStoryStatus(current, transition, ["awaiting-review"]);
      return Object.freeze({
        ...current,
        status: "changes-requested",
        reviewerAgentId: nonEmpty(
          transition.reviewerAgentId,
          "reviewer agent id",
        ),
        updatedAt: transition.at,
      });
    case "review-invalidated":
      assertStoryStatus(current, transition, ["approved"]);
      return Object.freeze({
        ...current,
        status: "awaiting-review",
        reviewedIntegrationHead: nonEmpty(
          transition.integrationHead,
          "integration HEAD",
        ),
        reviewerAgentId: null,
        updatedAt: transition.at,
      });
    case "merge-started":
      assertStoryStatus(current, transition, ["approved"]);
      return Object.freeze({
        ...current,
        status: "merging",
        updatedAt: transition.at,
      });
    case "story-merged":
      assertStoryStatus(current, transition, ["merging"]);
      return Object.freeze({
        ...current,
        status: "merged",
        mergeHead: nonEmpty(transition.mergeHead, "merge HEAD"),
        updatedAt: transition.at,
      });
    case "story-blocked": {
      if (["blocked", "merged", "failed"].includes(current.status)) {
        invalid("story", current.status, transition);
      }
      const blockedFrom = current.status as Exclude<
        StoryStatus,
        "blocked" | "merged" | "failed"
      >;
      return Object.freeze({
        ...current,
        status: "blocked",
        blockedFrom,
        blockedReason: nonEmpty(transition.reason, "blocked reason"),
        updatedAt: transition.at,
      });
    }
    case "story-resumed":
      assertStoryStatus(current, transition, ["blocked"]);
      if (current.blockedFrom === null) {
        invalid(
          "story",
          current.status,
          transition,
          "blocked origin is missing",
        );
      }
      return Object.freeze({
        ...current,
        status: current.blockedFrom,
        blockedFrom: null,
        blockedReason: null,
        updatedAt: transition.at,
      });
    case "story-failed":
      if (["merged", "failed"].includes(current.status)) {
        invalid("story", current.status, transition);
      }
      return Object.freeze({
        ...current,
        status: "failed",
        blockedReason: nonEmpty(transition.reason, "failure reason"),
        updatedAt: transition.at,
      });
  }
}

export function createAgentState(
  input: Omit<
    AgentState,
    | "schemaVersion"
    | "status"
    | "paneId"
    | "piSessionPath"
    | "currentOperation"
    | "waitingReason"
    | "blockedReason"
    | "nudgeCount"
    | "lastNudgeAt"
    | "lastHeartbeatAt"
    | "lastMeaningfulActivityAt"
    | "updatedAt"
  >,
): AgentState {
  return Object.freeze({
    ...input,
    schemaVersion: CONTROLLER_STATE_SCHEMA_VERSION,
    status: "planned",
    paneId: null,
    piSessionPath: null,
    currentOperation: null,
    waitingReason: null,
    blockedReason: null,
    nudgeCount: 0,
    lastNudgeAt: null,
    lastHeartbeatAt: input.createdAt,
    lastMeaningfulActivityAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function assertAgentStatus(
  current: AgentState,
  transition: AgentTransition,
  allowed: readonly AgentStatus[],
): void {
  if (!allowed.includes(current.status)) {
    invalid("agent", current.status, transition);
  }
}

export function transitionAgent(
  current: AgentState,
  transition: AgentTransition,
): AgentState {
  assertForwardTime(current, transition.at);

  switch (transition.type) {
    case "launch-requested":
      assertAgentStatus(current, transition, ["planned"]);
      return Object.freeze({
        ...current,
        status: "launching",
        paneId: nonEmpty(transition.paneId, "pane id"),
        piSessionPath: null,
        currentOperation: "starting Pi session",
        waitingReason: null,
        blockedReason: null,
        updatedAt: transition.at,
      });
    case "session-ready":
      assertAgentStatus(current, transition, ["launching"]);
      return Object.freeze({
        ...current,
        status: "idle",
        piSessionPath: nonEmpty(transition.piSessionPath, "Pi session path"),
        currentOperation: null,
        lastHeartbeatAt: transition.at,
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "operation-started":
      assertAgentStatus(current, transition, ["idle"]);
      return Object.freeze({
        ...current,
        status: "working",
        currentOperation: nonEmpty(transition.operation, "operation"),
        waitingReason: null,
        blockedReason: null,
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "operation-finished":
      assertAgentStatus(current, transition, ["working", "reviewing"]);
      return Object.freeze({
        ...current,
        status: "idle",
        currentOperation: null,
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "waiting-for-input":
      assertAgentStatus(current, transition, ["idle", "working", "reviewing"]);
      return Object.freeze({
        ...current,
        status: "waiting",
        currentOperation: null,
        waitingReason: nonEmpty(transition.reason, "waiting reason"),
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "input-received":
      assertAgentStatus(current, transition, ["waiting"]);
      return Object.freeze({
        ...current,
        status: "idle",
        waitingReason: null,
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "agent-blocked":
      assertAgentStatus(current, transition, [
        "idle",
        "working",
        "waiting",
        "reviewing",
      ]);
      return Object.freeze({
        ...current,
        status: "blocked",
        currentOperation: null,
        waitingReason: null,
        blockedReason: nonEmpty(transition.reason, "blocked reason"),
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "agent-unblocked":
      assertAgentStatus(current, transition, ["blocked"]);
      return Object.freeze({
        ...current,
        status: "idle",
        blockedReason: null,
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "review-started":
      assertAgentStatus(current, transition, ["idle"]);
      return Object.freeze({
        ...current,
        status: "reviewing",
        currentOperation: nonEmpty(transition.operation, "review operation"),
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "heartbeat":
      assertAgentStatus(current, transition, [
        "launching",
        "idle",
        "working",
        "waiting",
        "blocked",
        "reviewing",
      ]);
      return Object.freeze({
        ...current,
        lastHeartbeatAt: transition.at,
        updatedAt: transition.at,
      });
    case "nudge-sent":
      assertAgentStatus(current, transition, ["idle"]);
      return Object.freeze({
        ...current,
        nudgeCount: current.nudgeCount + 1,
        lastNudgeAt: transition.at,
        updatedAt: transition.at,
      });
    case "agent-completed":
      assertAgentStatus(current, transition, ["idle", "working", "reviewing"]);
      return Object.freeze({
        ...current,
        status: "completed",
        currentOperation: null,
        waitingReason: null,
        blockedReason: null,
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "agent-failed":
      if (["completed", "failed", "closed"].includes(current.status)) {
        invalid("agent", current.status, transition);
      }
      return Object.freeze({
        ...current,
        status: "failed",
        currentOperation: null,
        waitingReason: null,
        blockedReason: nonEmpty(transition.reason, "failure reason"),
        lastMeaningfulActivityAt: transition.at,
        updatedAt: transition.at,
      });
    case "pane-lost":
      if (
        ["completed", "failed", "closed", "disconnected"].includes(
          current.status,
        )
      ) {
        invalid("agent", current.status, transition);
      }
      return Object.freeze({
        ...current,
        status: "disconnected",
        paneId: null,
        currentOperation: null,
        waitingReason: null,
        blockedReason: "Herdr pane disconnected",
        updatedAt: transition.at,
      });
    case "recovery-requested":
      assertAgentStatus(current, transition, ["disconnected"]);
      return Object.freeze({
        ...current,
        status: "launching",
        paneId: nonEmpty(transition.paneId, "pane id"),
        currentOperation: "restoring Pi session",
        blockedReason: null,
        updatedAt: transition.at,
      });
    case "agent-closed":
      assertAgentStatus(current, transition, [
        "completed",
        "failed",
        "disconnected",
      ]);
      if (!transition.writerLeaseReleased) {
        invalid(
          "agent",
          current.status,
          transition,
          "writer lease is still active",
        );
      }
      return Object.freeze({
        ...current,
        status: "closed",
        paneId: null,
        currentOperation: null,
        updatedAt: transition.at,
      });
  }
}

export interface LivenessPolicy {
  readonly quietPeriodMs: number;
  readonly nudgeBackoffMs: readonly number[];
}

export type LivenessDecision =
  | { readonly action: "none"; readonly reason: string }
  | { readonly action: "nudge"; readonly attempt: number }
  | { readonly action: "escalate"; readonly reason: string };

export const DEFAULT_LIVENESS_POLICY: LivenessPolicy = Object.freeze({
  quietPeriodMs: 90_000,
  nudgeBackoffMs: Object.freeze([90_000, 180_000, 300_000]),
});

export function assessAgentLiveness(
  agent: AgentState,
  now: number,
  policy: LivenessPolicy = DEFAULT_LIVENESS_POLICY,
): LivenessDecision {
  if (agent.status !== "idle") {
    return Object.freeze({
      action: "none",
      reason: `agent state is ${agent.status}`,
    });
  }
  if (
    agent.currentOperation !== null ||
    agent.waitingReason !== null ||
    agent.blockedReason !== null
  ) {
    return Object.freeze({
      action: "none",
      reason: "agent has an active operation or attention state",
    });
  }

  const referenceTime = agent.lastNudgeAt ?? agent.lastMeaningfulActivityAt;
  const requiredDelay =
    agent.nudgeCount === 0
      ? policy.quietPeriodMs
      : policy.nudgeBackoffMs[
          Math.min(agent.nudgeCount - 1, policy.nudgeBackoffMs.length - 1)
        ];

  if (requiredDelay === undefined) {
    return Object.freeze({
      action: "escalate",
      reason: "liveness policy has no nudge delay",
    });
  }
  if (now - referenceTime < requiredDelay) {
    return Object.freeze({
      action: "none",
      reason: "quiet threshold has not elapsed",
    });
  }
  if (agent.nudgeCount >= policy.nudgeBackoffMs.length) {
    return Object.freeze({
      action: "escalate",
      reason: "bounded liveness nudges exhausted",
    });
  }

  return Object.freeze({ action: "nudge", attempt: agent.nudgeCount + 1 });
}
