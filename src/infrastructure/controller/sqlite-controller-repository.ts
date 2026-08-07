import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  AcquireWriterLeaseInput,
  AgentLaunchRecord,
  AgentPaneRestorationRecord,
  BindAgentPaneRestorationInput,
  BindControllerLaunchCompositionInput,
  CommitResult,
  CommitSnapshotInput,
  ControllerEventCursor,
  ControllerEventInput,
  ControllerEventRecord,
  ControllerLaunchCompositionRecord,
  ControllerLease,
  ControllerLeaseState,
  ControllerRepository,
  ControllerSnapshot,
  ConfirmAgentLaunchInput,
  FencedWrite,
  HeldWriterLeaseInput,
  InitializeRunInput,
  JsonValue,
  RevokeWriterLeaseInput,
  ReserveAgentPaneRestorationInput,
  ConfirmAgentPaneRestorationInput,
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
import {
  agentCapacity,
  countOccupiedAgentSlots,
} from "../../domain/scheduling.ts";

const DATABASE_SCHEMA_VERSION = 5;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_EVENT_READ_LIMIT = 1_000;
const MAX_EVENTS_PER_COMMIT = 100;

interface RevisionRow {
  readonly revision: number;
}

interface CountRow {
  readonly count: number;
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

interface AgentLaunchRow {
  readonly run_id: string;
  readonly agent_id: string;
  readonly pane_id: string;
  readonly session_id: string;
  readonly process_ids_json: string | null;
  readonly command_sha256: string | null;
  readonly confirmed_at: number | null;
  readonly updated_at: number;
}

interface AgentPaneRestorationRow {
  readonly run_id: string;
  readonly agent_id: string;
  readonly restoration_id: string;
  readonly operation_id: string;
  readonly slot: number;
  readonly prior_pane_id: string;
  readonly replacement_pane_id: string | null;
  readonly session_id: string;
  readonly status: string;
  readonly updated_at: number;
}

interface ControllerLaunchCompositionRow {
  readonly run_id: string;
  readonly composition_json: string;
  readonly authentication_tag: string;
  readonly bound_at: number;
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

export class AgentCapacityExceededError extends ControllerRepositoryError {
  readonly runId: string;
  readonly limit: number;
  readonly occupied: number;

