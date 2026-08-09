import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentState,
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import {
  SecureStoryAgentLauncherAdapter,
  type PreparedStoryAgentLaunch,
  type StoryAgentLaunchPreparation,
} from "../src/application/launch/story-agent-launcher-adapter.ts";
import type {
  PiAgentLaunchEvidence,
  PiAgentLaunchRequest,
  PiAgentLauncher,
} from "../src/application/ports/pi-agent-launcher.ts";
import type {
  ConfirmAgentLaunchInput,
  ControllerSnapshot,
} from "../src/application/ports/controller-repository.ts";

function fixture(): {
  readonly snapshot: ControllerSnapshot;
  readonly story: ControllerSnapshot["stories"][number];
  readonly run: ControllerSnapshot["run"];
  readonly agent: ControllerSnapshot["agents"][number];
} {
  const run = createRunState({
    id: "run-1",
    title: "Ship",
    complexity: "HIGH",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktree/integration",
    createdAt: 1,
  });
  const story = createStoryState({
    id: "story-1",
    runId: run.id,
    title: "Story",
    branchName: "agentworks/run-1/story-1",
    worktreePath: "/worktree/story-1",
    createdAt: 1,
  });
  const agent = createAgentState({
    id: "agent-1",
    runId: run.id,
    roleRuntimeId: "software-development/backend-developer",
    taskId: story.id,
    worktreePath: story.worktreePath,
    createdAt: 1,
  });
  return {
    snapshot: { revision: 1, run, stories: [story], agents: [agent] },
    story,
    run,
    agent,
  };
}

test("story launcher adapter delegates prepared assignments and records launch evidence", async () => {
  const { snapshot, story, run, agent } = fixture();
  const request = {
    paneId: "pane-1",
    sessionId: "00000000-0000-4000-8000-000000000001",
  } as unknown as PiAgentLaunchRequest;
  const evidence: PiAgentLaunchEvidence = {
    paneId: "pane-1",
    sessionId: "00000000-0000-4000-8000-000000000001",
    processIds: [42],
    sandbox: {} as PiAgentLaunchEvidence["sandbox"],
    rolePromptPath: "/session/role.md",
    taskPromptPath: "/session/task.md",
    controllerCapabilityPath: "/session/token",
    rolePromptSha256: "role-hash",
    taskPromptSha256: "task-hash",
    commandSha256: "command-hash",
  };
  let launched: PiAgentLaunchRequest | null = null;
  let confirmed: ConfirmAgentLaunchInput | null = null;
  const launcher: PiAgentLauncher = {
    launch(input) {
      launched = input;
      return Promise.resolve(evidence);
    },
  };
  const preparation: StoryAgentLaunchPreparation = {
    prepareProjectManager() {
      return Promise.reject(new Error("not used"));
    },
    prepareAdvisor() {
      return Promise.reject(new Error("not used"));
    },
    prepareWriter() {
      const prepared: PreparedStoryAgentLaunch = {
        request,
        agent,
        events: [],
      };
      return Promise.resolve(prepared);
    },
    prepareReviewer() {
      return Promise.reject(new Error("not used"));
    },
  };
  const adapter = new SecureStoryAgentLauncherAdapter({
    launcher,
    preparation,
    launchAuthority: {
      confirmAgentLaunch(input) {
        confirmed = input;
      },
    },
    write: { ownerId: "controller", fencingToken: 1, now: 9 },
    clock: () => 10,
  });

  const result = await adapter.launchWriter(story, run, snapshot);

  assert.equal(launched, request);
  assert.equal(result.agent.id, agent.id);
  assert.deepEqual(confirmed, {
    write: { ownerId: "controller", fencingToken: 1, now: 9 },
    runId: "run-1",
    agentId: "agent-1",
    paneId: "pane-1",
    sessionId: "00000000-0000-4000-8000-000000000001",
    processIds: [42],
    commandSha256: "command-hash",
  });
  assert.deepEqual(result.events, [
    {
      eventId: result.events[0]?.eventId,
      type: "agent-writer-process-launched",
      entityType: "agent",
      entityId: "agent-1",
      payload: {
        paneId: "pane-1",
        sessionId: "00000000-0000-4000-8000-000000000001",
        processIds: [42],
        rolePromptSha256: "role-hash",
        taskPromptSha256: "task-hash",
        commandSha256: "command-hash",
      },
      occurredAt: 10,
    },
  ]);
});

