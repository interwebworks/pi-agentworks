import type {
  AgentState,
  RunState,
  StoryState,
} from "../../domain/controller-state.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ControllerSnapshot {
  readonly revision: number;
  readonly run: RunState;
  readonly stories: readonly StoryState[];
  readonly agents: readonly AgentState[];
}

export type ControllerEntityType = "run" | "story" | "agent" | "controller";

export interface ControllerEventInput {
  readonly eventId: string;
  readonly type: string;
  readonly entityType: ControllerEntityType;
  readonly entityId: string;
  readonly payload: JsonValue;
  readonly occurredAt: number;
}

export interface ControllerEventRecord extends ControllerEventInput {
  readonly runId: string;
  readonly revision: number;
  readonly eventIndex: number;
}

export interface ControllerEventCursor {
  readonly revision: number;
  readonly eventIndex: number;
}

export interface ControllerLease {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expiresAt: number;
}

export interface FencedWrite {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly now: number;
}

export interface WriterLease {
  readonly runId: string;
  readonly storyId: string;
  readonly ownerAgentId: string | null;
  readonly leaseToken: number;
  readonly expiresAt: number | null;
  readonly updatedAt: number;
}

export interface AcquireWriterLeaseInput {
  readonly write: FencedWrite;
  readonly runId: string;
  readonly storyId: string;
  readonly ownerAgentId: string;
  readonly ttlMs: number;
  /** New agent state to persist atomically before first lease acquisition. */
  readonly agent?: AgentState;
}

export interface HeldWriterLeaseInput {
  readonly write: FencedWrite;
  readonly runId: string;
  readonly storyId: string;
  readonly ownerAgentId: string;
  readonly leaseToken: number;
}

export interface RevokeWriterLeaseInput {
  readonly write: FencedWrite;
  readonly runId: string;
  readonly storyId: string;
  readonly expectedLeaseToken: number;
  readonly reason: string;
}

export interface MaterializeAgentLaunchInput {
  readonly write: FencedWrite;
  readonly agent: AgentState;
  readonly paneId: string;
  readonly sessionId: string;
}

export interface ConfirmAgentLaunchInput {
  readonly write: FencedWrite;
  readonly runId: string;
  readonly agentId: string;
  readonly paneId: string;
  readonly sessionId: string;
  readonly processIds: readonly number[];
  readonly commandSha256: string;
}

export interface AgentLaunchRecord {
  readonly runId: string;
  readonly agentId: string;
  readonly paneId: string;
  readonly sessionId: string;
  readonly status: "materialized" | "confirmed";
  readonly processIds: readonly number[];
  readonly commandSha256: string | null;
  readonly updatedAt: number;
}

export interface AgentPaneRestorationRecord {
  readonly runId: string;
  readonly agentId: string;
  readonly restorationId: string;
  readonly operationId: string;
  readonly slot: number;
  readonly priorPaneId: string;
  readonly replacementPaneId: string | null;
  readonly sessionId: string;
  readonly status: "reserved" | "bound" | "confirmed";
  readonly updatedAt: number;
}

export interface ReserveAgentPaneRestorationInput {
  readonly write: FencedWrite;
  readonly runId: string;
  readonly agentId: string;
  readonly restorationId: string;
  readonly operationId: string;
  readonly slot: number;
  readonly priorPaneId: string;
  readonly sessionId: string;
}

export interface BindAgentPaneRestorationInput {
  readonly write: FencedWrite;
  readonly runId: string;
  readonly agentId: string;
  readonly restorationId: string;
  readonly replacementPaneId: string;
}

export interface ConfirmAgentPaneRestorationInput {
  readonly write: FencedWrite;
  readonly runId: string;
  readonly agentId: string;
  readonly restorationId: string;
  readonly replacementPaneId: string;
  readonly sessionId: string;
}

export interface InitializeRunInput {
  readonly write: FencedWrite;
  readonly idempotencyKey: string;
  readonly request: JsonValue;
  readonly run: RunState;
  readonly stories: readonly StoryState[];
  readonly agents: readonly AgentState[];
  readonly events: readonly ControllerEventInput[];
}

export interface CommitSnapshotInput {
  readonly write: FencedWrite;
  readonly runId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly request: JsonValue;
  readonly run: RunState;
  readonly stories: readonly StoryState[];
  readonly agents: readonly AgentState[];
  readonly events: readonly ControllerEventInput[];
}

export interface CommitResult {
  readonly revision: number;
  readonly eventIds: readonly string[];
  readonly replayed: boolean;
}

export interface ControllerRepository {
  acquireLease(ownerId: string, now: number, ttlMs: number): ControllerLease;
  renewLease(write: FencedWrite, ttlMs: number): ControllerLease;
  releaseLease(write: FencedWrite): void;
  acquireWriterLease(input: AcquireWriterLeaseInput): WriterLease;
  /** Optional during test-only/in-memory composition; production SQLite implements it. */
  materializeAgentLaunch?(input: MaterializeAgentLaunchInput): AgentState;
  confirmAgentLaunch(input: ConfirmAgentLaunchInput): AgentLaunchRecord;
  readAgentLaunch(runId: string, agentId: string): AgentLaunchRecord | null;
  reserveAgentPaneRestoration?(
    input: ReserveAgentPaneRestorationInput,
  ): AgentPaneRestorationRecord;
  bindAgentPaneRestoration?(
    input: BindAgentPaneRestorationInput,
  ): AgentPaneRestorationRecord;
  confirmAgentPaneRestoration?(
    input: ConfirmAgentPaneRestorationInput,
  ): AgentPaneRestorationRecord;
  readAgentPaneRestoration?(
    runId: string,
    agentId: string,
  ): AgentPaneRestorationRecord | null;
  renewWriterLease(input: HeldWriterLeaseInput, ttlMs: number): WriterLease;
  releaseWriterLease(input: HeldWriterLeaseInput): WriterLease;
  revokeWriterLease(input: RevokeWriterLeaseInput): WriterLease;
  readWriterLease(runId: string, storyId: string): WriterLease | null;
  initializeRun(input: InitializeRunInput): CommitResult;
  commitSnapshot(input: CommitSnapshotInput): CommitResult;
  loadSnapshot(runId: string): ControllerSnapshot | null;
  readEvents(
    runId: string,
    after: ControllerEventCursor,
    limit: number,
  ): readonly ControllerEventRecord[];
  assertIntegrity(): void;
  close(): void;
}
