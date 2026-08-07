import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ControllerEventInput,
  JsonValue,
} from "../src/application/ports/controller-repository.ts";
import {
  createAgentState,
  createRunState,
  transitionAgent,
  transitionRun,
  type AgentState,
} from "../src/domain/controller-state.ts";
import { isControllerRunBackgroundWorkActive } from "../src/infrastructure/controller/controller-background-work.ts";
import { ControllerRuntime } from "../src/infrastructure/controller/controller-runtime.ts";

function request(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function event(
  eventId: string,
  type: string,
  entityId: string,
  occurredAt: number,
): ControllerEventInput {
  return {
    eventId,
    type,
    entityType: "agent",
    entityId,
    payload: {},
    occurredAt,
  };
}

function agentStates(
  runtimeRoot: string,
  runId: string,
  createdAt: number,
): Readonly<
  Record<
    "planned" | "completed" | "failed" | "disconnected" | "closed",
    AgentState
  >
> {
  const planned = createAgentState({
    id: "agent-1",
    runId,
    roleRuntimeId: "writer",
    taskId: null,
    worktreePath: join(runtimeRoot, "writer"),
    createdAt,
  });
  const launching = transitionAgent(planned, {
    type: "launch-requested",
    paneId: "pane-1",
    at: createdAt + 1,
  });
  const idle = transitionAgent(launching, {
    type: "session-ready",
    piSessionPath: join(runtimeRoot, "session.jsonl"),
    at: createdAt + 2,
  });
  const completed = transitionAgent(idle, {
    type: "agent-completed",
    at: createdAt + 3,
  });
  return Object.freeze({
    planned,
    completed,
    failed: transitionAgent(planned, {
      type: "agent-failed",
      reason: "launch failed",
      at: createdAt + 1,
    }),
    disconnected: transitionAgent(launching, {
      type: "pane-lost",
      at: createdAt + 2,
    }),
    closed: transitionAgent(completed, {
      type: "agent-closed",
      writerLeaseReleased: true,
      at: createdAt + 4,
    }),
  });
}

test("controller background probe keeps every unclosed agent visible on a nonterminal run", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-background-"));
  const runId = "run-background";
  const runtime = new ControllerRuntime({
    runtimeRoot,
    runId,
    ownerId: "controller-background",
    authorizeIdentity: () => true,
    handleRequest: () => ({}),
  });
  try {
    await runtime.start();
    const createdAt = Date.now();
    const run = transitionRun(
      createRunState({
        id: runId,
        title: "background work",
        complexity: "LOW",
        repositoryRoot: runtimeRoot,
        originalCheckout: runtimeRoot,
        baseBranch: "main",
        integrationBranch: "agentworks/integration",
        integrationWorktree: join(runtimeRoot, "integration"),
        createdAt,
      }),
      { type: "plan-prepared", at: createdAt + 1 },
    );
    const states = agentStates(runtimeRoot, runId, createdAt);
    runtime.repository.initializeRun({
      write: runtime.currentWrite(),
      idempotencyKey: "initialize-background-run",
      request: request({ run, agent: states.planned }),
      run,
      stories: [],
      agents: [states.planned],
      events: [
        event(
          "background-agent-planned",
          "agent-planned",
          states.planned.id,
          createdAt,
        ),
      ],
    });

    assert.equal(states.planned.status, "planned");
    assert.equal(isControllerRunBackgroundWorkActive(runtimeRoot, runId), true);

    let revision = 1;
    for (const state of [
      states.completed,
      states.failed,
      states.disconnected,
    ]) {
      runtime.repository.commitSnapshot({
        write: runtime.currentWrite(),
        runId,
        expectedRevision: revision,
        idempotencyKey: `background-agent-${state.status}`,
        request: request({ agent: state }),
        run,
        stories: [],
        agents: [state],
        events: [
          event(
            `background-agent-${state.status}`,
            `agent-${state.status}`,
            state.id,
            state.updatedAt,
          ),
        ],
      });
      revision += 1;
      assert.equal(
        isControllerRunBackgroundWorkActive(runtimeRoot, runId),
        true,
        `${state.status} must remain visible until durable closure`,
      );
    }

    runtime.repository.commitSnapshot({
      write: runtime.currentWrite(),
      runId,
      expectedRevision: revision,
      idempotencyKey: "background-agent-closed",
      request: request({ agent: states.closed }),
      run,
      stories: [],
      agents: [states.closed],
      events: [
        event(
          "background-agent-closed",
          "agent-closed",
          states.closed.id,
          states.closed.updatedAt,
        ),
      ],
    });
    assert.equal(
      isControllerRunBackgroundWorkActive(runtimeRoot, runId),
      false,
    );
  } finally {
    await runtime.shutdown();
    assert.equal(
      isControllerRunBackgroundWorkActive(runtimeRoot, runId),
      false,
    );
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