test("post-materialization launch retries coalesce every domain without duplicating resources", async () => {
  const { snapshot, story, run, agent } = fixture();
  const request = {
    paneId: "pane-1",
    sessionId: "00000000-0000-4000-8000-000000000001",
  } as unknown as PiAgentLaunchRequest;
  const evidence: PiAgentLaunchEvidence = {
    paneId: request.paneId,
    sessionId: request.sessionId,
    processIds: [42],
    sandbox: {} as PiAgentLaunchEvidence["sandbox"],
    rolePromptPath: "/session/role.md",
    taskPromptPath: "/session/task.md",
    controllerCapabilityPath: "/session/token",
    rolePromptSha256: "a".repeat(64),
    taskPromptSha256: "b".repeat(64),
    commandSha256: "c".repeat(64),
  };
  const preparationCalls = new Map<string, number>();
  const prepared = (kind: string): Promise<PreparedStoryAgentLaunch> => {
    preparationCalls.set(kind, (preparationCalls.get(kind) ?? 0) + 1);
    return Promise.resolve({ request, agent, events: [] });
  };
  const preparation: StoryAgentLaunchPreparation = {
    prepareProjectManager: () => prepared("project-manager"),
    prepareAdvisor: () => prepared("advisor"),
    prepareWriter: () => prepared("writer"),
    prepareReviewer: () => prepared("reviewer"),
  };
  let launchCalls = 0;
  let failNext = true;
  const launcher: PiAgentLauncher = {
    launch() {
      launchCalls += 1;
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("secure Pi failed after materialize"));
      }
      return Promise.resolve(evidence);
    },
  };
  const confirmations: ConfirmAgentLaunchInput[] = [];
  const authority = {
    confirmAgentLaunch(input: ConfirmAgentLaunchInput) {
      confirmations.push(input);
    },
  };
  const adapterDependencies = {
    launcher,
    preparation,
    launchAuthority: authority,
    write: { ownerId: "controller", fencingToken: 1, now: 9 },
    clock: () => 10,
  } as const;
  const adapter = new SecureStoryAgentLauncherAdapter(adapterDependencies);
  // A distinct adapter models a concurrent orchestration composition in the
  // same controller process; the repository authority is the shared lock key.
  const concurrentAdapter = new SecureStoryAgentLauncherAdapter(
    adapterDependencies,
  );

  // The first writer attempt reproduces the durable dead-end boundary: its
  // preparation/materialization completed, then secure Pi launch failed.
  await assert.rejects(
    adapter.launchWriter(story, run, snapshot),
    /secure Pi failed after materialize/u,
  );
  assert.equal(preparationCalls.get("writer"), 1);

  const domains = [
    [
      "project-manager",
      () => adapter.launchProjectManager(story, run, snapshot),
      () => concurrentAdapter.launchProjectManager(story, run, snapshot),
    ],
    [
      "advisor",
      () => adapter.launchAdvisor(story, run, snapshot),
      () => concurrentAdapter.launchAdvisor(story, run, snapshot),
    ],
    [
      "writer",
      () => adapter.launchWriter(story, run, snapshot),
      () => concurrentAdapter.launchWriter(story, run, snapshot),
    ],
    [
      "reviewer",
      () => adapter.launchReviewer(story, run, snapshot),
      () => concurrentAdapter.launchReviewer(story, run, snapshot),
    ],
  ] as const;
  for (const [kind, launch, concurrentLaunch] of domains) {
    const before = preparationCalls.get(kind) ?? 0;
    const [left, right] = await Promise.all([launch(), concurrentLaunch()]);
    assert.equal(left, right);
    assert.equal(preparationCalls.get(kind), before + 1);
  }
  assert.equal(launchCalls, 5);
  assert.equal(confirmations.length, 4);
});
