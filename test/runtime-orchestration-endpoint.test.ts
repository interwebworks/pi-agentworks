import assert from "node:assert/strict";
import test from "node:test";
import type { ControllerRuntimeDescriptor } from "../src/infrastructure/controller/controller-runtime.ts";
import {
  deriveRuntimeEndpointEvidence,
  RuntimeOrchestrationEndpointError,
} from "../src/infrastructure/controller/runtime-orchestration-endpoint.ts";
import type { FencedWrite } from "../src/application/ports/controller-repository.ts";

const descriptor = {
  schemaVersion: 1,
  runId: "run-1",
  ownerId: "owner-1",
  processId: 100,
  processStartIdentity: null,
  startedAt: 1,
  leaseExpiresAt: 2_000,
  fencingToken: 3,
  recovery: { status: "ready", reasons: [] },
  runtimeDirectory: "/runtime/run-1",
  databasePath: "/runtime/run-1/controller.sqlite",
  socketPath: "/runtime/run-1/controller.sock",
  tokenPath: "/runtime/run-1/auth-token",
} as unknown as ControllerRuntimeDescriptor;
const write: FencedWrite = { ownerId: "owner-1", fencingToken: 3, now: 100 };

test("runtime endpoint evidence binds socket/runtime paths to current fence", () => {
  assert.deepEqual(
    deriveRuntimeEndpointEvidence(descriptor, write, "run-1", 4),
    {
      controllerSocketPath: "/runtime/run-1/controller.sock",
      runtimePath: "/runtime/run-1",
      controllerFenceCurrent: true,
      expectedRevisionMatches: true,
    },
  );
});

test("runtime endpoint evidence rejects owner or fencing drift", () => {
  assert.throws(
    () =>
      deriveRuntimeEndpointEvidence(
        descriptor,
        { ...write, fencingToken: 4 },
        "run-1",
        4,
      ),
    (error: unknown) =>
      error instanceof RuntimeOrchestrationEndpointError &&
      error.message.includes("not owned"),
  );
});
