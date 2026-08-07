import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredControllerProcessDependencies,
  assessDeferredInitialResume,
  executeInjectedOrchestration,
  resolveConfiguredOrchestrationProvider,
  resolveControllerOrchestrationExecutor,
  resumeDeferredInitialOrchestration,
  type ControllerOrchestrationExecutor,
} from "../src/controller/process-entry.ts";
import type {
  ControllerSnapshot,
  FencedWrite,
} from "../src/application/ports/controller-repository.ts";
import {
  createAgentState,
  createRunState,
  createStoryState,
  transitionRun,
  transitionStory,
} from "../src/domain/controller-state.ts";
import type { ControllerRuntime } from "../src/infrastructure/controller/controller-runtime.ts";
import { ControllerRequestError } from "../src/infrastructure/controller/unix-controller-transport.ts";

const write: FencedWrite = {
  ownerId: "controller",
  fencingToken: 4,
  now: 100,
};

function deferredSnapshot(): ControllerSnapshot {
  const run = transitionRun(
    createRunState({
      id: "run-1",
      title: "Deferred run",
      complexity: "HIGH",
      repositoryRoot: "/repo",
      originalCheckout: "/repo",
      baseBranch: "main",
      integrationBranch: "agentworks/run-1/integration",
      integrationWorktree: "/worktrees/run-1/integration",
      createdAt: 1,
    }),
    { type: "plan-prepared", at: 1 },
  );
  const story = transitionStory(
    createStoryState({
      id: "story-1",
      runId: run.id,
      title: "Implement recovery",
      branchName: "agentworks/run-1/story-1",
      worktreePath: "/worktrees/run-1/story-1",
      createdAt: 1,
    }),
    { type: "story-prepared", complexity: "HIGH", at: 1 },
  );
  return { revision: 1, run, stories: [story], agents: [] };
}

function runtimeAuthority(
  read: () => ControllerSnapshot,
  overrides: { readonly leaseExpiresAt?: number } = {},
): ControllerRuntime {
  return {
    assertReadyForWork: () => undefined,
    currentWrite: () => write,
    descriptor: {
      ownerId: write.ownerId,
      fencingToken: write.fencingToken,
      leaseExpiresAt: overrides.leaseExpiresAt ?? write.now + 1_000,
    },
    repository: { loadSnapshot: read },
  } as unknown as ControllerRuntime;
}

test("injected orchestration entrypoint forwards current fenced write to executor", async () => {
  let received: FencedWrite | null = null;
  const executor: ControllerOrchestrationExecutor = {
    execute(current) {
      received = current;
      return Promise.resolve({ accepted: true });
    },
  };

  assert.deepEqual(
    await executeInjectedOrchestration("parent", {}, write, executor),
    { accepted: true },
  );
  assert.deepEqual(received, write);
});

test("orchestration execution is serialized per controller executor", async () => {
  const releases: (() => void)[] = [];
  const firstGate = new Promise<void>((resolve) => {
    releases.push(resolve);
  });
  let active = 0;
  let maximumActive = 0;
  const order: number[] = [];
  const executor: ControllerOrchestrationExecutor = {
    async execute() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const sequence = order.length + 1;
      order.push(sequence);
      if (sequence === 1) await firstGate;
      active -= 1;
      return { sequence };
    },
  };

  const first = executeInjectedOrchestration("parent", {}, write, executor);
  const second = executeInjectedOrchestration("parent", {}, write, executor);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [1]);
  assert.equal(maximumActive, 1);
  const releaseFirst = releases[0];
  assert.ok(releaseFirst);
  releaseFirst();

  assert.deepEqual(await Promise.all([first, second]), [
    { sequence: 1 },
    { sequence: 2 },
  ]);
  assert.equal(maximumActive, 1);
});

