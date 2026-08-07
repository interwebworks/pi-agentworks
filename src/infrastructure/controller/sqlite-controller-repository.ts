import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  AcquireWriterLeaseInput,
  CommitResult,
  CommitSnapshotInput,
  ControllerEventCursor,
  ControllerEventInput,
  ControllerEventRecord,
  ControllerLease,
  ControllerRepository,
  ControllerSnapshot,
  FencedWrite,
  HeldWriterLeaseInput,
  InitializeRunInput,
  JsonValue,
  RevokeWriterLeaseInput,
  WriterLease,
} from "../../application/ports/controller-repository.ts";
import {
  isAgentState,
  isRunState,
  transitionAgent,
  isStoryState,
  type AgentState,
  type RunState,
  type StoryState,
} from "../../domain/controller-state.ts";

const DATABASE_SCHEMA_VERSION = 2;
const MAX_EVENT_READ_LIMIT = 1_000;
const MAX_EVENTS_PER_COMMIT = 100;

interface RevisionRow {
  readonly revision: number;
}

interface StateRow {
  readonly state_json: string;
}

interface LeaseRow {
  readonly owner_id: string | null;
  readonly fencing_token: number;
  readonly expires_at: number | null;
}

interface CommandRow {
  readonly request_hash: string;
  readonly response_json: string;
}

interface EventRow {
  readonly event_id: string;
  readonly run_id: string;
  readonly revision: number;
  readonly event_index: number;
  readonly event_type: string;
  readonly entity_type: ControllerEventRecord["entityType"];
  readonly entity_id: string;
  readonly payload_json: string;
  readonly occurred_at: number;
}

interface IntegrityRow {
  readonly integrity_check: string;
}

interface WriterLeaseRow {
  readonly run_id: string;
  readonly story_id: string;
  readonly owner_agent_id: string | null;
  readonly lease_token: number;
  readonly expires_at: number | null;
  readonly updated_at: number;
}

interface ActiveWriterLeaseRow extends WriterLeaseRow {
  readonly owner_agent_id: string;
  readonly expires_at: number;
}

function isActiveWriterLeaseRow(
  row: WriterLeaseRow | null,
  now: number,
): row is ActiveWriterLeaseRow {
  return (
    typeof row?.owner_agent_id === "string" &&
    typeof row.expires_at === "number" &&
    row.expires_at > now
  );
}

export class ControllerRepositoryError extends Error {}

export class ControllerLeaseHeldError extends ControllerRepositoryError {
  readonly ownerId: string;
  readonly expiresAt: number;

  constructor(ownerId: string, expiresAt: number) {
    super(`Controller lease is held by ${ownerId} until ${String(expiresAt)}`);
    this.name = "ControllerLeaseHeldError";
    this.ownerId = ownerId;
    this.expiresAt = expiresAt;
  }
}

export class StaleControllerFenceError extends ControllerRepositoryError {
  constructor(reason: string) {
    super(`Controller fencing check failed: ${reason}`);
    this.name = "StaleControllerFenceError";
  }
}

export class WriterLeaseHeldError extends ControllerRepositoryError {
  readonly ownerAgentId: string;
  readonly expiresAt: number;

  constructor(ownerAgentId: string, expiresAt: number) {
    super(`Writer lease is held by ${ownerAgentId} until ${String(expiresAt)}`);
    this.name = "WriterLeaseHeldError";
    this.ownerAgentId = ownerAgentId;
    this.expiresAt = expiresAt;
  }
}

export class StaleWriterLeaseError extends ControllerRepositoryError {
  constructor(reason: string) {
    super(`Writer lease check failed: ${reason}`);
    this.name = "StaleWriterLeaseError";
  }
}

export class StaleRunRevisionError extends ControllerRepositoryError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Run revision is stale: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`,
    );
    this.name = "StaleRunRevisionError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class IdempotencyConflictError extends ControllerRepositoryError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key ${idempotencyKey} was already used for a different request`,
    );
    this.name = "IdempotencyConflictError";
  }
}

export class InvalidControllerSnapshotError extends ControllerRepositoryError {
  constructor(reason: string) {
    super(`Invalid controller snapshot: ${reason}`);
    this.name = "InvalidControllerSnapshotError";
  }
}

export class ControllerDatabaseIntegrityError extends ControllerRepositoryError {
  constructor(result: string) {
    super(`Controller database integrity check failed: ${result}`);
    this.name = "ControllerDatabaseIntegrityError";
  }
}

function asSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ControllerRepositoryError(`${label} must be a safe integer`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ControllerRepositoryError(`${label} cannot be empty`);
  }
  return normalized;
}

