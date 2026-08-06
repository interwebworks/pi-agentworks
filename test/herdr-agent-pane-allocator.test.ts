import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrPane } from "../src/application/ports/herdr-gateway.ts";
import {
  HerdrAgentPaneAllocator,
  type HerdrAgentPaneAllocationRequest,
} from "../src/application/launch/herdr-agent-pane-allocator.ts";
import type { AgentsTabEvidence } from "../src/application/herdr/agents-tab-lifecycle.ts";

const pane: HerdrPane = {
  paneId: "workspace-1:p1",
  terminalId: "terminal-1",
  workspaceId: "workspace-1",
  tabId: "workspace-1:t1",
  focused: false,
  agentStatus: "idle",
  revision: 2,
  agent: "agent-1",
  agentSession: null,
  cwd: "/worktree/story-1",
  foregroundCwd: "/worktree/story-1",
  label: "agent-1",
  title: null,
  terminalTitle: null,
  terminalTitleStripped: null,
  displayAgent: "agent-1",
  stateLabels: {},
  tokens: { aw_kind: "agent", aw_run: "run-1", aw_agent: "agent-1" },
};

const request: HerdrAgentPaneAllocationRequest = {
  runId: "run-1",
  operationId: "op-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  label: "agent-1",
  cwd: "/worktree/story-1",
  expectedTabId: "workspace-1:t1",
  expectedPaneId: pane.paneId,
  metadataSequence: 1,
};

test("Herdr pane allocator verifies lifecycle evidence and final pane ownership", async () => {
  const evidence: AgentsTabEvidence = {
    tabId: "workspace-1:t1",
    rootPaneId: pane.paneId,
    paneIds: [pane.paneId],
    createdTab: false,
    recovered: true,
    rowCount: 1,
    columnCount: 1,
  };
  let released = false;
  const allocator = new HerdrAgentPaneAllocator(
    { ensure: () => Promise.resolve(evidence) },
    {
      getPane: () => Promise.resolve(pane),
      closePane: () => {
        released = true;
        return Promise.resolve();
      },
    },
  );

  assert.equal((await allocator.allocate(request)).paneId, pane.paneId);
  await allocator.release(pane.paneId);
  assert.equal(released, true);
});

test("Herdr pane allocator rejects cwd drift", async () => {
  const evidence: AgentsTabEvidence = {
    tabId: "workspace-1:t1",
    rootPaneId: pane.paneId,
    paneIds: [pane.paneId],
    createdTab: false,
    recovered: true,
    rowCount: 1,
    columnCount: 1,
  };
  const allocator = new HerdrAgentPaneAllocator(
    { ensure: () => Promise.resolve(evidence) },
    {
      getPane: () => Promise.resolve({ ...pane, cwd: "/wrong" }),
      closePane: () => Promise.resolve(),
    },
  );

  await assert.rejects(
    allocator.allocate(request),
    /final ownership verification/u,
  );
});
