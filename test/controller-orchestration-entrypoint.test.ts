import assert from "node:assert/strict";
import test from "node:test";
import {
  executeInjectedOrchestration,
  type ControllerOrchestrationExecutor,
} from "../src/controller/process-entry.ts";
import type { FencedWrite } from "../src/application/ports/controller-repository.ts";

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
