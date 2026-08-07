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
import type { ControllerSnapshot } from "../src/application/ports/controller-repository.ts";

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
  const request = {} as unknown as PiAgentLaunchRequest;
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
    clock: () => 10,
  });

  const result = await adapter.launchWriter(story, run, snapshot);

  assert.equal(launched, request);
  assert.equal(result.agent.id, agent.id);
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
