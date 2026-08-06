import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import type { HerdrPane } from "../src/application/ports/herdr-gateway.ts";
import type { GitAssignmentEvidence } from "../src/application/launch/assignment-resource-evidence.ts";
import {
  HerdrSessionEvidenceAdapter,
  type PrivateSessionProvider,
} from "../src/application/launch/herdr-session-evidence-adapter.ts";

function fixture() {
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
  const pane: HerdrPane = {
    paneId: "pane-1",
    terminalId: "terminal-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    focused: false,
    agentStatus: "idle",
    revision: 2,
    agent: "agent-1",
    agentSession: null,
    cwd: story.worktreePath,
    foregroundCwd: story.worktreePath,
    label: "agent-1",
    title: null,
    terminalTitle: null,
    terminalTitleStripped: null,
    displayAgent: "agent-1",
    stateLabels: {},
    tokens: { aw_kind: "agent", aw_run: run.id, aw_agent: "agent-1" },
  };
  const git: GitAssignmentEvidence = {
    commonGitDirectory: "/repo/.git",
    baseBranch: run.integrationBranch,
    expectedIntegrationHead: "a".repeat(40),
    integrationBranch: run.integrationBranch,
    storyBranch: story.branchName,
    expectedStoryHead: "b".repeat(40),
    worktreePath: story.worktreePath,
  };
  return { run, story, pane, git };
}

test("Herdr/session adapter validates ownership and returns private evidence", async () => {
  const { run, story, pane, git } = fixture();
  const session = {
    sessionPath: "/session",
    configPath: "/session/config",
    controllerChildAuthToken: "A".repeat(43),
  };
  const adapter = new HerdrSessionEvidenceAdapter({
    panes: { getPane: () => Promise.resolve(pane) },
    sessions: {
      create: () => Promise.resolve(session),
      cleanup: () => Promise.resolve(),
    },
  });

  const evidence = await adapter.provision(
    run,
    story,
    "agent-1",
    "pane-1",
    git,
    {
      controllerSocketPath: "/runtime/controller.sock",
      runtimePath: "/runtime",
      controllerFenceCurrent: true,
      expectedRevisionMatches: true,
    },
  );

  assert.equal(evidence.herdr.tokens.aw_agent, "agent-1");
  assert.equal(evidence.session.sessionPath, "/session");
});

test("Herdr/session adapter cleans up a session when fence evidence is stale", async () => {
  const { run, story, pane, git } = fixture();
  let cleaned = false;
  const session = {
    sessionPath: "/session",
    configPath: "/session/config",
    controllerChildAuthToken: "A".repeat(43),
  };
  const sessions: PrivateSessionProvider = {
    create: () => Promise.resolve(session),
    cleanup: () => {
      cleaned = true;
      return Promise.resolve();
    },
  };
  const adapter = new HerdrSessionEvidenceAdapter({
    panes: { getPane: () => Promise.resolve(pane) },
    sessions,
  });

  await assert.rejects(
    adapter.provision(run, story, "agent-1", "pane-1", git, {
      controllerSocketPath: "/runtime/controller.sock",
      runtimePath: "/runtime",
      controllerFenceCurrent: false,
      expectedRevisionMatches: true,
    }),
  );
  assert.equal(cleaned, true);
});
