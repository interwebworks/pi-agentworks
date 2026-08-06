import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionOrchestrationLoop,
  ProductionOrchestrationCompositionError,
  type ProductionOrchestrationCompositionDependencies,
} from "../src/application/orchestration/production-composition.ts";

test("production orchestration composition refuses partial setup", () => {
  assert.throws(
    () => createProductionOrchestrationLoop(null),
    (error: unknown) =>
      error instanceof ProductionOrchestrationCompositionError &&
      error.message.includes("all controller"),
  );
});

test("production orchestration composition refuses invalid lease policy", () => {
  const invalid = {
    runId: "run-1",
    writerLeaseTtlMs: 0,
  } as unknown as ProductionOrchestrationCompositionDependencies;
  assert.throws(
    () => createProductionOrchestrationLoop(invalid),
    (error: unknown) =>
      error instanceof ProductionOrchestrationCompositionError &&
      error.message.includes("writer lease ttl"),
  );
});
