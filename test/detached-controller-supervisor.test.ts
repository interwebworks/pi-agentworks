import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverControllerRuntime,
  readProcessStartIdentity,
} from "../src/infrastructure/controller/controller-runtime.ts";
import { DetachedControllerSupervisor } from "../src/infrastructure/controller/detached-controller-supervisor.ts";
import {
  ControllerRemoteError,
  UnixControllerClient,
} from "../src/infrastructure/controller/unix-controller-transport.ts";
import {
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import type { JsonValue } from "../src/application/ports/controller-repository.ts";

function createSupervisor(root: string): DetachedControllerSupervisor {
  return new DetachedControllerSupervisor({
    runtimeRoot: root,
    runId: "run-1",
    startupTimeoutMs: 10_000,
    shutdownTimeoutMs: 10_000,
    pollIntervalMs: 25,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("Timed out waiting for condition");
}

test("supervisor launches one detached healthy controller and reuses it", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-supervisor-"));
  const supervisor = createSupervisor(root);
  try {
    const started = await supervisor.ensureRunning();
    assert.equal(started.started, true);
    assert.notEqual(started.descriptor.processId, process.pid);
    assert.equal(
      readProcessStartIdentity(started.descriptor.processId),
      started.descriptor.processStartIdentity,
    );
    assert.deepEqual(await supervisor.inspect(), {
      status: "healthy",
      descriptor: started.descriptor,
    });

    const reused = await supervisor.ensureRunning();
    assert.equal(reused.started, false);
    assert.equal(reused.descriptor.ownerId, started.descriptor.ownerId);
    assert.equal(reused.descriptor.processId, started.descriptor.processId);
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached process serves core read actions and protects shutdown authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-supervisor-"));
  const supervisor = createSupervisor(root);
  try {
    await supervisor.ensureRunning();
    const discovered = discoverControllerRuntime(root, "run-1");
    assert.ok(discovered);

    const managementClient = new UnixControllerClient({
      socketPath: discovered.descriptor.socketPath,
      runId: "run-1",
      authToken: discovered.authToken,
      clientId: "management-1",
      clientKind: "management",
      agentId: null,
    });
    await managementClient.connect();
    assert.equal(
      await managementClient.request({ action: "snapshot.get", payload: {} }),
      null,
    );
    assert.deepEqual(
      await managementClient.request({
        action: "events.read",
        payload: { revision: 0, eventIndex: -1, limit: 10 },
      }),
      [],
    );
    await assert.rejects(
      managementClient.request({ action: "controller.shutdown", payload: {} }),
      (error: unknown) =>
        error instanceof ControllerRemoteError && error.code === "forbidden",
    );
    managementClient.close();
    const parentClient = new UnixControllerClient({
      socketPath: discovered.descriptor.socketPath,
      runId: "run-1",
      authToken: discovered.authToken,
      clientId: "parent-1",
      clientKind: "parent",
      agentId: null,
    });
    await parentClient.connect();
    const now = Date.now();
    const run = createRunState({
      id: "run-1",
      title: "Initialize me",
      complexity: "NORMAL",
      repositoryRoot: "/repo",
      originalCheckout: "/repo",
      baseBranch: "main",
      integrationBranch: "agentworks/run-1/integration",
      integrationWorktree: "/worktree/integration",
      createdAt: now,
    });
    const story = createStoryState({
      id: "story-1",
      runId: "run-1",
      title: "Initialize me",
      branchName: "agentworks/run-1/story-1",
      worktreePath: "/worktree/story-1",
      createdAt: now,
    });
    const initialized = await parentClient.request({
      action: "run.initialize",
      idempotencyKey: "initialize-run-1",
      payload: {
        run,
        stories: [story],
        agents: [],
        events: [
          {
            eventId: "event-run-created",
            type: "run-created",
            entityType: "run",
            entityId: "run-1",
            payload: { title: run.title },
            occurredAt: now,
          },
        ],
      } as unknown as JsonValue,
    });
    assert.deepEqual(initialized, {
      revision: 1,
      eventIds: ["event-run-created"],
      replayed: false,
    });
    const initializedSnapshot = await parentClient.request({
      action: "snapshot.get",
      payload: {},
    });
    assert.ok(
      initializedSnapshot !== null &&
        typeof initializedSnapshot === "object" &&
        !Array.isArray(initializedSnapshot),
    );
    assert.equal(
      (initializedSnapshot as Readonly<Record<string, JsonValue>>).revision,
      1,
    );
    assert.deepEqual(
      await parentClient.request({
        action: "orchestration.plan",
        payload: {},
      }),
      { runId: "run-1", revision: 1, actions: [] },
    );
    await assert.rejects(
      parentClient.request({
        action: "orchestration.execute",
        payload: {},
      }),
      (error: unknown) =>
        error instanceof ControllerRemoteError &&
        error.code === "not-configured",
    );
    parentClient.close();
    assert.equal((await supervisor.inspect()).status, "healthy");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGTERM performs graceful lease, descriptor, and socket cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-supervisor-"));
  const supervisor = createSupervisor(root);
  try {
    const started = await supervisor.ensureRunning();
    process.kill(started.descriptor.processId, "SIGTERM");
    await waitFor(
      () =>
        discoverControllerRuntime(root, "run-1") === null &&
        readProcessStartIdentity(started.descriptor.processId) === null,
    );
    assert.equal(existsSync(started.descriptor.socketPath), false);

    const restarted = await supervisor.ensureRunning();
    assert.equal(restarted.started, true);
    assert.equal(restarted.descriptor.fencingToken, 2);
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor recovers a SIGKILL crash after the fenced lease expires", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-supervisor-"));
  const supervisor = new DetachedControllerSupervisor({
    runtimeRoot: root,
    runId: "run-1",
    leaseTtlMs: 400,
    renewIntervalMs: 100,
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 5_000,
    pollIntervalMs: 20,
  });
  try {
    const first = await supervisor.ensureRunning();
    process.kill(first.descriptor.processId, "SIGKILL");
    await waitFor(
      () => readProcessStartIdentity(first.descriptor.processId) === null,
    );

    const recovered = await supervisor.ensureRunning();
    assert.equal(recovered.started, true);
    assert.notEqual(recovered.descriptor.processId, first.descriptor.processId);
    assert.equal(recovered.descriptor.fencingToken, 2);
    assert.equal((await supervisor.inspect()).status, "healthy");
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller startup failures are captured in the private log", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-supervisor-"));
  const supervisor = new DetachedControllerSupervisor({
    runtimeRoot: root,
    runId: "run-1",
    entryPath: join(root, "missing-entry.ts"),
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    pollIntervalMs: 25,
  });
  try {
    await assert.rejects(
      supervisor.ensureRunning(),
      /exited before becoming healthy/u,
    );
    const logPath = join(root, "run-1", "controller.log");
    assert.equal(existsSync(logPath), true);
    assert.match(
      readFileSync(logPath, "utf8"),
      /MODULE_NOT_FOUND|Cannot find module/u,
    );
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
