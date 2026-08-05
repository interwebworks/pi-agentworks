import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  CommitResult,
  CommitSnapshotInput,
  ControllerEventCursor,
  ControllerEventInput,
  ControllerEventRecord,
  ControllerLease,
  ControllerRepository,
  ControllerSnapshot,
  FencedWrite,
  InitializeRunInput,
  JsonValue,
} from "../../application/ports/controller-repository.ts";
import {
  isAgentState,
  isRunState,
  isStoryState,
  type AgentState,
  type RunState,
  type StoryState,
} from "../../domain/controller-state.ts";

const DATABASE_SCHEMA_VERSION = 1;
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

          PRAGMA user_version = 1;
        `);
      }
    });
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
