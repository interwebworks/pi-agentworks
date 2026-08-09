import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCallerRuntimeMatchesComposition,
  authenticateControllerLaunchComposition,
  createControllerLaunchComposition,
  environmentFromControllerLaunchComposition,
  verifyControllerLaunchComposition,
} from "../src/infrastructure/controller/controller-launch-composition.ts";
import { SqliteControllerRepository } from "../src/infrastructure/controller/sqlite-controller-repository.ts";
import {
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";

const TOKEN = "test-controller-token-with-at-least-thirty-two-bytes";

function liveComposition(runId = "run-composition") {
  return createControllerLaunchComposition(
    runId,
    {
      AGENTWORKS_ENABLE_LIVE_ORCHESTRATION: "1",
      AGENTWORKS_WORKSPACE_ID: "w1P",
      // These tests validate immutable composition and authentication. The
      // live Herdr binary is intentionally not required in the unit runner.
      AGENTWORKS_HERDR_PATH: process.execPath,
      PI_PROVIDER: "local-sglang",
      PI_MODEL: "Qwen/Qwen3.5-2B",
      PI_REASONING_LEVEL: "off",
      AGENTWORKS_ALLOW_HOST_NETWORK: "1",
      HOME: process.env.HOME,
      // This is deliberately outside the typed evidence allowlist.
      OPENAI_API_KEY: "must-not-be-persisted",
    } as Record<string, string | undefined>,
    process.cwd(),
    { leaseTtlMs: 600, renewIntervalMs: 100 },
  );
}

test("authenticated composition preserves exact runtime policy without credentials", () => {
  const composition = liveComposition();
  const authenticated = authenticateControllerLaunchComposition(
    composition,
    TOKEN,
  );
  assert.equal(
    authenticated.serialized.includes("must-not-be-persisted"),
    false,
  );
  assert.equal(authenticated.serialized.includes("OPENAI_API_KEY"), false);
  assert.deepEqual(
    verifyControllerLaunchComposition(
      authenticated.serialized,
      authenticated.authenticationTag,
      TOKEN,
    ),
    composition,
  );
  assert.throws(
    () =>
      verifyControllerLaunchComposition(
        authenticated.serialized.replace("Qwen3.5-2B", "Qwen3.5-4B"),
        authenticated.authenticationTag,
        TOKEN,
      ),
    /authentication failed/u,
  );
  assert.throws(
    () =>
      assertCallerRuntimeMatchesComposition(
        {
          workspaceId: "w1P",
          provider: "local-sglang",
          model: "Qwen/drifted",
          thinking: "off",
          allowHostNetwork: true,
        },
        composition,
      ),
    /caller drifted.*model/u,
  );
  const environment = environmentFromControllerLaunchComposition(composition);
  assert.equal(environment.PI_PROVIDER, "local-sglang");
  assert.equal(environment.PI_MODEL, "Qwen/Qwen3.5-2B");
  assert.equal(environment.PI_REASONING_LEVEL, "off");
  assert.equal(environment.AGENTWORKS_ALLOW_HOST_NETWORK, "1");
  assert.equal(environment.AGENTWORKS_WORKSPACE_ID, "w1P");
});

test("SQLite binds one immutable authenticated composition under the controller fence", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentworks-composition-db-"));
  const repository = new SqliteControllerRepository(
    join(directory, "controller.sqlite"),
  );
  try {
    const lease = repository.acquireLease("controller-a", 1_000, 10_000);
    const runId = "run-composition";
    const run = createRunState({
      id: runId,
      title: "Composition",
      complexity: "NORMAL",
      repositoryRoot: "/repo",
      originalCheckout: "/repo",
      baseBranch: "main",
      integrationBranch: `agentworks/${runId}/integration`,
      integrationWorktree: `/worktrees/${runId}/integration`,
      createdAt: 1_000,
    });
    const story = createStoryState({
      id: "story-1",
      runId,
      title: "Composition",
      branchName: `agentworks/${runId}/story-1`,
      worktreePath: `/worktrees/${runId}/story-1`,
      createdAt: 1_000,
    });
    repository.initializeRun({
      write: {
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        now: 1_100,
      },
      idempotencyKey: "initialize-composition",
      request: { command: "initialize-composition" },
      run,
      stories: [story],
      agents: [],
      events: [
        {
          eventId: "composition-run-created",
          type: "run-created",
          entityType: "run",
          entityId: runId,
          payload: {},
          occurredAt: 1_100,
        },
      ],
    });
    const authenticated = authenticateControllerLaunchComposition(
      liveComposition(runId),
      TOKEN,
    );
    const input = {
      write: {
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        now: 1_200,
      },
      runId,
      compositionJson: authenticated.serialized,
      authenticationTag: authenticated.authenticationTag,
    };
    const bound = repository.bindControllerLaunchComposition(input);
    assert.equal(bound.runId, runId);
    assert.deepEqual(repository.bindControllerLaunchComposition(input), bound);
    assert.deepEqual(repository.readControllerLaunchComposition(runId), bound);
    assert.throws(
      () =>
        repository.bindControllerLaunchComposition({
          ...input,
          authenticationTag: "0".repeat(64),
        }),
      /immutable and already differs/u,
    );
    assert.throws(
      () =>
        repository.bindControllerLaunchComposition({
          ...input,
          write: { ...input.write, fencingToken: lease.fencingToken + 1 },
        }),
      /fencing check failed/u,
    );
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