function stableJson(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ControllerRepositoryError(
        "JSON request numbers must be finite",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value as readonly JsonValue[];
    return `[${items.map((item) => stableJson(item)).join(",")}]`;
  }

  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableJson(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

function requestHash(request: JsonValue): string {
  return createHash("sha256").update(stableJson(request)).digest("hex");
}

function stringifyJson(value: JsonValue | object): string {
  return JSON.stringify(value);
}

function parseJsonObject(
  serialized: string,
  label: string,
): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new ControllerDatabaseIntegrityError(
      `${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ControllerDatabaseIntegrityError(
      `${label} must contain a JSON object`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function validateStoredState(
  value: Readonly<Record<string, unknown>>,
  expectedId: string,
  expectedRunId: string,
  label: string,
): void {
  if (value.id !== expectedId) {
    throw new ControllerDatabaseIntegrityError(
      `${label} id does not match its database key`,
    );
  }
  if ("runId" in value && value.runId !== expectedRunId) {
    throw new ControllerDatabaseIntegrityError(
      `${label} belongs to a different run`,
    );
  }
  if (!("runId" in value) && value.id !== expectedRunId) {
    throw new ControllerDatabaseIntegrityError(
      `${label} belongs to a different run`,
    );
  }
}

function validateSnapshotMembers(
  run: RunState,
  stories: readonly StoryState[],
  agents: readonly AgentState[],
): void {
  if (!isRunState(run)) {
    throw new InvalidControllerSnapshotError("run state has an invalid shape");
  }

  const storyIds = new Set<string>();
  for (const story of stories) {
    if (!isStoryState(story) || story.runId !== run.id) {
      throw new InvalidControllerSnapshotError(
        `story ${story.id} does not belong to run ${run.id}`,
      );
    }
    if (storyIds.has(story.id)) {
      throw new InvalidControllerSnapshotError(
        `story ${story.id} is duplicated`,
      );
    }
    storyIds.add(story.id);
  }

  const agentIds = new Set<string>();
  for (const agent of agents) {
    if (!isAgentState(agent) || agent.runId !== run.id) {
      throw new InvalidControllerSnapshotError(
        `agent ${agent.id} does not belong to run ${run.id}`,
      );
    }
    if (agentIds.has(agent.id)) {
      throw new InvalidControllerSnapshotError(
        `agent ${agent.id} is duplicated`,
      );
    }
    agentIds.add(agent.id);
  }
}

function validateEvents(events: readonly ControllerEventInput[]): void {
  if (events.length === 0 || events.length > MAX_EVENTS_PER_COMMIT) {
    throw new ControllerRepositoryError(
      `State changes require from 1 to ${String(MAX_EVENTS_PER_COMMIT)} events`,
    );
  }
  const eventIds = new Set<string>();
  for (const event of events) {
    nonEmpty(event.eventId, "event id");
    nonEmpty(event.type, "event type");
    nonEmpty(event.entityId, "event entity id");
    asSafeInteger(event.occurredAt, "event timestamp");
    if (eventIds.has(event.eventId)) {
      throw new ControllerRepositoryError(
        `Event ${event.eventId} is duplicated`,
      );
    }
    eventIds.add(event.eventId);
    stringifyJson(event.payload);
  }
}

function parseWriterLease(row: WriterLeaseRow): WriterLease {
  const leaseToken = asSafeInteger(row.lease_token, "writer lease token");
  const updatedAt = asSafeInteger(
    row.updated_at,
    "writer lease update timestamp",
  );
  if (leaseToken < 0) {
    throw new ControllerDatabaseIntegrityError(
      "writer lease token cannot be negative",
    );
  }
  if ((row.owner_agent_id === null) !== (row.expires_at === null)) {
    throw new ControllerDatabaseIntegrityError(
      "writer lease owner and expiration are inconsistent",
    );
  }
  const expiresAt =
    row.expires_at === null
      ? null
      : asSafeInteger(row.expires_at, "writer lease expiration");
  return Object.freeze({
    runId: row.run_id,
    storyId: row.story_id,
    ownerAgentId: row.owner_agent_id,
    leaseToken,
    expiresAt,
    updatedAt,
  });
}

function parseCommitResult(
  serialized: string,
  replayed: boolean,
): CommitResult {
  const value = parseJsonObject(serialized, "idempotency response");
  if (!Number.isSafeInteger(value.revision) || !Array.isArray(value.eventIds)) {
    throw new ControllerDatabaseIntegrityError(
      "idempotency response has an invalid shape",
    );
  }
  const eventIds = value.eventIds;
  if (
    !eventIds.every((eventId): eventId is string => typeof eventId === "string")
  ) {
    throw new ControllerDatabaseIntegrityError(
      "idempotency response has invalid event ids",
    );
  }
  return Object.freeze({
    revision: value.revision as number,
    eventIds: Object.freeze([...eventIds]),
    replayed,
  });
}

export class SqliteControllerRepository implements ControllerRepository {
  readonly #database: DatabaseSync;
  readonly #databasePath: string;
  #closed = false;

  constructor(databasePath: string) {
    this.#databasePath = resolve(nonEmpty(databasePath, "database path"));
    const directory = dirname(this.#databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);

    this.#database = new DatabaseSync(this.#databasePath);
    try {
      this.#database.exec("PRAGMA busy_timeout = 5000");
      this.#database.exec("PRAGMA foreign_keys = ON");
      this.#database.prepare("PRAGMA journal_mode = WAL").get();
      this.#database.exec("PRAGMA synchronous = FULL");
      this.#migrate();
      this.#protectDatabaseFiles();
      this.assertIntegrity();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  acquireLease(ownerId: string, now: number, ttlMs: number): ControllerLease {
    this.#assertOpen();
    const normalizedOwnerId = nonEmpty(ownerId, "lease owner id");
    this.#assertTimeAndTtl(now, ttlMs);

    const lease = this.#transaction(() => {
      const row = this.#database
        .prepare(
          "SELECT owner_id, fencing_token, expires_at FROM controller_lease WHERE singleton = 1",
        )
        .get() as unknown as LeaseRow | undefined;
      if (row === undefined) {
        throw new ControllerDatabaseIntegrityError(
          "controller lease row is missing",
        );
      }

      if (
        row.owner_id !== null &&
        row.expires_at !== null &&
        row.expires_at > now &&
        row.owner_id !== normalizedOwnerId
      ) {
        throw new ControllerLeaseHeldError(row.owner_id, row.expires_at);
      }

      const fencingToken =
        row.owner_id === normalizedOwnerId &&
        row.expires_at !== null &&
        row.expires_at > now
          ? row.fencing_token
          : row.fencing_token + 1;
      const expiresAt = now + ttlMs;
      this.#database
        .prepare(
          `UPDATE controller_lease
           SET owner_id = ?, fencing_token = ?, expires_at = ?
           WHERE singleton = 1`,
        )
        .run(normalizedOwnerId, fencingToken, expiresAt);
      return Object.freeze({
        ownerId: normalizedOwnerId,
        fencingToken,
        expiresAt,
      });
    });
    this.#protectDatabaseFiles();
    return lease;
  }

  renewLease(write: FencedWrite, ttlMs: number): ControllerLease {
    this.#assertOpen();
    this.#assertTimeAndTtl(write.now, ttlMs);
    const lease = this.#transaction(() => {
      this.#assertFence(write);
      const expiresAt = write.now + ttlMs;
      this.#database
        .prepare(
          "UPDATE controller_lease SET expires_at = ? WHERE singleton = 1",
        )
        .run(expiresAt);
      return Object.freeze({
        ownerId: write.ownerId,
        fencingToken: write.fencingToken,
        expiresAt,
      });
    });
    this.#protectDatabaseFiles();
    return lease;
  }

  releaseLease(write: FencedWrite): void {
    this.#assertOpen();
    this.#transaction(() => {
      this.#assertFence(write);
      this.#database
        .prepare(
          "UPDATE controller_lease SET owner_id = NULL, expires_at = NULL WHERE singleton = 1",
        )
        .run();
    });
    this.#protectDatabaseFiles();
  }

  materializeAgentLaunch(input: {
    readonly write: FencedWrite;
    readonly agent: AgentState;
    readonly paneId: string;
  }): AgentState {
    this.#assertOpen();
    const paneId = nonEmpty(input.paneId, "agent launch pane id");
    const launched = transitionAgent(input.agent, {
      type: "launch-requested",
      paneId,
      at: input.write.now,
    });
    this.#transaction(() => {
      this.#assertFence(input.write);
      const existing = this.#database
        .prepare(
          "SELECT state_json FROM agents WHERE run_id = ? AND agent_id = ?",
        )
        .get(launched.runId, launched.id) as unknown as StateRow | undefined;
      if (existing !== undefined) {
        const current = parseJsonObject(
          existing.state_json,
          "agent launch state",
        );
        if (!isAgentState(current)) {
          throw new ControllerDatabaseIntegrityError(
            "agent launch state is invalid",
          );
        }
        if (current.status !== "planned") {
          throw new StaleWriterLeaseError(
            `agent ${launched.id} is already ${current.status}`,
          );
        }
      }
      this.#database
        .prepare(
          `INSERT INTO agents(agent_id, run_id, state_version, status, state_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(run_id, agent_id) DO UPDATE SET
             state_version = excluded.state_version,
             status = excluded.status,
             state_json = excluded.state_json`,
        )
        .run(
          launched.id,
          launched.runId,
          launched.schemaVersion,
          launched.status,
          JSON.stringify(launched),
        );
    });
    this.#protectDatabaseFiles();
    return launched;
  }

  acquireWriterLease(input: AcquireWriterLeaseInput): WriterLease {
    this.#assertOpen();
    const runId = nonEmpty(input.runId, "writer lease run id");
    const storyId = nonEmpty(input.storyId, "writer lease story id");
    const ownerAgentId = nonEmpty(
      input.ownerAgentId,
      "writer lease owner agent id",
    );
    this.#assertTimeAndTtl(input.write.now, input.ttlMs);
    const lease = this.#transaction(() => {
      this.#assertFence(input.write);
      this.#materializeWriterAssignment(input);
      const current = this.#writerLeaseRow(runId, storyId);
      if (isActiveWriterLeaseRow(current, input.write.now)) {
        if (current.owner_agent_id !== ownerAgentId) {
          throw new WriterLeaseHeldError(
            current.owner_agent_id,
            current.expires_at,
          );
        }
        this.#assertAgentAssignedToStory(
          runId,
          storyId,
          ownerAgentId,
          input.agent !== undefined,
        );
        return parseWriterLease(current);
      }
      this.#assertAgentAssignedToStory(
        runId,
        storyId,
        ownerAgentId,
        input.agent !== undefined,
      );

      const leaseToken = (current?.lease_token ?? 0) + 1;
      const expiresAt = input.write.now + input.ttlMs;
      this.#database
        .prepare(
          `INSERT INTO writer_leases(
             run_id, story_id, owner_agent_id, lease_token, expires_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, story_id) DO UPDATE SET
             owner_agent_id = excluded.owner_agent_id,
             lease_token = excluded.lease_token,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          runId,
          storyId,
          ownerAgentId,
          leaseToken,
          expiresAt,
          input.write.now,
        );
      this.#recordWriterLeaseEvent(
        input.write,
        runId,
        storyId,
        leaseToken,
        ownerAgentId,
        "acquired",
        null,
      );
      return Object.freeze({
        runId,
        storyId,
        ownerAgentId,
        leaseToken,
        expiresAt,
        updatedAt: input.write.now,
      });
    });
    this.#protectDatabaseFiles();
    return lease;
  }

  renewWriterLease(input: HeldWriterLeaseInput, ttlMs: number): WriterLease {
    this.#assertOpen();
    this.#assertTimeAndTtl(input.write.now, ttlMs);
    const lease = this.#transaction(() => {
      this.#assertFence(input.write);
      const current = this.#assertHeldWriterLease(input, true);
      const expiresAt = input.write.now + ttlMs;
      this.#database
        .prepare(
          `UPDATE writer_leases
           SET expires_at = ?, updated_at = ?
           WHERE run_id = ? AND story_id = ?`,
        )
        .run(expiresAt, input.write.now, input.runId, input.storyId);
      this.#recordWriterLeaseEvent(
        input.write,
        input.runId,
        input.storyId,
        current.lease_token,
        input.ownerAgentId,
        "renewed",
        null,
      );
      return Object.freeze({
        runId: input.runId,
        storyId: input.storyId,
        ownerAgentId: input.ownerAgentId,
        leaseToken: current.lease_token,
        expiresAt,
        updatedAt: input.write.now,
      });
    });
    this.#protectDatabaseFiles();
    return lease;
  }

  releaseWriterLease(input: HeldWriterLeaseInput): WriterLease {
    this.#assertOpen();
    const lease = this.#transaction(() => {
      this.#assertFence(input.write);
      const current = this.#writerLeaseRow(input.runId, input.storyId);
      if (
        current !== null &&
        current.owner_agent_id === null &&
        current.lease_token === input.leaseToken
      ) {
        return parseWriterLease(current);
      }
      const held = this.#assertHeldWriterLease(input, true);
      this.#database
        .prepare(
          `UPDATE writer_leases
           SET owner_agent_id = NULL, expires_at = NULL, updated_at = ?
           WHERE run_id = ? AND story_id = ?`,
        )
        .run(input.write.now, input.runId, input.storyId);
      this.#recordWriterLeaseEvent(
        input.write,
        input.runId,
        input.storyId,
        held.lease_token,
        input.ownerAgentId,
        "released",
        null,
      );
      return Object.freeze({
        runId: input.runId,
        storyId: input.storyId,
        ownerAgentId: null,
        leaseToken: held.lease_token,
        expiresAt: null,
        updatedAt: input.write.now,
      });
    });
    this.#protectDatabaseFiles();
    return lease;
  }

  revokeWriterLease(input: RevokeWriterLeaseInput): WriterLease {
    this.#assertOpen();
    const reason = nonEmpty(input.reason, "writer lease revocation reason");
    asSafeInteger(input.expectedLeaseToken, "expected writer lease token");
    const lease = this.#transaction(() => {
      this.#assertFence(input.write);
      const current = this.#requiredWriterLeaseRow(input.runId, input.storyId);
      if (current.lease_token !== input.expectedLeaseToken) {
        throw new StaleWriterLeaseError("token is stale or missing");
      }
      if (current.owner_agent_id === null) return parseWriterLease(current);
      const priorOwner = current.owner_agent_id;
      this.#database
        .prepare(
          `UPDATE writer_leases
           SET owner_agent_id = NULL, expires_at = NULL, updated_at = ?
           WHERE run_id = ? AND story_id = ?`,
        )
        .run(input.write.now, input.runId, input.storyId);
      this.#recordWriterLeaseEvent(
        input.write,
        input.runId,
        input.storyId,
        current.lease_token,
        priorOwner,
        "revoked",
        reason,
      );
      return Object.freeze({
        runId: input.runId,
        storyId: input.storyId,
        ownerAgentId: null,
        leaseToken: current.lease_token,
        expiresAt: null,
        updatedAt: input.write.now,
      });
    });
    this.#protectDatabaseFiles();
    return lease;
  }

  readWriterLease(runId: string, storyId: string): WriterLease | null {
    this.#assertOpen();
    const row = this.#writerLeaseRow(
      nonEmpty(runId, "writer lease run id"),
      nonEmpty(storyId, "writer lease story id"),
    );
    return row === null ? null : parseWriterLease(row);
  }

  initializeRun(input: InitializeRunInput): CommitResult {
    this.#assertOpen();
    const runId = nonEmpty(input.run.id, "run id");
    const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotency key");
    validateSnapshotMembers(input.run, input.stories, input.agents);
    validateEvents(input.events);
    const hash = requestHash(input.request);

    const result = this.#transaction(() => {
      this.#assertFence(input.write);
      const replay = this.#findIdempotentResult(runId, idempotencyKey, hash);
      if (replay !== null) return replay;

      const existing = this.#database
        .prepare("SELECT revision FROM runs WHERE run_id = ?")
        .get(runId) as unknown as RevisionRow | undefined;
      if (existing !== undefined) {
        throw new ControllerRepositoryError(`Run ${runId} already exists`);
      }

      const revision = 1;
      this.#database
        .prepare(
          `INSERT INTO runs(run_id, revision, state_version, status, state_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          revision,
          input.run.schemaVersion,
          input.run.status,
          stringifyJson(input.run),
          input.run.createdAt,
          input.run.updatedAt,
        );
      this.#synchronizeChildren(runId, input.stories, input.agents);
      this.#appendEvents(runId, revision, input.events);
      return this.#recordCommand(
        runId,
        idempotencyKey,
        hash,
        revision,
        input.events,
      );
    });
    this.#protectDatabaseFiles();
    return result;
  }

  commitSnapshot(input: CommitSnapshotInput): CommitResult {
    this.#assertOpen();
    const runId = nonEmpty(input.runId, "run id");
    const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotency key");
    asSafeInteger(input.expectedRevision, "expected revision");
    if (input.expectedRevision < 1) {
      throw new ControllerRepositoryError("expected revision must be positive");
    }
    if (input.run.id !== runId) {
      throw new InvalidControllerSnapshotError(
        "run id does not match the command run id",
      );
    }
    validateSnapshotMembers(input.run, input.stories, input.agents);
    validateEvents(input.events);
    const hash = requestHash(input.request);

    const result = this.#transaction(() => {
      this.#assertFence(input.write);
      const replay = this.#findIdempotentResult(runId, idempotencyKey, hash);
      if (replay !== null) return replay;

      const row = this.#database
        .prepare("SELECT revision FROM runs WHERE run_id = ?")
        .get(runId) as unknown as RevisionRow | undefined;
      if (row === undefined) {
        throw new ControllerRepositoryError(`Run ${runId} does not exist`);
      }
      const actualRevision = asSafeInteger(row.revision, "stored run revision");
      if (actualRevision !== input.expectedRevision) {
        throw new StaleRunRevisionError(input.expectedRevision, actualRevision);
      }
      this.#assertWriterLeaseSnapshotConsistency(
        runId,
        input.stories,
        input.agents,
      );

      const revision = actualRevision + 1;
      this.#database
        .prepare(
          `UPDATE runs
           SET revision = ?, state_version = ?, status = ?, state_json = ?, updated_at = ?
           WHERE run_id = ? AND revision = ?`,
        )
        .run(
          revision,
          input.run.schemaVersion,
          input.run.status,
          stringifyJson(input.run),
          input.run.updatedAt,
          runId,
          actualRevision,
        );
      this.#synchronizeChildren(runId, input.stories, input.agents);
      this.#appendEvents(runId, revision, input.events);
      return this.#recordCommand(
        runId,
        idempotencyKey,
        hash,
        revision,
        input.events,
      );
    });
    this.#protectDatabaseFiles();
    return result;
  }

  loadSnapshot(runId: string): ControllerSnapshot | null {
    this.#assertOpen();
    const normalizedRunId = nonEmpty(runId, "run id");
    const runRow = this.#database
      .prepare("SELECT revision, state_json FROM runs WHERE run_id = ?")
      .get(normalizedRunId) as unknown as (RevisionRow & StateRow) | undefined;
    if (runRow === undefined) return null;

    const runValue = parseJsonObject(
      runRow.state_json,
      `run ${normalizedRunId}`,
    );
    if (!isRunState(runValue)) {
      throw new ControllerDatabaseIntegrityError(
        `run ${normalizedRunId} has an invalid state shape`,
      );
    }
    validateStoredState(
      runValue,
      normalizedRunId,
      normalizedRunId,
      `run ${normalizedRunId}`,
    );
    const run = runValue;

    const storyRows = this.#database
      .prepare(
        "SELECT story_id, state_json FROM stories WHERE run_id = ? ORDER BY story_id",
      )
      .all(normalizedRunId) as unknown as readonly {
      readonly story_id: string;
      readonly state_json: string;
    }[];
    const stories = storyRows.map((row) => {
      const stateValue = parseJsonObject(
        row.state_json,
        `story ${row.story_id}`,
      );
      if (!isStoryState(stateValue)) {
        throw new ControllerDatabaseIntegrityError(
          `story ${row.story_id} has an invalid state shape`,
        );
      }
      validateStoredState(
        stateValue,
        row.story_id,
        normalizedRunId,
        `story ${row.story_id}`,
      );
      return Object.freeze(stateValue);
    });

    const agentRows = this.#database
      .prepare(
        "SELECT agent_id, state_json FROM agents WHERE run_id = ? ORDER BY agent_id",
      )
      .all(normalizedRunId) as unknown as readonly {
      readonly agent_id: string;
      readonly state_json: string;
    }[];
    const agents = agentRows.map((row) => {
      const stateValue = parseJsonObject(
        row.state_json,
        `agent ${row.agent_id}`,
      );
      if (!isAgentState(stateValue)) {
        throw new ControllerDatabaseIntegrityError(
          `agent ${row.agent_id} has an invalid state shape`,
        );
      }
      validateStoredState(
        stateValue,
        row.agent_id,
        normalizedRunId,
        `agent ${row.agent_id}`,
      );
      return Object.freeze(stateValue);
    });

    return Object.freeze({
      revision: asSafeInteger(runRow.revision, "stored run revision"),
      run: Object.freeze(run),
      stories: Object.freeze(stories),
      agents: Object.freeze(agents),
    });
  }

  readEvents(
    runId: string,
    after: ControllerEventCursor,
    limit: number,
  ): readonly ControllerEventRecord[] {
    this.#assertOpen();
    const normalizedRunId = nonEmpty(runId, "run id");
    asSafeInteger(after.revision, "event cursor revision");
    asSafeInteger(after.eventIndex, "event cursor index");
    asSafeInteger(limit, "event read limit");
    if (
      after.revision < 0 ||
      after.eventIndex < -1 ||
      limit < 1 ||
      limit > MAX_EVENT_READ_LIMIT
    ) {
      throw new ControllerRepositoryError(
        `Event reads require a non-negative revision, an index of at least -1, and a limit from 1 to ${String(MAX_EVENT_READ_LIMIT)}`,
      );
    }

    const rows = this.#database
      .prepare(
        `SELECT event_id, run_id, revision, event_index, event_type, entity_type,
                entity_id, payload_json, occurred_at
         FROM controller_events
         WHERE run_id = ?
           AND (revision > ? OR (revision = ? AND event_index > ?))
         ORDER BY revision, event_index
         LIMIT ?`,
      )
      .all(
        normalizedRunId,
        after.revision,
        after.revision,
        after.eventIndex,
        limit,
      ) as unknown as readonly EventRow[];

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          eventId: row.event_id,
          runId: row.run_id,
          revision: asSafeInteger(row.revision, "event revision"),
          eventIndex: asSafeInteger(row.event_index, "event index"),
          type: row.event_type,
          entityType: row.entity_type,
          entityId: row.entity_id,
          payload: JSON.parse(row.payload_json) as JsonValue,
          occurredAt: asSafeInteger(row.occurred_at, "event timestamp"),
        }),
      ),
    );
  }

  assertIntegrity(): void {
    this.#assertOpen();
    const rows = this.#database
      .prepare("PRAGMA integrity_check")
      .all() as unknown as readonly IntegrityRow[];
    const failure = rows.find((row) => row.integrity_check !== "ok");
    if (failure !== undefined || rows.length !== 1) {
      throw new ControllerDatabaseIntegrityError(
        failure?.integrity_check ??
          "integrity check returned an unexpected result",
      );
    }
    const foreignKeyFailures = this.#database
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (foreignKeyFailures.length > 0) {
      throw new ControllerDatabaseIntegrityError(
        "foreign key check found violations",
      );
    }
    const leaseRows = this.#database
      .prepare(
        `SELECT run_id, story_id, owner_agent_id, lease_token, expires_at, updated_at
         FROM writer_leases`,
      )
      .all() as unknown as readonly WriterLeaseRow[];
    for (const row of leaseRows) parseWriterLease(row);
    const leaseRunIds = new Set(leaseRows.map((row) => row.run_id));
    for (const runId of leaseRunIds) {
      const snapshot = this.loadSnapshot(runId);
      if (snapshot === null) {
        throw new ControllerDatabaseIntegrityError(
          `writer leases reference missing run ${runId}`,
        );
      }
      try {
        this.#assertWriterLeaseSnapshotConsistency(
          runId,
          snapshot.stories,
          snapshot.agents,
        );
      } catch (error) {
        if (error instanceof StaleWriterLeaseError) {
          throw new ControllerDatabaseIntegrityError(error.message);
        }
        throw error;
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #migrate(): void {
    this.#transaction(() => {
      const row = this.#database
        .prepare("PRAGMA user_version")
        .get() as unknown as {
        readonly user_version: number;
      };
      const version = asSafeInteger(
        row.user_version,
        "database schema version",
      );
      if (version > DATABASE_SCHEMA_VERSION) {
        throw new ControllerRepositoryError(
          `Database schema version ${String(version)} is newer than supported version ${String(DATABASE_SCHEMA_VERSION)}`,
        );
      }
      if (version === 0) {
        this.#database.exec(`
          CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL CHECK (revision >= 1),
            state_version INTEGER NOT NULL,
            status TEXT NOT NULL,
            state_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;

          CREATE TABLE stories (
            story_id TEXT NOT NULL,
            run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
            state_version INTEGER NOT NULL,
            status TEXT NOT NULL,
            state_json TEXT NOT NULL,
            PRIMARY KEY (run_id, story_id)
          ) STRICT;
          CREATE INDEX stories_by_run ON stories(run_id, story_id);

          CREATE TABLE agents (
            agent_id TEXT NOT NULL,
            run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
            state_version INTEGER NOT NULL,
            status TEXT NOT NULL,
            state_json TEXT NOT NULL,
            PRIMARY KEY (run_id, agent_id)
          ) STRICT;
          CREATE INDEX agents_by_run ON agents(run_id, agent_id);

          CREATE TABLE controller_events (
            event_id TEXT NOT NULL UNIQUE,
            run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
            revision INTEGER NOT NULL CHECK (revision >= 1),
            event_index INTEGER NOT NULL CHECK (event_index >= 0),
            event_type TEXT NOT NULL,
            entity_type TEXT NOT NULL CHECK (entity_type IN ('run', 'story', 'agent', 'controller')),
            entity_id TEXT NOT NULL,
            payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
            occurred_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, revision, event_index)
          ) STRICT;
          CREATE INDEX events_by_run_revision
            ON controller_events(run_id, revision, event_index);

          CREATE TABLE processed_commands (
            run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            response_json TEXT NOT NULL CHECK (json_valid(response_json)),
            committed_revision INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, idempotency_key)
          ) STRICT;

          CREATE TABLE controller_lease (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            owner_id TEXT,
            fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
            expires_at INTEGER,
            CHECK (
              (owner_id IS NULL AND expires_at IS NULL) OR
              (owner_id IS NOT NULL AND expires_at IS NOT NULL)
            )
          ) STRICT;
          INSERT INTO controller_lease(singleton, owner_id, fencing_token, expires_at)
          VALUES (1, NULL, 0, NULL);

          PRAGMA user_version = 2;
        `);
      }
      if (version < 2) {
        this.#database.exec(`
          CREATE TABLE writer_leases (
            run_id TEXT NOT NULL,
            story_id TEXT NOT NULL,
            owner_agent_id TEXT,
            lease_token INTEGER NOT NULL CHECK (lease_token >= 1),
            expires_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, story_id),
            FOREIGN KEY (run_id, story_id)
              REFERENCES stories(run_id, story_id) ON DELETE CASCADE,
            CHECK (
              (owner_agent_id IS NULL AND expires_at IS NULL) OR
              (owner_agent_id IS NOT NULL AND expires_at IS NOT NULL)
            )
          ) STRICT;

          CREATE TABLE writer_lease_events (
            writer_lease_event_id INTEGER PRIMARY KEY,
            run_id TEXT NOT NULL,
            story_id TEXT NOT NULL,
            lease_token INTEGER NOT NULL CHECK (lease_token >= 1),
            owner_agent_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK (
              action IN ('acquired', 'renewed', 'released', 'revoked')
            ),
            reason TEXT,
            controller_owner_id TEXT NOT NULL,
            controller_fencing_token INTEGER NOT NULL,
            occurred_at INTEGER NOT NULL,
            FOREIGN KEY (run_id, story_id)
              REFERENCES stories(run_id, story_id) ON DELETE CASCADE
          ) STRICT;
          CREATE INDEX writer_lease_events_by_story
            ON writer_lease_events(run_id, story_id, writer_lease_event_id);

          PRAGMA user_version = 2;
        `);
      }
    });
  }

  #assertWriterLeaseSnapshotConsistency(
    runId: string,
    stories: readonly StoryState[],
    agents: readonly AgentState[],
  ): void {
    const activeRows = this.#database
      .prepare(
        `SELECT run_id, story_id, owner_agent_id, lease_token, expires_at, updated_at
         FROM writer_leases
         WHERE run_id = ? AND owner_agent_id IS NOT NULL`,
      )
      .all(runId) as unknown as readonly WriterLeaseRow[];
    for (const lease of activeRows) {
      const story = stories.find(
        (candidate) => candidate.id === lease.story_id,
      );
      const agent = agents.find(
        (candidate) => candidate.id === lease.owner_agent_id,
      );
      const assignedAgentId = story?.assignedAgentId ?? null;
      const agentTaskId = agent?.taskId ?? null;
      const storyWorktree = story?.worktreePath ?? null;
      const agentWorktree = agent?.worktreePath ?? null;
      const agentClosed = agent?.status === "closed";
      const storyCanBeWritten =
        story !== undefined &&
        ["assigned", "working", "changes-requested", "blocked"].includes(
          story.status,
        );
      if (
        assignedAgentId !== lease.owner_agent_id ||
        agentTaskId !== lease.story_id ||
        storyWorktree === null ||
        storyWorktree !== agentWorktree ||
        agentClosed ||
        !storyCanBeWritten
      ) {
        throw new StaleWriterLeaseError(
          `story ${lease.story_id} must release or revoke its writer lease before reassignment or agent removal`,
        );
      }
    }
  }

  #requiredWriterLeaseRow(runId: string, storyId: string): WriterLeaseRow {
    const row = this.#writerLeaseRow(runId, storyId);
    if (row === null) {
      throw new StaleWriterLeaseError("lease is missing");
    }
    return row;
  }

  #writerLeaseRow(runId: string, storyId: string): WriterLeaseRow | null {
    const row = this.#database
      .prepare(
        `SELECT run_id, story_id, owner_agent_id, lease_token, expires_at, updated_at
         FROM writer_leases
         WHERE run_id = ? AND story_id = ?`,
      )
      .get(runId, storyId) as unknown as WriterLeaseRow | undefined;
    return row ?? null;
  }

  #assertHeldWriterLease(
    input: HeldWriterLeaseInput,
    requireUnexpired: boolean,
  ): WriterLeaseRow {
    const runId = nonEmpty(input.runId, "writer lease run id");
    const storyId = nonEmpty(input.storyId, "writer lease story id");
    const ownerAgentId = nonEmpty(
      input.ownerAgentId,
      "writer lease owner agent id",
    );
    asSafeInteger(input.leaseToken, "writer lease token");
    asSafeInteger(input.write.now, "writer lease timestamp");
    const row = this.#writerLeaseRow(runId, storyId);
    if (row === null) throw new StaleWriterLeaseError("lease is missing");
    if (row.owner_agent_id !== ownerAgentId) {
      throw new StaleWriterLeaseError("owner does not hold the lease");
    }
    if (row.lease_token !== input.leaseToken) {
      throw new StaleWriterLeaseError("token is stale");
    }
    if (
      requireUnexpired &&
      (row.expires_at === null || row.expires_at <= input.write.now)
    ) {
      throw new StaleWriterLeaseError("lease has expired");
    }
    return row;
  }

  #materializeWriterAssignment(input: AcquireWriterLeaseInput): void {
    const agent = input.agent;
    if (agent === undefined) return;
    if (
      agent.id !== input.ownerAgentId ||
      agent.runId !== input.runId ||
      agent.taskId !== input.storyId
    ) {
      throw new StaleWriterLeaseError(
        "pending writer agent identity does not match the lease",
      );
    }
    const storyRow = this.#database
      .prepare(
        "SELECT state_json FROM stories WHERE run_id = ? AND story_id = ?",
      )
      .get(input.runId, input.storyId) as unknown as StateRow | undefined;
    if (storyRow === undefined) {
      throw new StaleWriterLeaseError("assigned story is missing");
    }
    const story = parseJsonObject(storyRow.state_json, "writer lease story");
    if (!isStoryState(story)) {
      throw new ControllerDatabaseIntegrityError(
        "writer lease story state is invalid",
      );
    }
    if (
      story.assignedAgentId !== null &&
      story.assignedAgentId !== input.ownerAgentId
    ) {
      throw new StaleWriterLeaseError(
        "story is already assigned to another agent",
      );
    }
    if (story.assignedAgentId === null) {
      this.#database
        .prepare(
          "UPDATE stories SET state_json = ? WHERE run_id = ? AND story_id = ?",
        )
        .run(
          JSON.stringify({ ...story, assignedAgentId: input.ownerAgentId }),
          input.runId,
          input.storyId,
        );
    }
    this.#database
      .prepare(
        `INSERT INTO agents(agent_id, run_id, state_version, status, state_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, agent_id) DO NOTHING`,
      )
      .run(
        agent.id,
        agent.runId,
        agent.schemaVersion,
        agent.status,
        JSON.stringify(agent),
      );
  }

  #assertAgentAssignedToStory(
    runId: string,
    storyId: string,
    ownerAgentId: string,
    allowPendingReady = false,
  ): void {
    const storyRow = this.#database
      .prepare(
        "SELECT state_json FROM stories WHERE run_id = ? AND story_id = ?",
      )
      .get(runId, storyId) as unknown as StateRow | undefined;
    const agentRow = this.#database
      .prepare(
        "SELECT state_json FROM agents WHERE run_id = ? AND agent_id = ?",
      )
      .get(runId, ownerAgentId) as unknown as StateRow | undefined;
    if (storyRow === undefined || agentRow === undefined) {
      throw new StaleWriterLeaseError("assigned story or agent is missing");
    }
    const story = parseJsonObject(storyRow.state_json, "writer lease story");
    const agent = parseJsonObject(agentRow.state_json, "writer lease agent");
    if (!isStoryState(story) || !isAgentState(agent)) {
      throw new ControllerDatabaseIntegrityError(
        "writer lease assignment state is invalid",
      );
    }
    if (
      story.assignedAgentId !== ownerAgentId ||
      agent.taskId !== storyId ||
      story.worktreePath !== agent.worktreePath
    ) {
      throw new StaleWriterLeaseError(
        "agent is not assigned to the story worktree",
      );
    }
    if (
      !allowPendingReady &&
      !["assigned", "working", "changes-requested"].includes(story.status)
    ) {
      throw new StaleWriterLeaseError(
        `story status ${story.status} cannot hold a writer lease`,
      );
    }
    if (["failed", "completed", "closed"].includes(agent.status)) {
      throw new StaleWriterLeaseError(
        `agent status ${agent.status} cannot hold a writer lease`,
      );
    }
  }

  #recordWriterLeaseEvent(
    write: FencedWrite,
    runId: string,
    storyId: string,
    leaseToken: number,
    ownerAgentId: string,
    action: "acquired" | "renewed" | "released" | "revoked",
    reason: string | null,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO writer_lease_events(
           run_id, story_id, lease_token, owner_agent_id, action, reason,
           controller_owner_id, controller_fencing_token, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        storyId,
        leaseToken,
        ownerAgentId,
        action,
        reason,
        write.ownerId,
        write.fencingToken,
        write.now,
      );
  }

  #assertFence(write: FencedWrite): void {
    const ownerId = nonEmpty(write.ownerId, "fenced writer owner id");
    asSafeInteger(write.fencingToken, "fencing token");
    asSafeInteger(write.now, "fenced write timestamp");
    const row = this.#database
      .prepare(
        "SELECT owner_id, fencing_token, expires_at FROM controller_lease WHERE singleton = 1",
      )
      .get() as unknown as LeaseRow | undefined;
    if (row === undefined) {
      throw new ControllerDatabaseIntegrityError(
        "controller lease row is missing",
      );
    }
    if (row.owner_id !== ownerId) {
      throw new StaleControllerFenceError("owner does not hold the lease");
    }
    if (row.fencing_token !== write.fencingToken) {
      throw new StaleControllerFenceError("token is stale");
    }
    if (row.expires_at === null || row.expires_at <= write.now) {
      throw new StaleControllerFenceError("lease has expired");
    }
  }

  #findIdempotentResult(
    runId: string,
    idempotencyKey: string,
    hash: string,
  ): CommitResult | null {
    const row = this.#database
      .prepare(
        `SELECT request_hash, response_json
         FROM processed_commands
         WHERE run_id = ? AND idempotency_key = ?`,
      )
      .get(runId, idempotencyKey) as unknown as CommandRow | undefined;
    if (row === undefined) return null;
    if (row.request_hash !== hash) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return parseCommitResult(row.response_json, true);
  }

  #recordCommand(
    runId: string,
    idempotencyKey: string,
    hash: string,
    revision: number,
    events: readonly ControllerEventInput[],
  ): CommitResult {
    const eventIds = events.map((event) => event.eventId);
    const response = stringifyJson({ revision, eventIds });
    this.#database
      .prepare(
        `INSERT INTO processed_commands(
           run_id, idempotency_key, request_hash, response_json, committed_revision, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        idempotencyKey,
        hash,
        response,
        revision,
        events[0]?.occurredAt ?? 0,
      );
    return Object.freeze({
      revision,
      eventIds: Object.freeze(eventIds),
      replayed: false,
    });
  }

  #appendEvents(
    runId: string,
    revision: number,
    events: readonly ControllerEventInput[],
  ): void {
    const insert = this.#database.prepare(
      `INSERT INTO controller_events(
         event_id, run_id, revision, event_index, event_type, entity_type,
         entity_id, payload_json, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    events.forEach((event, index) => {
      insert.run(
        event.eventId,
        runId,
        revision,
        index,
        event.type,
        event.entityType,
        event.entityId,
        stringifyJson(event.payload),
        event.occurredAt,
      );
    });
  }

  #synchronizeChildren(
    runId: string,
    stories: readonly StoryState[],
    agents: readonly AgentState[],
  ): void {
    this.#synchronizeEntityStates(
      "stories",
      "story_id",
      runId,
      stories,
      this.#database.prepare(
        `INSERT INTO stories(story_id, run_id, state_version, status, state_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, story_id) DO UPDATE SET
           state_version = excluded.state_version,
           status = excluded.status,
           state_json = excluded.state_json`,
      ),
    );
    this.#synchronizeEntityStates(
      "agents",
      "agent_id",
      runId,
      agents,
      this.#database.prepare(
        `INSERT INTO agents(agent_id, run_id, state_version, status, state_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, agent_id) DO UPDATE SET
           state_version = excluded.state_version,
           status = excluded.status,
           state_json = excluded.state_json`,
      ),
    );
  }

  #synchronizeEntityStates(
    table: "stories" | "agents",
    idColumn: "story_id" | "agent_id",
    runId: string,
    states: readonly (StoryState | AgentState)[],
    upsert: StatementSync,
  ): void {
    const existing = this.#database
      .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE run_id = ?`)
      .all(runId) as unknown as readonly { readonly id: string }[];
    const retainedIds = new Set(states.map((state) => state.id));
    const remove = this.#database.prepare(
      `DELETE FROM ${table} WHERE ${idColumn} = ? AND run_id = ?`,
    );
    for (const row of existing) {
      if (!retainedIds.has(row.id)) remove.run(row.id, runId);
    }
    for (const state of states) {
      upsert.run(
        state.id,
        runId,
        state.schemaVersion,
        state.status,
        stringifyJson(state),
      );
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure. A later integrity check will diagnose rollback failure.
      }
      throw error;
    }
  }

  #assertTimeAndTtl(now: number, ttlMs: number): void {
    asSafeInteger(now, "lease timestamp");
    asSafeInteger(ttlMs, "lease ttl");
    if (ttlMs < 1 || now > Number.MAX_SAFE_INTEGER - ttlMs) {
      throw new ControllerRepositoryError(
        "lease ttl must produce a safe future expiration",
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ControllerRepositoryError("Controller repository is closed");
    }
  }

  #protectDatabaseFiles(): void {
    for (const path of [
      this.#databasePath,
      `${this.#databasePath}-wal`,
      `${this.#databasePath}-shm`,
    ]) {
      if (existsSync(path) && statSync(path).isFile()) chmodSync(path, 0o600);
    }
  }
}
