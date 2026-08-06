import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveOrchestrationLoop,
  LiveOrchestrationCompositionError,
  type LiveOrchestrationCompositionDependencies,
} from "../src/application/orchestration/live-orchestration-composition.ts";

test("live orchestration composition rejects missing privileged dependencies", () => {
  const missingRepository = {
    runId: "run-1",
    repository: null,
    git: {},
    launcher: {},
    context: {},
    dependenciesByStory: new Map(),
    clock: Date.now,
  } as unknown as LiveOrchestrationCompositionDependencies;

  assert.throws(
    () => createLiveOrchestrationLoop(missingRepository),
    (error: unknown) =>
      error instanceof LiveOrchestrationCompositionError &&
      error.message.includes("controller repository is required"),
  );
});

test("live orchestration composition rejects an empty run id", () => {
  const missingRunId = {
    runId: "   ",
    repository: {},
    git: {},
    launcher: {},
    context: {},
    dependenciesByStory: new Map(),
    clock: Date.now,
  } as unknown as LiveOrchestrationCompositionDependencies;

  assert.throws(
    () => createLiveOrchestrationLoop(missingRunId),
    (error: unknown) =>
      error instanceof LiveOrchestrationCompositionError &&
      error.message.includes("runId cannot be empty"),
  );
});
