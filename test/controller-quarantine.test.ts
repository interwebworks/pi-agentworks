import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createAgentState,
  createRunState,
  transitionAgent,
} from "../src/domain/controller-state.ts";
import {
  ControllerDatabaseQuarantinedError,
  readControllerQuarantineRecord,
} from "../src/infrastructure/controller/controller-database-quarantine.ts";
import {
  ControllerRecoveryRequiredError,
  ControllerRuntime,
  resolveControllerRuntimePaths,
} from "../src/infrastructure/controller/controller-runtime.ts";
import { SqliteControllerRepository } from "../src/infrastructure/controller/sqlite-controller-repository.ts";

function runtime(root: string): ControllerRuntime {
  return new ControllerRuntime({
    runtimeRoot: root,
    runId: "run-1",
    ownerId: "controller-runtime",
    autoRenew: false,
    clock: () => 2_000,
    authorizeIdentity: () => true,
    handleRequest: () => ({}),
  });
}

function initializeWorkingSnapshot(databasePath: string): void {
  const repository = new SqliteControllerRepository(databasePath);
  const lease = repository.acquireLease("initializer", 1_000, 10_000);
  const run = createRunState({
    id: "run-1",
    title: "Recover state",
    complexity: "NORMAL",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktrees/run-1/integration",
    createdAt: 1_000,
  });
  let agent = createAgentState({
    id: "agent-1",
    runId: "run-1",
    roleRuntimeId: "software-development/backend-developer",
    taskId: "task-1",
    worktreePath: "/worktrees/run-1/story-1",
    createdAt: 1_000,
  });
  agent = transitionAgent(agent, {
    type: "launch-requested",
    at: 1_001,
    paneId: "pane-1",
  });
  agent = transitionAgent(agent, {
    type: "session-ready",
    at: 1_002,
    piSessionPath: "/sessions/agent-1.jsonl",
  });
  agent = transitionAgent(agent, {
    type: "operation-started",
    at: 1_003,
    operation: "Implement story",
  });
  repository.initializeRun({
    write: {
      ownerId: "initializer",
      fencingToken: lease.fencingToken,
      now: 1_100,
    },
    idempotencyKey: "initialize-run",
    request: { command: "initialize" },
    run,
    stories: [],
    agents: [agent],
    events: [
      {
        eventId: "run-created",
        type: "run-created",
        entityType: "run",
        entityId: "run-1",
        payload: {},
        occurredAt: 1_100,
      },
    ],
  });
  repository.releaseLease({
    ownerId: "initializer",
    fencingToken: lease.fencingToken,
    now: 1_200,
  });
  repository.close();
}

test("physical SQLite corruption is quarantined and blocks empty-state recreation", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-quarantine-"));
  const paths = resolveControllerRuntimePaths(root, "run-1");
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.databasePath, "this is not a sqlite database", {
    mode: 0o600,
  });
  const controller = runtime(root);
  try {
    await assert.rejects(
      controller.start(),
      ControllerDatabaseQuarantinedError,
    );
    assert.equal(existsSync(paths.databasePath), false);
    const record = readControllerQuarantineRecord(paths.quarantineMarkerPath);
    assert.ok(record);
    assert.equal(record.reason, "sqlite-corruption");
    assert.equal(record.quarantinedFiles.length, 1);
    const quarantinedDatabase = record.quarantinedFiles[0];
    assert.ok(quarantinedDatabase);
    assert.equal(existsSync(quarantinedDatabase), true);
    assert.equal(statSync(quarantinedDatabase).mode & 0o777, 0o600);
    assert.equal(statSync(paths.quarantineMarkerPath).mode & 0o777, 0o600);

    const retry = runtime(root);
    await assert.rejects(retry.start(), ControllerDatabaseQuarantinedError);
    assert.equal(existsSync(paths.databasePath), false);
    await retry.shutdown();
  } finally {
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic state corruption is quarantined before the socket accepts work", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-quarantine-"));
  const paths = resolveControllerRuntimePaths(root, "run-1");
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  initializeWorkingSnapshot(paths.databasePath);

  const database = new DatabaseSync(paths.databasePath);
  database
    .prepare(
      "UPDATE runs SET state_json = json_set(state_json, '$.status', 'impossible')",
    )
    .run();
  database.close();

  const controller = runtime(root);
  try {
    await assert.rejects(
      controller.start(),
      ControllerDatabaseQuarantinedError,
    );
    const record = readControllerQuarantineRecord(paths.quarantineMarkerPath);
    assert.ok(record);
    assert.equal(record.reason, "persisted-state-invalid");
    assert.equal(existsSync(paths.socketPath), false);
    assert.equal(existsSync(paths.descriptorPath), false);
  } finally {
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup publishes a reconciliation gate for interrupted operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-quarantine-"));
  const paths = resolveControllerRuntimePaths(root, "run-1");
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  initializeWorkingSnapshot(paths.databasePath);

  const controller = runtime(root);
  try {
    const descriptor = await controller.start();
    assert.deepEqual(descriptor.recovery, {
      status: "reconciliation-required",
      reasons: [{ code: "agent-operation-interrupted", entityId: "agent-1" }],
    });
    assert.throws(
      () => controller.assertReadyForWork(),
      ControllerRecoveryRequiredError,
    );
  } finally {
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
