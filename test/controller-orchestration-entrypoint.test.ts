import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredControllerProcessDependencies,
  executeInjectedOrchestration,
  resolveConfiguredOrchestrationProvider,
  resolveControllerOrchestrationExecutor,
  type ControllerOrchestrationExecutor,
} from "../src/controller/process-entry.ts";
import type { FencedWrite } from "../src/application/ports/controller-repository.ts";
import type { ControllerRuntime } from "../src/infrastructure/controller/controller-runtime.ts";

const write: FencedWrite = {
  ownerId: "controller",
  fencingToken: 4,
  now: 100,
};

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
});