  constructor(runId: string, limit: number, occupied: number) {
    super(
      `Run ${runId} has exhausted its global active-agent limit (${String(occupied)}/${String(limit)})`,
    );
    this.name = "AgentCapacityExceededError";
    this.runId = runId;
    this.limit = limit;
    this.occupied = occupied;
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

  const capacity = agentCapacity(
    run.complexity,
    countOccupiedAgentSlots(agents),
  );
  if (capacity.occupied > capacity.limit) {
    throw new InvalidControllerSnapshotError(
      `run ${run.id} exceeds its global active-agent limit (${String(capacity.occupied)}/${String(capacity.limit)})`,
    );
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

function parseAgentLaunch(row: AgentLaunchRow): AgentLaunchRecord {
  const updatedAt = asSafeInteger(row.updated_at, "agent launch timestamp");
  const confirmed = row.confirmed_at !== null;
  if (row.confirmed_at !== null) {
    asSafeInteger(row.confirmed_at, "agent launch confirmation timestamp");
  }
  if (
    confirmed !== (row.process_ids_json !== null) ||
    confirmed !== (row.command_sha256 !== null)
  ) {
    throw new ControllerDatabaseIntegrityError(
      "agent launch confirmation evidence is incomplete",
    );
  }
  let processIds: readonly number[] = [];
  if (row.process_ids_json !== null) {
    const parsed: unknown = JSON.parse(row.process_ids_json);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new ControllerDatabaseIntegrityError(
        "agent launch process evidence is invalid",
      );
    }
    const validated: number[] = [];
    for (const pid of parsed as readonly unknown[]) {
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) {
        throw new ControllerDatabaseIntegrityError(
          "agent launch process evidence is invalid",
        );
      }
      validated.push(pid);
    }
    if (new Set(validated).size !== validated.length) {
      throw new ControllerDatabaseIntegrityError(
        "agent launch process evidence is invalid",
      );
    }
    processIds = Object.freeze(validated);
  }
  if (
    row.command_sha256 !== null &&
    !/^[a-f0-9]{64}$/u.test(row.command_sha256)
  ) {
    throw new ControllerDatabaseIntegrityError(
      "agent launch command digest is invalid",
    );
  }
  return Object.freeze({
    runId: row.run_id,
    agentId: row.agent_id,
    paneId: nonEmpty(row.pane_id, "agent launch pane id"),
    sessionId: nonEmpty(row.session_id, "agent launch session id"),
    status: confirmed ? "confirmed" : "materialized",
    processIds,
    commandSha256: row.command_sha256,
    updatedAt,
  });
}

function parseAgentPaneRestoration(
  row: AgentPaneRestorationRow,
): AgentPaneRestorationRecord {
  const slot = asSafeInteger(row.slot, "agent pane restoration slot");
  const updatedAt = asSafeInteger(
    row.updated_at,
    "agent pane restoration timestamp",
  );
  if (slot < 0) {
    throw new ControllerDatabaseIntegrityError(
      "agent pane restoration slot cannot be negative",
    );
  }
  if (
    row.status !== "reserved" &&
    row.status !== "bound" &&
    row.status !== "confirmed"
  ) {
    throw new ControllerDatabaseIntegrityError(
      "agent pane restoration status is invalid",
    );
  }
  if ((row.status === "reserved") !== (row.replacement_pane_id === null)) {
    throw new ControllerDatabaseIntegrityError(
      "agent pane restoration binding evidence is inconsistent",
    );
  }
  return Object.freeze({
    runId: row.run_id,
    agentId: row.agent_id,
    restorationId: nonEmpty(row.restoration_id, "agent pane restoration id"),
    operationId: nonEmpty(row.operation_id, "agent pane operation id"),
    slot,
    priorPaneId: nonEmpty(row.prior_pane_id, "prior agent pane id"),
    replacementPaneId:
      row.replacement_pane_id === null
        ? null
        : nonEmpty(row.replacement_pane_id, "replacement agent pane id"),
    sessionId: nonEmpty(row.session_id, "agent pane restoration session id"),
    status: row.status,
    updatedAt,
  });
}

function parseControllerLaunchComposition(
  row: ControllerLaunchCompositionRow,
): ControllerLaunchCompositionRecord {
  const composition = parseJsonObject(
    row.composition_json,
    "controller launch composition",
  );
  if (composition.runId !== row.run_id) {
    throw new ControllerDatabaseIntegrityError(
      "controller launch composition belongs to a different run",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(row.authentication_tag)) {
    throw new ControllerDatabaseIntegrityError(
      "controller launch composition authentication tag is invalid",
    );
  }
  if (Buffer.byteLength(row.composition_json, "utf8") > 32 * 1024) {
    throw new ControllerDatabaseIntegrityError(
      "controller launch composition exceeds its size limit",
    );
  }
  return Object.freeze({
    runId: row.run_id,
    compositionJson: row.composition_json,
    authenticationTag: row.authentication_tag,
    boundAt: asSafeInteger(
      row.bound_at,
      "controller launch composition timestamp",
    ),
  });
}

function sameAgentIdentity(left: AgentState, right: AgentState): boolean {
  return (
    left.id === right.id &&
    left.runId === right.runId &&
    left.roleRuntimeId === right.roleRuntimeId &&
    left.taskId === right.taskId &&
    left.worktreePath === right.worktreePath
  );
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
    readonly sessionId: string;
  }): AgentState {
    this.#assertOpen();
    const paneId = nonEmpty(input.paneId, "agent launch pane id");
    const sessionId = nonEmpty(input.sessionId, "agent launch session id");
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new ControllerRepositoryError(
        "agent launch session id must be an exact UUID",
      );
    }
    const launched = this.#transaction(() => {
      this.#assertFence(input.write);
      const existing = this.#database
        .prepare(
          "SELECT state_json FROM agents WHERE run_id = ? AND agent_id = ?",
        )
        .get(input.agent.runId, input.agent.id) as unknown as
        StateRow | undefined;
      let current: AgentState = input.agent;
      if (existing !== undefined) {
        const persisted = parseJsonObject(
          existing.state_json,
          "agent launch state",
        );
        if (!isAgentState(persisted)) {
          throw new ControllerDatabaseIntegrityError(
            "agent launch state is invalid",
          );
        }
        current = persisted;
      } else {
        this.#assertAgentSlotAvailable(input.agent.runId);
      }
      if (!sameAgentIdentity(current, input.agent)) {
        throw new StaleWriterLeaseError(
          `agent ${input.agent.id} has different controller identity`,
        );
      }
      if (current.status !== "planned" && current.status !== "launching") {
        throw new StaleWriterLeaseError(
          `agent ${input.agent.id} is already ${current.status}`,
        );
      }
      if (current.status === "launching" && current.paneId !== paneId) {
        throw new StaleWriterLeaseError(
          `agent ${input.agent.id} is launching in a different pane`,
        );
      }
      const next =
        current.status === "launching"
          ? current
          : transitionAgent(current, {
              type: "launch-requested",
              paneId,
              at: Math.max(input.write.now, current.updatedAt),
            });
      const reservation = this.#agentLaunchRow(next.runId, next.id);
      if (
        reservation !== null &&
        (reservation.pane_id !== paneId || reservation.session_id !== sessionId)
      ) {
        throw new StaleWriterLeaseError(
          `agent ${next.id} has different pane or session launch evidence`,
        );
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
          next.id,
          next.runId,
          next.schemaVersion,
          next.status,
          JSON.stringify(next),
        );
      if (reservation === null) {
        this.#database
          .prepare(
            `INSERT INTO agent_launches(
               run_id, agent_id, pane_id, session_id, process_ids_json,
               command_sha256, confirmed_at, updated_at
             ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
          )
          .run(next.runId, next.id, paneId, sessionId, input.write.now);
      }
      return next;
    });
    this.#protectDatabaseFiles();
    return launched;
  }

  confirmAgentLaunch(input: ConfirmAgentLaunchInput): AgentLaunchRecord {
    this.#assertOpen();
    const runId = nonEmpty(input.runId, "agent launch run id");
    const agentId = nonEmpty(input.agentId, "agent launch agent id");
    const paneId = nonEmpty(input.paneId, "agent launch pane id");
    const sessionId = nonEmpty(input.sessionId, "agent launch session id");
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new ControllerRepositoryError(
        "agent launch session id must be an exact UUID",
      );
    }
    const commandSha256 = nonEmpty(
      input.commandSha256,
      "agent launch command digest",
    );
    if (!/^[a-f0-9]{64}$/u.test(commandSha256)) {
      throw new ControllerRepositoryError(
        "agent launch command digest must be lowercase SHA-256",
      );
    }
    const processIds = [...input.processIds].sort(
      (left, right) => left - right,
    );
    if (
      processIds.length === 0 ||
      processIds.some((pid) => !Number.isSafeInteger(pid) || pid < 1) ||
      new Set(processIds).size !== processIds.length
    ) {
      throw new ControllerRepositoryError(
        "agent launch process ids must be unique positive integers",
      );
    }
    const confirmed = this.#transaction(() => {
      this.#assertFence(input.write);
      const row = this.#agentLaunchRow(runId, agentId);
      if (row === null) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} has no materialized launch`,
        );
      }
      const current = parseAgentLaunch(row);
      if (current.paneId !== paneId || current.sessionId !== sessionId) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} launch evidence has a different pane or session`,
        );
      }
      if (current.status === "confirmed") {
        if (
          current.commandSha256 !== commandSha256 ||
          JSON.stringify(current.processIds) !== JSON.stringify(processIds)
        ) {
          throw new StaleWriterLeaseError(
            `agent ${agentId} has conflicting process launch evidence`,
          );
        }
        return current;
      }
      this.#database
        .prepare(
          `UPDATE agent_launches
           SET process_ids_json = ?, command_sha256 = ?, confirmed_at = ?, updated_at = ?
           WHERE run_id = ? AND agent_id = ?`,
        )
        .run(
          JSON.stringify(processIds),
          commandSha256,
          input.write.now,
          input.write.now,
          runId,
          agentId,
        );
      const updated = this.#agentLaunchRow(runId, agentId);
      if (updated === null) {
        throw new ControllerDatabaseIntegrityError(
          "confirmed agent launch disappeared",
        );
      }
      return parseAgentLaunch(updated);
    });
    this.#protectDatabaseFiles();
    return confirmed;
  }

  readAgentLaunch(runId: string, agentId: string): AgentLaunchRecord | null {
    this.#assertOpen();
    const row = this.#agentLaunchRow(
      nonEmpty(runId, "agent launch run id"),
      nonEmpty(agentId, "agent launch agent id"),
    );
    return row === null ? null : parseAgentLaunch(row);
  }

  reserveAgentPaneRestoration(
    input: ReserveAgentPaneRestorationInput,
  ): AgentPaneRestorationRecord {
    this.#assertOpen();
    const runId = nonEmpty(input.runId, "agent pane restoration run id");
    const agentId = nonEmpty(input.agentId, "agent pane restoration agent id");
    const restorationId = nonEmpty(
      input.restorationId,
      "agent pane restoration id",
    );
    const operationId = nonEmpty(
      input.operationId,
      "agent pane restoration operation id",
    );
    const priorPaneId = nonEmpty(input.priorPaneId, "prior agent pane id");
    const sessionId = nonEmpty(input.sessionId, "agent pane session id");
    if (!Number.isSafeInteger(input.slot) || input.slot < 0) {
      throw new ControllerRepositoryError(
        "agent pane restoration slot must be a non-negative safe integer",
      );
    }
    const reserved = this.#transaction(() => {
      this.#assertFence(input.write);
      const existing = this.#agentPaneRestorationRow(runId, agentId);
      if (existing !== null) {
        const current = parseAgentPaneRestoration(existing);
        if (
          current.operationId !== operationId ||
          current.slot !== input.slot ||
          current.priorPaneId !== priorPaneId ||
          current.sessionId !== sessionId
        ) {
          throw new StaleWriterLeaseError(
            `agent ${agentId} has conflicting pane restoration authority`,
          );
        }
        return current;
      }
      const agentRow = this.#database
        .prepare(
          "SELECT state_json FROM agents WHERE run_id = ? AND agent_id = ?",
        )
        .get(runId, agentId) as unknown as StateRow | undefined;
      if (agentRow === undefined) {
        throw new StaleWriterLeaseError(`agent ${agentId} is not registered`);
      }
      const agentValue = parseJsonObject(
        agentRow.state_json,
        "agent pane restoration state",
      );
      if (!isAgentState(agentValue)) {
        throw new ControllerDatabaseIntegrityError(
          "agent pane restoration state is invalid",
        );
      }
      if (
        (agentValue.paneId !== priorPaneId &&
          !(
            agentValue.status === "disconnected" && agentValue.paneId === null
          )) ||
        ["completed", "failed", "closed"].includes(agentValue.status)
      ) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} is not active in the controller-recorded pane`,
        );
      }
      const launchRow = this.#agentLaunchRow(runId, agentId);
      if (launchRow === null) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} has no launch authority to restore`,
        );
      }
      const launch = parseAgentLaunch(launchRow);
      if (
        launch.status !== "confirmed" ||
        launch.paneId !== priorPaneId ||
        launch.sessionId !== sessionId
      ) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} lacks exact confirmed pane and session evidence`,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO agent_pane_restorations(
             run_id, agent_id, restoration_id, operation_id, slot,
             prior_pane_id, replacement_pane_id, session_id, status, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'reserved', ?)`,
        )
        .run(
          runId,
          agentId,
          restorationId,
          operationId,
          input.slot,
          priorPaneId,
          sessionId,
          input.write.now,
        );
      const row = this.#agentPaneRestorationRow(runId, agentId);
      if (row === null) {
        throw new ControllerDatabaseIntegrityError(
          "agent pane restoration reservation disappeared",
        );
      }
      return parseAgentPaneRestoration(row);
    });
    this.#protectDatabaseFiles();
    return reserved;
  }

  bindAgentPaneRestoration(
    input: BindAgentPaneRestorationInput,
  ): AgentPaneRestorationRecord {
    this.#assertOpen();
    const runId = nonEmpty(input.runId, "agent pane restoration run id");
    const agentId = nonEmpty(input.agentId, "agent pane restoration agent id");
    const replacementPaneId = nonEmpty(
      input.replacementPaneId,
      "replacement agent pane id",
    );
    const bound = this.#transaction(() => {
      this.#assertFence(input.write);
      const row = this.#agentPaneRestorationRow(runId, agentId);
      if (row === null) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} has no pane restoration reservation`,
        );
      }
      const restoration = parseAgentPaneRestoration(row);
      if (restoration.restorationId !== input.restorationId) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} pane restoration identity changed`,
        );
      }
      if (restoration.replacementPaneId !== null) {
        if (restoration.replacementPaneId !== replacementPaneId) {
          throw new StaleWriterLeaseError(
            `agent ${agentId} is bound to a different replacement pane`,
          );
        }
        return restoration;
      }
      if (replacementPaneId === restoration.priorPaneId) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} replacement pane did not change`,
        );
      }
      const agentRow = this.#database
        .prepare(
          "SELECT state_json FROM agents WHERE run_id = ? AND agent_id = ?",
        )
        .get(runId, agentId) as unknown as StateRow | undefined;
      if (agentRow === undefined) {
        throw new ControllerDatabaseIntegrityError(
          "agent pane restoration lost its agent state",
        );
      }
      const agentValue = parseJsonObject(
        agentRow.state_json,
        "agent pane restoration state",
      );
      if (!isAgentState(agentValue)) {
        throw new ControllerDatabaseIntegrityError(
          "agent pane restoration state is invalid",
        );
      }
      if (
        agentValue.paneId !== restoration.priorPaneId &&
        !(agentValue.status === "disconnected" && agentValue.paneId === null)
      ) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} controller pane changed before restoration binding`,
        );
      }
      const launchRow = this.#agentLaunchRow(runId, agentId);
      if (launchRow === null) {
        throw new ControllerDatabaseIntegrityError(
          "agent pane restoration lost its launch record",
        );
      }
      const launch = parseAgentLaunch(launchRow);
      if (
        launch.status !== "confirmed" ||
        launch.paneId !== restoration.priorPaneId ||
        launch.sessionId !== restoration.sessionId
      ) {
        throw new StaleWriterLeaseError(
          `agent ${agentId} launch authority changed before restoration binding`,
        );
      }
      const disconnected =
        agentValue.status === "disconnected"
          ? agentValue
          : transitionAgent(agentValue, {
              type: "pane-lost",
              at: Math.max(input.write.now, agentValue.updatedAt),
            });
      const recovering = transitionAgent(disconnected, {
        type: "recovery-requested",
        paneId: replacementPaneId,
        at: Math.max(input.write.now, disconnected.updatedAt),
      });
      this.#database
        .prepare(
          `UPDATE agents
           SET state_version = ?, status = ?, state_json = ?
           WHERE run_id = ? AND agent_id = ?`,
        )
        .run(
          recovering.schemaVersion,
          recovering.status,
          JSON.stringify(recovering),
          runId,
          agentId,
        );
      this.#database
        .prepare(
          `UPDATE agent_launches
           SET pane_id = ?, process_ids_json = NULL, command_sha256 = NULL,
               confirmed_at = NULL, updated_at = ?
           WHERE run_id = ? AND agent_id = ? AND pane_id = ? AND session_id = ?`,
        )
        .run(
          replacementPaneId,
          input.write.now,
          runId,
          agentId,
          restoration.priorPaneId,
          restoration.sessionId,
        );
      this.#database
        .prepare(
          `UPDATE agent_pane_restorations
           SET replacement_pane_id = ?, status = 'bound', updated_at = ?
           WHERE run_id = ? AND agent_id = ? AND restoration_id = ?`,
        )
        .run(
          replacementPaneId,
          input.write.now,
          runId,
          agentId,
          input.restorationId,
        );
      const updated = this.#agentPaneRestorationRow(runId, agentId);
      if (updated === null) {
        throw new ControllerDatabaseIntegrityError(
          "bound agent pane restoration disappeared",
        );
      }
      return parseAgentPaneRestoration(updated);
    });
    this.#protectDatabaseFiles();
    return bound;
  }

  confirmAgentPaneRestoration(
    input: ConfirmAgentPaneRestorationInput,
  ): AgentPaneRestorationRecord {
    this.#assertOpen();
    const confirmed = this.#transaction(() => {
      this.#assertFence(input.write);
      const row = this.#agentPaneRestorationRow(input.runId, input.agentId);
      if (row === null) {
        throw new StaleWriterLeaseError(
          `agent ${input.agentId} has no pane restoration to confirm`,
        );
      }
      const restoration = parseAgentPaneRestoration(row);
      if (
        restoration.restorationId !== input.restorationId ||
        restoration.replacementPaneId !== input.replacementPaneId ||
        restoration.sessionId !== input.sessionId
      ) {
        throw new StaleWriterLeaseError(
          `agent ${input.agentId} pane restoration confirmation conflicts`,
        );
      }
      if (restoration.status === "confirmed") return restoration;
      const launchRow = this.#agentLaunchRow(input.runId, input.agentId);
      if (launchRow === null) {
        throw new ControllerDatabaseIntegrityError(
          "agent pane restoration launch evidence disappeared",
        );
      }
      const launch = parseAgentLaunch(launchRow);
      if (
        launch.status !== "confirmed" ||
        launch.paneId !== input.replacementPaneId ||
        launch.sessionId !== input.sessionId
      ) {
        throw new StaleWriterLeaseError(
          `agent ${input.agentId} replacement Pi process is not confirmed`,
        );
      }
      this.#database
        .prepare(
          `UPDATE agent_pane_restorations
           SET status = 'confirmed', updated_at = ?
           WHERE run_id = ? AND agent_id = ? AND restoration_id = ?`,
        )
        .run(input.write.now, input.runId, input.agentId, input.restorationId);
      const updated = this.#agentPaneRestorationRow(input.runId, input.agentId);
      if (updated === null) {
        throw new ControllerDatabaseIntegrityError(
          "confirmed agent pane restoration disappeared",
        );
      }
      return parseAgentPaneRestoration(updated);
    });
    this.#protectDatabaseFiles();
    return confirmed;
  }

  readAgentPaneRestoration(
    runId: string,
    agentId: string,
  ): AgentPaneRestorationRecord | null {
    this.#assertOpen();
    const row = this.#agentPaneRestorationRow(
      nonEmpty(runId, "agent pane restoration run id"),
      nonEmpty(agentId, "agent pane restoration agent id"),
    );
    return row === null ? null : parseAgentPaneRestoration(row);
  }

  bindControllerLaunchComposition(
    input: BindControllerLaunchCompositionInput,
  ): ControllerLaunchCompositionRecord {
    this.#assertOpen();
    const runId = nonEmpty(input.runId, "controller launch composition run id");
    if (Buffer.byteLength(input.compositionJson, "utf8") > 32 * 1024) {
      throw new ControllerRepositoryError(
        "controller launch composition exceeds its size limit",
      );
    }
    parseJsonObject(input.compositionJson, "controller launch composition");
    if (!/^[0-9a-f]{64}$/u.test(input.authenticationTag)) {
      throw new ControllerRepositoryError(
        "controller launch composition authentication tag is invalid",
      );
    }
    const record = this.#transaction(() => {
      this.#assertFence(input.write);
      const existing = this.#controllerLaunchCompositionRow(runId);
      if (existing !== null) {
        if (
          existing.composition_json !== input.compositionJson ||
          existing.authentication_tag !== input.authenticationTag
        ) {
          throw new ControllerRepositoryError(
            "controller launch composition is immutable and already differs",
          );
        }
        return parseControllerLaunchComposition(existing);
      }
      const run = this.#database
        .prepare("SELECT run_id FROM runs WHERE run_id = ?")
        .get(runId) as unknown as { readonly run_id: string } | undefined;
      if (run === undefined) {
        throw new ControllerRepositoryError(
          `controller launch composition references missing run ${runId}`,
        );
      }
      this.#database
        .prepare(
          `INSERT INTO controller_launch_compositions(
             run_id, composition_json, authentication_tag, bound_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          runId,
          input.compositionJson,
          input.authenticationTag,
          input.write.now,
        );
      const inserted = this.#controllerLaunchCompositionRow(runId);
      if (inserted === null) {
        throw new ControllerDatabaseIntegrityError(
          "controller launch composition disappeared after binding",
        );
      }
      return parseControllerLaunchComposition(inserted);
    });
    this.#protectDatabaseFiles();
    return record;
  }

  readControllerLaunchComposition(
    runId: string,
  ): ControllerLaunchCompositionRecord | null {
    this.#assertOpen();
    const row = this.#controllerLaunchCompositionRow(
      nonEmpty(runId, "controller launch composition run id"),
    );
    return row === null ? null : parseControllerLaunchComposition(row);
  }

  readControllerLease(): ControllerLeaseState {
    this.#assertOpen();
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
    const fencingToken = asSafeInteger(
      row.fencing_token,
      "controller fencing token",
    );
    if (fencingToken < 0) {
      throw new ControllerDatabaseIntegrityError(
        "controller fencing token cannot be negative",
      );
    }
    const expiresAt =
      row.expires_at === null
        ? null
        : asSafeInteger(row.expires_at, "controller lease expiration");
    if ((row.owner_id === null) !== (expiresAt === null)) {
      throw new ControllerDatabaseIntegrityError(
        "controller lease owner and expiration are inconsistent",
      );
    }
    const ownerId = row.owner_id?.trim() ?? null;
    if (row.owner_id !== null && ownerId?.length === 0) {
      throw new ControllerDatabaseIntegrityError(
        "controller lease owner is empty",
      );
    }
    return Object.freeze({
      ownerId,
      fencingToken,
      expiresAt,
    });
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
    this.readControllerLease();
    const leaseRows = this.#database
      .prepare(
        `SELECT run_id, story_id, owner_agent_id, lease_token, expires_at, updated_at
         FROM writer_leases`,
      )
      .all() as unknown as readonly WriterLeaseRow[];
    for (const row of leaseRows) parseWriterLease(row);
    const launchRows = this.#database
      .prepare(
        `SELECT run_id, agent_id, pane_id, session_id, process_ids_json,
                command_sha256, confirmed_at, updated_at
         FROM agent_launches`,
      )
      .all() as unknown as readonly AgentLaunchRow[];
    for (const row of launchRows) parseAgentLaunch(row);
    const compositionRows = this.#database
      .prepare(
        `SELECT run_id, composition_json, authentication_tag, bound_at
         FROM controller_launch_compositions`,
      )
      .all() as unknown as readonly ControllerLaunchCompositionRow[];
    for (const row of compositionRows) parseControllerLaunchComposition(row);
    const restorationRows = this.#database
      .prepare(
        `SELECT run_id, agent_id, restoration_id, operation_id, slot,
                prior_pane_id, replacement_pane_id, session_id, status, updated_at
         FROM agent_pane_restorations`,
      )
      .all() as unknown as readonly AgentPaneRestorationRow[];
    for (const row of restorationRows) {
      const restoration = parseAgentPaneRestoration(row);
      const launchRow = launchRows.find(
        (launch) =>
          launch.run_id === restoration.runId &&
          launch.agent_id === restoration.agentId,
      );
      if (launchRow === undefined) {
        throw new ControllerDatabaseIntegrityError(
          "agent pane restoration references missing launch evidence",
        );
      }
      const launch = parseAgentLaunch(launchRow);
      const expectedPaneId =
        restoration.replacementPaneId ?? restoration.priorPaneId;
      if (
        launch.paneId !== expectedPaneId ||
        launch.sessionId !== restoration.sessionId ||
        (restoration.status === "reserved" && launch.status !== "confirmed") ||
        (restoration.status === "confirmed" && launch.status !== "confirmed")
      ) {
        throw new ControllerDatabaseIntegrityError(
          "agent pane restoration conflicts with launch evidence",
        );
      }
    }
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

          PRAGMA user_version = 3;
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
      if (version < 3) {
        this.#database.exec(`
          CREATE TABLE agent_launches (
            run_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            pane_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            process_ids_json TEXT CHECK (
              process_ids_json IS NULL OR json_valid(process_ids_json)
            ),
            command_sha256 TEXT,
            confirmed_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, agent_id),
            FOREIGN KEY (run_id, agent_id)
              REFERENCES agents(run_id, agent_id) ON DELETE CASCADE,
            CHECK (
              (process_ids_json IS NULL AND command_sha256 IS NULL AND confirmed_at IS NULL) OR
              (process_ids_json IS NOT NULL AND command_sha256 IS NOT NULL AND confirmed_at IS NOT NULL)
            )
          ) STRICT;
          CREATE UNIQUE INDEX agent_launches_by_pane
            ON agent_launches(run_id, pane_id);
          CREATE UNIQUE INDEX agent_launches_by_session
            ON agent_launches(run_id, session_id);

          PRAGMA user_version = 3;
        `);
      }
      if (version < 4) {
        this.#database.exec(`
          CREATE TABLE agent_pane_restorations (
            run_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            restoration_id TEXT NOT NULL UNIQUE,
            operation_id TEXT NOT NULL,
            slot INTEGER NOT NULL CHECK (slot >= 0),
            prior_pane_id TEXT NOT NULL,
            replacement_pane_id TEXT,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('reserved', 'bound', 'confirmed')),
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, agent_id),
            FOREIGN KEY (run_id, agent_id)
              REFERENCES agent_launches(run_id, agent_id) ON DELETE CASCADE,
            CHECK (
              (status = 'reserved' AND replacement_pane_id IS NULL) OR
              (status IN ('bound', 'confirmed') AND replacement_pane_id IS NOT NULL)
            )
          ) STRICT;
          CREATE UNIQUE INDEX agent_pane_restorations_by_slot
            ON agent_pane_restorations(run_id, operation_id, slot);
          CREATE UNIQUE INDEX agent_pane_restorations_by_replacement
            ON agent_pane_restorations(run_id, replacement_pane_id)
            WHERE replacement_pane_id IS NOT NULL;

          PRAGMA user_version = 4;
        `);
      }
      if (version < 5) {
        this.#database.exec(`
          CREATE TABLE controller_launch_compositions (
            run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
            composition_json TEXT NOT NULL CHECK (json_valid(composition_json)),
            authentication_tag TEXT NOT NULL,
            bound_at INTEGER NOT NULL CHECK (bound_at >= 0)
          ) STRICT;

          PRAGMA user_version = 5;
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

  #agentLaunchRow(runId: string, agentId: string): AgentLaunchRow | null {
    const row = this.#database
      .prepare(
        `SELECT run_id, agent_id, pane_id, session_id, process_ids_json,
                command_sha256, confirmed_at, updated_at
         FROM agent_launches
         WHERE run_id = ? AND agent_id = ?`,
      )
      .get(runId, agentId) as unknown as AgentLaunchRow | undefined;
    return row ?? null;
  }

  #agentPaneRestorationRow(
    runId: string,
    agentId: string,
  ): AgentPaneRestorationRow | null {
    const row = this.#database
      .prepare(
        `SELECT run_id, agent_id, restoration_id, operation_id, slot,
                prior_pane_id, replacement_pane_id, session_id, status, updated_at
         FROM agent_pane_restorations
         WHERE run_id = ? AND agent_id = ?`,
      )
      .get(runId, agentId) as unknown as AgentPaneRestorationRow | undefined;
    return row ?? null;
  }

  #controllerLaunchCompositionRow(
    runId: string,
  ): ControllerLaunchCompositionRow | null {
    const row = this.#database
      .prepare(
        `SELECT run_id, composition_json, authentication_tag, bound_at
         FROM controller_launch_compositions
         WHERE run_id = ?`,
      )
      .get(runId) as unknown as ControllerLaunchCompositionRow | undefined;
    return row ?? null;
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
    const existingAgent = this.#database
      .prepare(
        "SELECT 1 AS count FROM agents WHERE run_id = ? AND agent_id = ?",
      )
      .get(agent.runId, agent.id) as unknown as CountRow | undefined;
    if (existingAgent === undefined) {
      this.#assertAgentSlotAvailable(agent.runId);
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

  #assertAgentSlotAvailable(runId: string): void {
    const runRow = this.#database
      .prepare("SELECT state_json FROM runs WHERE run_id = ?")
      .get(runId) as unknown as StateRow | undefined;
    if (runRow === undefined) {
      throw new ControllerRepositoryError(`Run ${runId} does not exist`);
    }
    const run = parseJsonObject(runRow.state_json, "agent capacity run state");
    if (!isRunState(run)) {
      throw new ControllerDatabaseIntegrityError(
        "agent capacity run state is invalid",
      );
    }
    const countRow = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM agents
         WHERE run_id = ? AND status <> 'closed'`,
      )
      .get(runId) as unknown as CountRow;
    const occupied = asSafeInteger(
      countRow.count,
      "occupied agent capacity count",
    );
    const capacity = agentCapacity(run.complexity, occupied);
    if (capacity.available === 0) {
      throw new AgentCapacityExceededError(runId, capacity.limit, occupied);
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
