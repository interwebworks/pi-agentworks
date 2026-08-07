import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createAgentState,
  createRunState,
  createStoryState,
  transitionAgent,
  transitionRun,
  transitionStory,
  type AgentState,
  type RunState,
  type StoryState,
} from "../src/domain/controller-state.ts";
import {
  AgentCapacityExceededError,
  ControllerDatabaseIntegrityError,
  ControllerLeaseHeldError,
  IdempotencyConflictError,
  InvalidControllerSnapshotError,
  SqliteControllerRepository,
  StaleControllerFenceError,
  StaleRunRevisionError,
  StaleWriterLeaseError,
  WriterLeaseHeldError,
} from "../src/infrastructure/controller/sqlite-controller-repository.ts";

function createFixture(): {
  readonly directory: string;
  readonly databasePath: string;
  readonly repository: SqliteControllerRepository;
} {
  const directory = mkdtempSync(join(tmpdir(), "agentworks-controller-"));
  const databasePath = join(directory, "runtime", "controller.sqlite");
  return {
    directory,
    databasePath,
    repository: new SqliteControllerRepository(databasePath),
  };
}

function run(): RunState {
  return createRunState({
    id: "run-1",
    title: "Persist controller state",
    complexity: "NORMAL",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktrees/run-1/integration",
    createdAt: 1_000,
  });
}

function story(): StoryState {
  return createStoryState({
    id: "story-1",
    runId: "run-1",
    title: "Create durable state",
    branchName: "agentworks/run-1/story-1",
    worktreePath: "/worktrees/run-1/story-1",
    createdAt: 1_000,
  });
}

function agent(id = "agent-1", taskId = "task-1"): AgentState {
  return createAgentState({
    id,
    runId: "run-1",
    roleRuntimeId: "software-development/backend-developer",
    taskId,
    worktreePath: "/worktrees/run-1/story-1",
    createdAt: 1_000,
  });
}

function assignedStory(agentId = "agent-1"): StoryState {
  const awaitingApproval = transitionStory(story(), {
    type: "story-prepared",
    at: 1_001,
    complexity: "NORMAL",
  });
  const ready = transitionStory(awaitingApproval, {
    type: "story-plan-approved",
    at: 1_002,
  });
  return transitionStory(ready, {
    type: "story-assigned",
    at: 1_003,
    agentId,
  });
}

function initialize(
  repository: SqliteControllerRepository,
  fencingToken: number,
  state: {
    readonly run?: RunState;
    readonly stories?: readonly StoryState[];
    readonly agents?: readonly AgentState[];
  } = {},
) {
  return repository.initializeRun({
    write: { ownerId: "controller-a", fencingToken, now: 1_100 },
    idempotencyKey: "create-run-1",
    request: { command: "create-run", options: { b: 2, a: 1 } },
    run: state.run ?? run(),
    stories: state.stories ?? [story()],
    agents: state.agents ?? [agent()],
    events: [
      {
        eventId: "event-run-created",
        type: "run-created",
        entityType: "run",
        entityId: "run-1",
        payload: { status: "planning" },
        occurredAt: 1_100,
      },
    ],
  });
}

