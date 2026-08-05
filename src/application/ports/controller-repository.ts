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
