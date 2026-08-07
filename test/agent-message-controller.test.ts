import assert from "node:assert/strict";
import test from "node:test";
import {
  heartbeat,
  sessionStarted,
} from "../src/domain/agent-communication.ts";
import {
  AgentMessageController,
  AgentMessageControllerError,
} from "../src/application/controller/agent-message-controller.ts";
import {
  createAgentState,
  createRunState,
  type AgentState,
  type RunState,
} from "../src/domain/controller-state.ts";
import type {
  CommitResult,
  ControllerEventInput,
  ControllerRepository,
  ControllerSnapshot,
  FencedWrite,
  WriterLease,
} from "../src/application/ports/controller-repository.ts";

class FakeRepository implements ControllerRepository {
  snapshot: ControllerSnapshot;
  commitCount = 0;
  lastWrite: FencedWrite | null = null;
  lastEvents: readonly ControllerEventInput[] = [];

  constructor(agent: AgentState) {
    const run: RunState = createRunState({
      id: agent.runId,
      title: "Run",
      complexity: "HIGH",
      repositoryRoot: "/repo",
      originalCheckout: "/repo",
      baseBranch: "main",
      integrationBranch: "agentworks/run/integration",
      integrationWorktree: "/worktree/integration",
      createdAt: 1,
    });
    this.snapshot = { revision: 1, run, stories: [], agents: [agent] };
  }

  acquireLease(): never {
    throw new Error("unused");
  }
  renewLease(): never {
    throw new Error("unused");
  }
  releaseLease(): void {
    throw new Error("unused");
  }
  acquireWriterLease(): never {
    throw new Error("unused");
  }
  confirmAgentLaunch(): never {
    throw new Error("unused");
  }
  readAgentLaunch(): null {
    return null;
  }
  renewWriterLease(): never {
    throw new Error("unused");
  }
  releaseWriterLease(): never {
    throw new Error("unused");
  }
  revokeWriterLease(): never {
    throw new Error("unused");
  }
  readWriterLease(): WriterLease | null {
    return null;
  }
  initializeRun(): never {
    throw new Error("unused");
  }
  loadSnapshot(): ControllerSnapshot {
    return this.snapshot;
  }
  commitSnapshot(input: {
    write: FencedWrite;
    agents: readonly AgentState[];
    events: readonly ControllerEventInput[];
  }): CommitResult {
    this.commitCount += 1;
    this.lastWrite = input.write;
    this.lastEvents = input.events;
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      agents: input.agents,
    };
    return { revision: this.snapshot.revision, eventIds: [], replayed: false };
  }
  readEvents(): never {
    throw new Error("unused");
  }
  assertIntegrity(): void {
    return;
  }
  close(): void {
    return;
  }
}

function idleAgent(): AgentState {
  return {
    ...createAgentState({
      id: "agent-1",
      runId: "run-1",
      roleRuntimeId: "software-development/backend-developer",
      taskId: "task-1",
      worktreePath: "/worktree",
      createdAt: 1,
    }),
    status: "idle",
    paneId: "pane-1",
    updatedAt: 2,
  };
}

test("agent message controller commits a fenced heartbeat transition", () => {
  const repository = new FakeRepository(idleAgent());
  const controller = new AgentMessageController(repository, () => 3);
  const result = controller.apply(
    heartbeat("run-1", "agent-1", 10),
    { ownerId: "controller", fencingToken: 4, now: 3 },
    "request-1",
  );
  assert.deepEqual(result, {
    revision: 2,
    changed: true,
    replayed: false,
    reaction: { type: "none" },
  });
  assert.equal(repository.commitCount, 1);
  assert.deepEqual(repository.lastWrite, {
    ownerId: "controller",
    fencingToken: 4,
    now: 3,
  });
  assert.equal(repository.snapshot.agents[0]?.lastHeartbeatAt, 3);
});

test("blocked messages commit a supervisor attention event", () => {
  const repository = new FakeRepository(idleAgent());
  const result = new AgentMessageController(repository, () => 3).apply(
    {
      protocolVersion: 1,
      type: "agent-blocked",
      runId: "run-1",
      agentId: "agent-1",
      reason: "blocked",
      detail: "needs approval",
    },
    { ownerId: "controller", fencingToken: 4, now: 3 },
    "request-blocked",
  );
  assert.equal(result.reaction.type, "attention-required");
  assert.deepEqual(
    repository.lastEvents.map((event) => event.type),
    ["agent-agent-blocked", "supervisor-attention-required"],
  );
});

test("session-started without a path is acknowledged without inventing readiness", () => {
  const repository = new FakeRepository({
    ...idleAgent(),
    status: "launching",
    piSessionPath: null,
  });
  const result = new AgentMessageController(repository, () => 3).apply(
    sessionStarted("run-1", "agent-1", "session-1"),
    { ownerId: "controller", fencingToken: 4, now: 3 },
    "request-2",
  );
  assert.deepEqual(result, {
    revision: 1,
    changed: false,
    replayed: false,
    reaction: { type: "none" },
  });
  assert.equal(repository.commitCount, 0);
});

test("unknown agents fail closed before repository mutation", () => {
  const repository = new FakeRepository(idleAgent());
  assert.throws(
    () =>
      new AgentMessageController(repository, () => 3).apply(
        heartbeat("run-1", "other-agent", 10),
        { ownerId: "controller", fencingToken: 4, now: 3 },
        "request-3",
      ),
    AgentMessageControllerError,
  );
  assert.equal(repository.commitCount, 0);
});