test("deferred initial resume coalesces concurrent retries and launches exactly once", async () => {
  let snapshot = deferredSnapshot();
  let releaseLaunch: (() => void) | undefined;
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  let launchSets = 0;
  const executor: ControllerOrchestrationExecutor = {
    async execute() {
      launchSets += 1;
      await launchGate;
      snapshot = {
        ...snapshot,
        agents: [
          createAgentState({
            id: "agent-1",
            runId: snapshot.run.id,
            roleRuntimeId: "general-delivery/project-manager",
            taskId: null,
            worktreePath: snapshot.run.integrationWorktree,
            createdAt: write.now,
          }),
        ],
      };
      return { accepted: true };
    },
  };
  const runtime = runtimeAuthority(() => snapshot);

  assert.deepEqual(assessDeferredInitialResume(snapshot), {
    eligible: true,
    reason: "eligible",
  });
  const resumes = Array.from({ length: 4 }, () =>
    resumeDeferredInitialOrchestration(
      "parent",
      {},
      runtime,
      "run-1",
      executor,
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(launchSets, 1);
  releaseLaunch?.();
  const results = await Promise.all(resumes);
  assert.equal(
    results.every((result) => {
      if (
        result === null ||
        typeof result !== "object" ||
        Array.isArray(result)
      ) {
        return false;
      }
      return (result as Readonly<Record<string, unknown>>).resumed === true;
    }),
    true,
  );
  assert.equal(launchSets, 1);

  assert.deepEqual(
    await resumeDeferredInitialOrchestration(
      "parent",
      {},
      runtime,
      "run-1",
      executor,
    ),
    {
      accepted: true,
      resumed: false,
      reason: "launch-already-started",
      revision: 1,
      agentCount: 1,
    },
  );
  assert.equal(launchSets, 1);
});

test("deferred resume waits for an in-flight ordinary first tick before deciding", async () => {
  let snapshot = deferredSnapshot();
  let releaseLaunch: (() => void) | undefined;
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  let launchSets = 0;
  const executor: ControllerOrchestrationExecutor = {
    async execute() {
      launchSets += 1;
      await launchGate;
      snapshot = {
        ...snapshot,
        agents: [
          createAgentState({
            id: "agent-ordinary",
            runId: snapshot.run.id,
            roleRuntimeId: "general-delivery/project-manager",
            taskId: null,
            worktreePath: snapshot.run.integrationWorktree,
            createdAt: write.now,
          }),
        ],
      };
      return { accepted: true };
    },
  };
  const ordinary = executeInjectedOrchestration("parent", {}, write, executor);
  const resumed = resumeDeferredInitialOrchestration(
    "parent",
    {},
    runtimeAuthority(() => snapshot),
    "run-1",
    executor,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(launchSets, 1);
  releaseLaunch?.();

  await ordinary;
  assert.deepEqual(await resumed, {
    accepted: true,
    resumed: false,
    reason: "launch-already-started",
    revision: 1,
    agentCount: 1,
  });
  assert.equal(launchSets, 1);
});

test("deferred initial resume rejects stale fencing before effects", async () => {
  const snapshot = deferredSnapshot();
  let launchSets = 0;
  await assert.rejects(
    resumeDeferredInitialOrchestration(
      "parent",
      {},
      runtimeAuthority(() => snapshot, { leaseExpiresAt: write.now }),
      "run-1",
      {
        execute() {
          launchSets += 1;
          return Promise.resolve({ accepted: true });
        },
      },
    ),
    (error: unknown) =>
      error instanceof ControllerRequestError && error.code === "stale-fence",
  );
  assert.equal(launchSets, 0);
});

test("host dependency adapter remains dormant unless explicitly enabled", () => {
  const provider = () => ({
    execute: () => Promise.resolve({ accepted: true }),
  });
  assert.deepEqual(
    createConfiguredControllerProcessDependencies({}, provider),
    {},
  );
  const dependencies = createConfiguredControllerProcessDependencies(
    { AGENTWORKS_ENABLE_LIVE_ORCHESTRATION: "1" },
    provider,
  );
  assert.equal(dependencies.orchestrationFactory, provider);
});

test("configured orchestration provider requires an exact enablement marker and provider", () => {
  const provider = () => ({
    execute: () => Promise.resolve({ accepted: true }),
  });
  assert.equal(resolveConfiguredOrchestrationProvider({}, provider), undefined);
  assert.equal(
    resolveConfiguredOrchestrationProvider(
      { AGENTWORKS_ENABLE_LIVE_ORCHESTRATION: "1" },
      provider,
    ),
    provider,
  );
  assert.throws(
    () =>
      resolveConfiguredOrchestrationProvider(
        { AGENTWORKS_ENABLE_LIVE_ORCHESTRATION: "yes" },
        provider,
      ),
    /must be exactly 1/u,
  );
  assert.throws(
    () =>
      resolveConfiguredOrchestrationProvider(
        { AGENTWORKS_ENABLE_LIVE_ORCHESTRATION: "1" },
        undefined,
      ),
    /no composition provider/u,
  );
});

test("process dependency factory is lazy and can supply the executor", () => {
  const executor: ControllerOrchestrationExecutor = {
    execute: () => Promise.resolve({ accepted: true }),
  };
  const runtime = {} as unknown as ControllerRuntime;
  let called = false;
  assert.equal(
    resolveControllerOrchestrationExecutor(runtime, {
      orchestrationFactory: (current) => {
        called = current === runtime;
        return executor;
      },
    }),
    executor,
  );
  assert.equal(called, true);
});

test("orchestration entrypoint stays fail closed without injection or parent identity", async () => {
  await assert.rejects(
    executeInjectedOrchestration("parent", {}, write, undefined),
    /not configured/u,
  );
  await assert.rejects(
    executeInjectedOrchestration("management", {}, write, {
      execute: () => Promise.resolve({ accepted: true }),
    }),
    /Only a parent client/u,
  );
  await assert.rejects(
    resumeDeferredInitialOrchestration(
      "management",
      {},
      runtimeAuthority(deferredSnapshot),
      "run-1",
      { execute: () => Promise.resolve({ accepted: true }) },
    ),
    /Only a parent client/u,
  );
});