test("repository enables WAL, migrates once, and protects runtime files", () => {
  const fixture = createFixture();
  try {
    fixture.repository.close();
    const database = new DatabaseSync(fixture.databasePath);
    const journal = database
      .prepare("PRAGMA journal_mode")
      .get() as unknown as {
      readonly journal_mode: string;
    };
    const version = database
      .prepare("PRAGMA user_version")
      .get() as unknown as {
      readonly user_version: number;
    };
    database.close();

    assert.equal(journal.journal_mode, "wal");
    assert.equal(version.user_version, 5);
    assert.equal(
      statSync(join(fixture.directory, "runtime")).mode & 0o777,
      0o700,
    );
    assert.equal(statSync(fixture.databasePath).mode & 0o777, 0o600);

    const reopened = new SqliteControllerRepository(fixture.databasePath);
    reopened.assertIntegrity();
    reopened.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("snapshot initialization rejects active agents beyond the complexity limit", () => {
  const fixture = createFixture();
  try {
    const controller = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    const agents = Array.from({ length: 5 }, (_unused, index) =>
      agent(`agent-${String(index + 1)}`),
    );
    assert.throws(
      () =>
        initialize(fixture.repository, controller.fencingToken, {
          run: { ...run(), complexity: "LOW" },
          agents,
        }),
      InvalidControllerSnapshotError,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("agent launch capacity is atomic across reloads and releases only after verified close", () => {
  const fixture = createFixture();
  let reloaded: SqliteControllerRepository | null = null;
  try {
    const controller = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    const reserved = [
      agent("agent-1"),
      agent("agent-2"),
      agent("agent-3"),
      { ...agent("agent-4"), status: "disconnected" as const },
    ];
    initialize(fixture.repository, controller.fencingToken, {
      run: { ...run(), complexity: "LOW" },
      agents: reserved,
    });
    reloaded = new SqliteControllerRepository(fixture.databasePath);

    // Transitioning an existing planned reservation is valid at the exact
    // boundary; it does not consume a second slot.
    assert.equal(
      fixture.repository.materializeAgentLaunch({
        write: {
          ownerId: "controller-a",
          fencingToken: controller.fencingToken,
          now: 1_200,
        },
        agent: reserved[0] ?? agent("missing"),
        paneId: "pane-1",
        sessionId: "11111111-1111-4111-8111-111111111111",
      }).status,
      "launching",
    );

    // A separately loaded repository must observe the same transactional
    // boundary rather than trusting a stale orchestration snapshot.
    assert.throws(
      () =>
        reloaded?.materializeAgentLaunch({
          write: {
            ownerId: "controller-a",
            fencingToken: controller.fencingToken,
            now: 1_201,
          },
          agent: agent("agent-5"),
          paneId: "pane-5",
          sessionId: "55555555-5555-4555-8555-555555555555",
        }),
      AgentCapacityExceededError,
    );

    // Disconnected is recoverable and held capacity above. Completed also
    // remains reserved until a verified close records cleanup completion.
    const snapshot = fixture.repository.loadSnapshot("run-1");
    assert.ok(snapshot);
    fixture.repository.commitSnapshot({
      write: {
        ownerId: "controller-a",
        fencingToken: controller.fencingToken,
        now: 1_300,
      },
      runId: "run-1",
      expectedRevision: snapshot.revision,
      idempotencyKey: "complete-agent-4",
      request: { command: "complete-agent", agentId: "agent-4" },
      run: snapshot.run,
      stories: snapshot.stories,
      agents: snapshot.agents.map((current) =>
        current.id === "agent-4"
          ? { ...current, status: "completed" as const, updatedAt: 1_300 }
          : current,
      ),
      events: [
        {
          eventId: "event-agent-4-completed",
          type: "agent-completed",
          entityType: "agent",
          entityId: "agent-4",
          payload: {},
          occurredAt: 1_300,
        },
      ],
    });
    assert.throws(
      () =>
        reloaded?.materializeAgentLaunch({
          write: {
            ownerId: "controller-a",
            fencingToken: controller.fencingToken,
            now: 1_301,
          },
          agent: agent("agent-5"),
          paneId: "pane-5",
          sessionId: "55555555-5555-4555-8555-555555555555",
        }),
      AgentCapacityExceededError,
    );

    const completedSnapshot = fixture.repository.loadSnapshot("run-1");
    assert.ok(completedSnapshot);
    const completedAgent = completedSnapshot.agents.find(
      (current) => current.id === "agent-4",
    );
    assert.ok(completedAgent);
    const closedAgent = transitionAgent(completedAgent, {
      type: "agent-closed",
      at: 1_400,
      writerLeaseReleased: true,
    });
    fixture.repository.commitSnapshot({
      write: {
        ownerId: "controller-a",
        fencingToken: controller.fencingToken,
        now: 1_400,
      },
      runId: "run-1",
      expectedRevision: completedSnapshot.revision,
      idempotencyKey: "close-agent-4",
      request: { command: "close-agent", agentId: "agent-4" },
      run: completedSnapshot.run,
      stories: completedSnapshot.stories,
      agents: completedSnapshot.agents.map((current) =>
        current.id === closedAgent.id ? closedAgent : current,
      ),
      events: [
        {
          eventId: "event-agent-4-closed",
          type: "agent-closed",
          entityType: "agent",
          entityId: "agent-4",
          payload: { writerLeaseReleased: true },
          occurredAt: 1_400,
        },
      ],
    });
    assert.equal(
      reloaded.materializeAgentLaunch({
        write: {
          ownerId: "controller-a",
          fencingToken: controller.fencingToken,
          now: 1_401,
        },
        agent: agent("agent-5"),
        paneId: "pane-5",
        sessionId: "55555555-5555-4555-8555-555555555555",
      }).status,
      "launching",
    );
  } finally {
    reloaded?.close();
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("writer lease reservation cannot bypass the global agent boundary", () => {
  const fixture = createFixture();
  try {
    const controller = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, controller.fencingToken, {
      run: { ...run(), complexity: "LOW" },
      agents: [
        agent("agent-1"),
        agent("agent-2"),
        agent("agent-3"),
        agent("agent-4"),
      ],
    });

    assert.throws(
      () =>
        fixture.repository.acquireWriterLease({
          write: {
            ownerId: "controller-a",
            fencingToken: controller.fencingToken,
            now: 1_200,
          },
          runId: "run-1",
          storyId: "story-1",
          ownerAgentId: "agent-5",
          ttlMs: 1_000,
          agent: agent("agent-5", "story-1"),
        }),
      AgentCapacityExceededError,
    );
    const snapshot = fixture.repository.loadSnapshot("run-1");
    assert.ok(snapshot);
    assert.equal(snapshot.stories[0]?.assignedAgentId, null);
    assert.equal(
      snapshot.agents.some((current) => current.id === "agent-5"),
      false,
    );
    assert.equal(fixture.repository.readWriterLease("run-1", "story-1"), null);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("version one databases migrate writer lease tables without losing runs", () => {
  const fixture = createFixture();
  let reopened: SqliteControllerRepository | null = null;
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, lease.fencingToken);
    fixture.repository.close();

    const database = new DatabaseSync(fixture.databasePath);
    database.exec(`
      DROP TABLE controller_launch_compositions;
      DROP TABLE agent_pane_restorations;
      DROP TABLE agent_launches;
      DROP TABLE writer_lease_events;
      DROP TABLE writer_leases;
      PRAGMA user_version = 1;
    `);
    database.close();

    reopened = new SqliteControllerRepository(fixture.databasePath);
    assert.equal(reopened.loadSnapshot("run-1")?.run.id, "run-1");
    reopened.close();
    reopened = null;
    const migrated = new DatabaseSync(fixture.databasePath);
    const version = migrated
      .prepare("PRAGMA user_version")
      .get() as unknown as { readonly user_version: number };
    const leaseTable = migrated
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'writer_leases'",
      )
      .get() as unknown as { readonly name: string } | undefined;
    migrated.close();
    assert.equal(version.user_version, 5);
    assert.equal(leaseTable?.name, "writer_leases");
  } finally {
    reopened?.close();
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("materialized agent launches survive kill points and reconcile exact evidence idempotently", () => {
  const fixture = createFixture();
  let reopened: SqliteControllerRepository | null = null;
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, lease.fencingToken);
    const write = {
      ownerId: "controller-a",
      fencingToken: lease.fencingToken,
      now: 1_200,
    };
    const first = fixture.repository.materializeAgentLaunch({
      write,
      agent: agent(),
      paneId: "pane-1",
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    assert.equal(first.status, "launching");
    assert.equal(
      fixture.repository.readAgentLaunch("run-1", "agent-1")?.status,
      "materialized",
    );

    // Kill point: durable launch materialization landed, but no secure Pi
    // process evidence was confirmed before the controller restarted.
    fixture.repository.close();
    reopened = new SqliteControllerRepository(fixture.databasePath);
    const retryLease = reopened.acquireLease("controller-b", 11_000, 10_000);
    const retryWrite = {
      ownerId: "controller-b",
      fencingToken: retryLease.fencingToken,
      now: 11_100,
    };
    const retried = reopened.materializeAgentLaunch({
      write: retryWrite,
      agent: first,
      paneId: "pane-1",
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    assert.deepEqual(retried, first);
    assert.throws(
      () =>
        reopened?.materializeAgentLaunch({
          write: retryWrite,
          agent: first,
          paneId: "pane-other",
          sessionId: "00000000-0000-4000-8000-000000000002",
        }),
      StaleWriterLeaseError,
    );

    const confirmation = {
      write: retryWrite,
      runId: "run-1",
      agentId: "agent-1",
      paneId: "pane-1",
      sessionId: "00000000-0000-4000-8000-000000000001",
      processIds: [42],
      commandSha256: "a".repeat(64),
    } as const;
    const confirmed = reopened.confirmAgentLaunch(confirmation);
    assert.equal(confirmed.status, "confirmed");
    assert.deepEqual(confirmed.processIds, [42]);
    assert.deepEqual(reopened.confirmAgentLaunch(confirmation), confirmed);
    assert.throws(
      () =>
        reopened?.confirmAgentLaunch({
          ...confirmation,
          processIds: [43],
        }),
      StaleWriterLeaseError,
    );
  } finally {
    reopened?.close();
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("controller leases are exclusive and takeover increments the fencing token", () => {
  const fixture = createFixture();
  try {
    const first = fixture.repository.acquireLease("controller-a", 1_000, 1_000);
    assert.equal(first.fencingToken, 1);
    const renewedByAcquire = fixture.repository.acquireLease(
      "controller-a",
      1_100,
      1_000,
    );
    assert.equal(renewedByAcquire.fencingToken, 1);
    assert.equal(renewedByAcquire.expiresAt, 2_100);

    assert.throws(
      () => fixture.repository.acquireLease("controller-b", 1_200, 1_000),
      ControllerLeaseHeldError,
    );

    const takeover = fixture.repository.acquireLease(
      "controller-b",
      2_100,
      1_000,
    );
    assert.equal(takeover.fencingToken, 2);
    assert.throws(
      () =>
        fixture.repository.renewLease(
          {
            ownerId: "controller-a",
            fencingToken: first.fencingToken,
            now: 2_101,
          },
          1_000,
        ),
      StaleControllerFenceError,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("initial state, revisions, child records, and ordered events commit atomically", () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    const initialized = initialize(fixture.repository, lease.fencingToken);
    assert.deepEqual(initialized, {
      revision: 1,
      eventIds: ["event-run-created"],
      replayed: false,
    });

    const initialSnapshot = fixture.repository.loadSnapshot("run-1");
    assert.ok(initialSnapshot);
    assert.equal(initialSnapshot.revision, 1);
    assert.equal(initialSnapshot.stories[0]?.id, "story-1");
    assert.equal(initialSnapshot.agents[0]?.id, "agent-1");
    const initialStory = initialSnapshot.stories[0];
    assert.ok(initialStory);

    const nextRun = transitionRun(initialSnapshot.run, {
      type: "plan-prepared",
      at: 1_200,
    });
    const nextStory = transitionStory(initialStory, {
      type: "story-prepared",
      at: 1_200,
      complexity: "NORMAL",
    });
    const committed = fixture.repository.commitSnapshot({
      write: {
        ownerId: "controller-a",
        fencingToken: lease.fencingToken,
        now: 1_200,
      },
      runId: "run-1",
      expectedRevision: 1,
      idempotencyKey: "prepare-plan-1",
      request: { command: "prepare-plan" },
      run: nextRun,
      stories: [nextStory],
      agents: [],
      events: [
        {
          eventId: "event-run-plan-prepared",
          type: "plan-prepared",
          entityType: "run",
          entityId: "run-1",
          payload: { status: "awaiting-approval" },
          occurredAt: 1_200,
        },
        {
          eventId: "event-story-plan-prepared",
          type: "story-prepared",
          entityType: "story",
          entityId: "story-1",
          payload: { status: "awaiting-approval" },
          occurredAt: 1_200,
        },
      ],
    });
    assert.equal(committed.revision, 2);

    const snapshot = fixture.repository.loadSnapshot("run-1");
    assert.ok(snapshot);
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.run.status, "awaiting-approval");
    assert.equal(snapshot.stories[0]?.status, "awaiting-approval");
    assert.deepEqual(snapshot.agents, []);

    const events = fixture.repository.readEvents(
      "run-1",
      { revision: 0, eventIndex: -1 },
      10,
    );
    assert.deepEqual(
      events.map((event) => [event.revision, event.eventIndex, event.eventId]),
      [
        [1, 0, "event-run-created"],
        [2, 0, "event-run-plan-prepared"],
        [2, 1, "event-story-plan-prepared"],
      ],
    );
    const resumedEvent = fixture.repository.readEvents(
      "run-1",
      { revision: 2, eventIndex: 0 },
      1,
    )[0];
    assert.ok(resumedEvent);
    assert.equal(resumedEvent.eventId, "event-story-plan-prepared");
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("story and agent identities remain isolated within each run", () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, lease.fencingToken);

    const secondRun: RunState = {
      ...run(),
      id: "run-2",
      integrationBranch: "agentworks/run-2/integration",
      integrationWorktree: "/worktrees/run-2/integration",
    };
    const secondStory: StoryState = {
      ...story(),
      runId: "run-2",
      worktreePath: "/worktrees/run-2/story-1",
    };
    const secondAgent: AgentState = {
      ...agent(),
      runId: "run-2",
      worktreePath: "/worktrees/run-2/story-1",
    };
    fixture.repository.initializeRun({
      write: {
        ownerId: "controller-a",
        fencingToken: lease.fencingToken,
        now: 1_200,
      },
      idempotencyKey: "create-run-2",
      request: { command: "create-run", runId: "run-2" },
      run: secondRun,
      stories: [secondStory],
      agents: [secondAgent],
      events: [
        {
          eventId: "event-run-2-created",
          type: "run-created",
          entityType: "run",
          entityId: "run-2",
          payload: {},
          occurredAt: 1_200,
        },
      ],
    });

    assert.equal(
      fixture.repository.loadSnapshot("run-1")?.stories[0]?.runId,
      "run-1",
    );
    assert.equal(
      fixture.repository.loadSnapshot("run-2")?.stories[0]?.runId,
      "run-2",
    );
    assert.equal(
      fixture.repository.loadSnapshot("run-1")?.agents[0]?.runId,
      "run-1",
    );
    assert.equal(
      fixture.repository.loadSnapshot("run-2")?.agents[0]?.runId,
      "run-2",
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("idempotent retries return the original result and reject key reuse", () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, lease.fencingToken);

    const replay = fixture.repository.initializeRun({
      write: {
        ownerId: "controller-a",
        fencingToken: lease.fencingToken,
        now: 1_101,
      },
      idempotencyKey: "create-run-1",
      request: { options: { a: 1, b: 2 }, command: "create-run" },
      run: run(),
      stories: [story()],
      agents: [agent()],
      events: [
        {
          eventId: "event-run-created",
          type: "run-created",
          entityType: "run",
          entityId: "run-1",
          payload: { status: "planning" },
          occurredAt: 1_100,
        },
      ],
    });
    assert.deepEqual(replay, {
      revision: 1,
      eventIds: ["event-run-created"],
      replayed: true,
    });
    assert.equal(
      fixture.repository.readEvents(
        "run-1",
        { revision: 0, eventIndex: -1 },
        10,
      ).length,
      1,
    );

    assert.throws(
      () =>
        fixture.repository.initializeRun({
          write: {
            ownerId: "controller-a",
            fencingToken: lease.fencingToken,
            now: 1_102,
          },
          idempotencyKey: "create-run-1",
          request: { command: "create-a-different-run" },
          run: run(),
          stories: [story()],
          agents: [agent()],
          events: [
            {
              eventId: "different-event",
              type: "run-created",
              entityType: "run",
              entityId: "run-1",
              payload: {},
              occurredAt: 1_102,
            },
          ],
        }),
      IdempotencyConflictError,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("failed event insertion rolls back the snapshot revision and child changes", () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, lease.fencingToken);
    const current = fixture.repository.loadSnapshot("run-1");
    assert.ok(current);
    const changedRun = transitionRun(current.run, {
      type: "plan-prepared",
      at: 1_200,
    });

    assert.throws(
      () =>
        fixture.repository.commitSnapshot({
          write: {
            ownerId: "controller-a",
            fencingToken: lease.fencingToken,
            now: 1_200,
          },
          runId: "run-1",
          expectedRevision: 1,
          idempotencyKey: "duplicate-event-command",
          request: { command: "duplicate-event" },
          run: changedRun,
          stories: [],
          agents: [],
          events: [
            {
              eventId: "event-run-created",
              type: "plan-prepared",
              entityType: "run",
              entityId: "run-1",
              payload: {},
              occurredAt: 1_200,
            },
          ],
        }),
      /UNIQUE constraint failed/u,
    );

    const unchanged = fixture.repository.loadSnapshot("run-1");
    assert.ok(unchanged);
    assert.equal(unchanged.revision, 1);
    assert.equal(unchanged.run.status, "planning");
    assert.equal(unchanged.stories.length, 1);
    assert.equal(unchanged.agents.length, 1);
    assert.equal(
      fixture.repository.readEvents(
        "run-1",
        { revision: 0, eventIndex: -1 },
        10,
      ).length,
      1,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("stale revisions and released or expired fences cannot mutate state", () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease("controller-a", 1_000, 1_000);
    initialize(fixture.repository, lease.fencingToken);
    const snapshot = fixture.repository.loadSnapshot("run-1");
    assert.ok(snapshot);
    const changedRun = transitionRun(snapshot.run, {
      type: "plan-prepared",
      at: 1_200,
    });
    const command = {
      runId: "run-1",
      expectedRevision: 2,
      idempotencyKey: "stale-revision",
      request: { command: "prepare-plan" } as const,
      run: changedRun,
      stories: snapshot.stories,
      agents: snapshot.agents,
      events: [
        {
          eventId: "event-stale-revision",
          type: "plan-prepared",
          entityType: "run" as const,
          entityId: "run-1",
          payload: {},
          occurredAt: 1_200,
        },
      ],
    };

    assert.throws(
      () =>
        fixture.repository.commitSnapshot({
          ...command,
          write: {
            ownerId: "controller-a",
            fencingToken: lease.fencingToken,
            now: 1_200,
          },
        }),
      StaleRunRevisionError,
    );

    fixture.repository.releaseLease({
      ownerId: "controller-a",
      fencingToken: lease.fencingToken,
      now: 1_300,
    });
    assert.throws(
      () =>
        fixture.repository.commitSnapshot({
          ...command,
          expectedRevision: 1,
          write: {
            ownerId: "controller-a",
            fencingToken: lease.fencingToken,
            now: 1_301,
          },
        }),
      StaleControllerFenceError,
    );

    const nextLease = fixture.repository.acquireLease(
      "controller-b",
      1_400,
      100,
    );
    assert.throws(
      () =>
        fixture.repository.commitSnapshot({
          ...command,
          expectedRevision: 1,
          write: {
            ownerId: "controller-b",
            fencingToken: nextLease.fencingToken,
            now: 1_500,
          },
        }),
      StaleControllerFenceError,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("writer leases acquire, renew, release, persist, and audit exact tokens", () => {
  const fixture = createFixture();
  let reopened: SqliteControllerRepository | null = null;
  try {
    const controller = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, controller.fencingToken, {
      stories: [assignedStory()],
      agents: [agent("agent-1", "story-1")],
    });
    const acquired = fixture.repository.acquireWriterLease({
      write: {
        ownerId: "controller-a",
        fencingToken: controller.fencingToken,
        now: 1_200,
      },
      runId: "run-1",
      storyId: "story-1",
      ownerAgentId: "agent-1",
      ttlMs: 1_000,
    });
    assert.equal(acquired.leaseToken, 1);
    assert.equal(acquired.expiresAt, 2_200);

    const replay = fixture.repository.acquireWriterLease({
      write: {
        ownerId: "controller-a",
        fencingToken: controller.fencingToken,
        now: 1_250,
      },
      runId: "run-1",
      storyId: "story-1",
      ownerAgentId: "agent-1",
      ttlMs: 9_000,
    });
    assert.deepEqual(replay, acquired);

    const renewed = fixture.repository.renewWriterLease(
      {
        write: {
          ownerId: "controller-a",
          fencingToken: controller.fencingToken,
          now: 1_300,
        },
        runId: "run-1",
        storyId: "story-1",
        ownerAgentId: "agent-1",
        leaseToken: acquired.leaseToken,
      },
      2_000,
    );
    assert.equal(renewed.expiresAt, 3_300);
    fixture.repository.close();

    reopened = new SqliteControllerRepository(fixture.databasePath);
    assert.deepEqual(reopened.readWriterLease("run-1", "story-1"), renewed);
    const controllerAfterRestart = reopened.acquireLease(
      "controller-a",
      1_400,
      10_000,
    );
    const released = reopened.releaseWriterLease({
      write: {
        ownerId: "controller-a",
        fencingToken: controllerAfterRestart.fencingToken,
        now: 1_500,
      },
      runId: "run-1",
      storyId: "story-1",
      ownerAgentId: "agent-1",
      leaseToken: acquired.leaseToken,
    });
    assert.equal(released.ownerAgentId, null);
    assert.equal(released.expiresAt, null);
    assert.deepEqual(
      reopened.releaseWriterLease({
        write: {
          ownerId: "controller-a",
          fencingToken: controllerAfterRestart.fencingToken,
          now: 1_501,
        },
        runId: "run-1",
        storyId: "story-1",
        ownerAgentId: "agent-1",
        leaseToken: acquired.leaseToken,
      }),
      released,
    );
    reopened.close();
    reopened = null;

    const database = new DatabaseSync(fixture.databasePath);
    const actions = database
      .prepare(
        "SELECT action FROM writer_lease_events ORDER BY writer_lease_event_id",
      )
      .all() as unknown as readonly { readonly action: string }[];
    database.close();
    assert.deepEqual(
      actions.map((row) => row.action),
      ["acquired", "renewed", "released"],
    );
  } finally {
    reopened?.close();
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("active writer leases block reassignment until exact-token revocation", () => {
  const fixture = createFixture();
  try {
    const controller = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    const firstAgent = agent("agent-1", "story-1");
    const secondAgent = agent("agent-2", "story-1");
    const firstAssignment = assignedStory();
    initialize(fixture.repository, controller.fencingToken, {
      stories: [firstAssignment],
      agents: [firstAgent, secondAgent],
    });
    const firstLease = fixture.repository.acquireWriterLease({
      write: {
        ownerId: "controller-a",
        fencingToken: controller.fencingToken,
        now: 1_200,
      },
      runId: "run-1",
      storyId: "story-1",
      ownerAgentId: "agent-1",
      ttlMs: 2_000,
    });

    const unassigned = transitionStory(firstAssignment, {
      type: "story-reassignment-requested",
      at: 1_210,
      reason: "writer disconnected",
      writerLeaseReleased: true,
    });
    const secondAssignment = transitionStory(unassigned, {
      type: "story-assigned",
      at: 1_211,
      agentId: "agent-2",
    });
    const commitReassignment = (): void => {
      fixture.repository.commitSnapshot({
        write: {
          ownerId: "controller-a",
          fencingToken: controller.fencingToken,
          now: 1_220,
        },
        runId: "run-1",
        expectedRevision: 1,
        idempotencyKey: "reassign-story-1",
        request: { command: "reassign-story", storyId: "story-1" },
        run: run(),
        stories: [secondAssignment],
        agents: [firstAgent, secondAgent],
        events: [
          {
            eventId: "event-story-reassigned",
            type: "story-reassigned",
            entityType: "story",
            entityId: "story-1",
            payload: { agentId: "agent-2" },
            occurredAt: 1_220,
          },
        ],
      });
    };

    assert.throws(commitReassignment, StaleWriterLeaseError);
    assert.throws(
      () =>
        fixture.repository.acquireWriterLease({
          write: {
            ownerId: "controller-a",
            fencingToken: controller.fencingToken,
            now: 1_230,
          },
          runId: "run-1",
          storyId: "story-1",
          ownerAgentId: "agent-2",
          ttlMs: 1_000,
        }),
      WriterLeaseHeldError,
    );
    const revoked = fixture.repository.revokeWriterLease({
      write: {
        ownerId: "controller-a",
        fencingToken: controller.fencingToken,
        now: 1_240,
      },
      runId: "run-1",
      storyId: "story-1",
      expectedLeaseToken: firstLease.leaseToken,
      reason: "agent was disconnected before reassignment",
    });
    assert.equal(revoked.ownerAgentId, null);
    assert.deepEqual(
      fixture.repository.revokeWriterLease({
        write: {
          ownerId: "controller-a",
          fencingToken: controller.fencingToken,
          now: 1_241,
        },
        runId: "run-1",
        storyId: "story-1",
        expectedLeaseToken: firstLease.leaseToken,
        reason: "idempotent retry",
      }),
      revoked,
    );
    commitReassignment();

    const secondLease = fixture.repository.acquireWriterLease({
      write: {
        ownerId: "controller-a",
        fencingToken: controller.fencingToken,
        now: 1_250,
      },
      runId: "run-1",
      storyId: "story-1",
      ownerAgentId: "agent-2",
      ttlMs: 1_000,
    });
    assert.equal(secondLease.leaseToken, firstLease.leaseToken + 1);
    assert.throws(
      () =>
        fixture.repository.renewWriterLease(
          {
            write: {
              ownerId: "controller-a",
              fencingToken: controller.fencingToken,
              now: 1_260,
            },
            runId: "run-1",
            storyId: "story-1",
            ownerAgentId: "agent-1",
            leaseToken: firstLease.leaseToken,
          },
          1_000,
        ),
      StaleWriterLeaseError,
    );
    assert.throws(
      () =>
        fixture.repository.revokeWriterLease({
          write: {
            ownerId: "controller-a",
            fencingToken: controller.fencingToken,
            now: 1_270,
          },
          runId: "run-1",
          storyId: "story-1",
          expectedLeaseToken: firstLease.leaseToken,
          reason: "stale revocation",
        }),
      StaleWriterLeaseError,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("writer lease mutations require the active controller fence and assignment", () => {
  const fixture = createFixture();
  try {
    const controller = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, controller.fencingToken);
    assert.throws(
      () =>
        fixture.repository.acquireWriterLease({
          write: {
            ownerId: "controller-a",
            fencingToken: controller.fencingToken,
            now: 1_200,
          },
          runId: "run-1",
          storyId: "story-1",
          ownerAgentId: "agent-1",
          ttlMs: 1_000,
        }),
      /agent is not assigned/u,
    );

    assert.throws(
      () =>
        fixture.repository.acquireWriterLease({
          write: {
            ownerId: "controller-a",
            fencingToken: controller.fencingToken + 1,
            now: 1_200,
          },
          runId: "run-1",
          storyId: "story-1",
          ownerAgentId: "agent-1",
          ttlMs: 1_000,
        }),
      StaleControllerFenceError,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("writer lease assignment corruption fails repository startup", () => {
  const fixture = createFixture();
  try {
    const controller = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, controller.fencingToken, {
      stories: [assignedStory()],
      agents: [agent("agent-1", "story-1")],
    });
    fixture.repository.acquireWriterLease({
      write: {
        ownerId: "controller-a",
        fencingToken: controller.fencingToken,
        now: 1_200,
      },
      runId: "run-1",
      storyId: "story-1",
      ownerAgentId: "agent-1",
      ttlMs: 1_000,
    });
    fixture.repository.close();

    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare(
        "UPDATE stories SET state_json = json_set(state_json, '$.assignedAgentId', 'agent-2')",
      )
      .run();
    database.close();
    assert.throws(
      () => new SqliteControllerRepository(fixture.databasePath),
      ControllerDatabaseIntegrityError,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("semantically invalid persisted state fails closed on load", () => {
  const fixture = createFixture();
  let reopened: SqliteControllerRepository | null = null;
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, lease.fencingToken);
    fixture.repository.close();

    const database = new DatabaseSync(fixture.databasePath);
    database
      .prepare(
        "UPDATE runs SET state_json = json_set(state_json, '$.status', 'impossible')",
      )
      .run();
    database.close();

    reopened = new SqliteControllerRepository(fixture.databasePath);
    assert.throws(
      () => reopened?.loadSnapshot("run-1"),
      ControllerDatabaseIntegrityError,
    );
  } finally {
    reopened?.close();
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("state survives repository restart without relying on terminal output", () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      1_000,
      10_000,
    );
    initialize(fixture.repository, lease.fencingToken);
    fixture.repository.close();

    const databaseBytes = readFileSync(fixture.databasePath);
    assert.ok(databaseBytes.length > 0);

    const reopened = new SqliteControllerRepository(fixture.databasePath);
    const snapshot = reopened.loadSnapshot("run-1");
    assert.ok(snapshot);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.run.id, "run-1");
    assert.equal(snapshot.stories[0]?.id, "story-1");
    reopened.assertIntegrity();
    reopened.close();
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
