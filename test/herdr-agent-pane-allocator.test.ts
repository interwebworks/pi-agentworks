import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrPane } from "../src/application/ports/herdr-gateway.ts";
import {
  HerdrAgentPaneAllocator,
  type HerdrAgentPaneAllocationRequest,
} from "../src/application/launch/herdr-agent-pane-allocator.ts";
import type {
  AgentsTabEvidence,
  EnsureAgentsTabRequest,
} from "../src/application/herdr/agents-tab-lifecycle.ts";

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
  tokens: {
    aw_kind: "agent",
    aw_run: "run-1",
    aw_operation: "run-1",
    aw_slot: "0",
    aw_agent: "agent-1",
  },
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
      listPanes: () => Promise.resolve([]),
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

test("Herdr pane allocator grows one stable run grid with the complete live roster", async () => {
  const manager: HerdrPane = {
    ...pane,
    paneId: "workspace-1:p-manager",
    cwd: "/worktree/integration",
    label: "Project Manager",
    displayAgent: "Project Manager",
    tokens: {
      aw_kind: "agent",
      aw_run: "run-1",
      aw_operation: "run-1",
      aw_agent: "manager-1",
      aw_slot: "0",
    },
  };
  const writer: HerdrPane = {
    ...pane,
    paneId: "workspace-1:p-writer",
    label: "Writer",
    displayAgent: "Writer",
    tokens: {
      aw_kind: "agent",
      aw_run: "run-1",
      aw_operation: "run-1",
      aw_agent: "writer-1",
      aw_slot: "1",
    },
  };
  const captured: EnsureAgentsTabRequest[] = [];
  const allocator = new HerdrAgentPaneAllocator(
    {
      ensure(input) {
        captured.push(input);
        return Promise.resolve({
          tabId: manager.tabId,
          rootPaneId: manager.paneId,
          paneIds: [manager.paneId, writer.paneId],
          createdTab: false,
          recovered: true,
          rowCount: 1,
          columnCount: 2,
        });
      },
    },
    {
      listPanes: () => Promise.resolve([manager]),
      getPane: () => Promise.resolve(writer),
      closePane: () => Promise.resolve(),
    },
  );

  const allocated = await allocator.allocate({
    ...request,
    agentId: "writer-1",
    label: "Writer",
    expectedPaneId: null,
    expectedAgents: [
      {
        agentId: "manager-1",
        paneId: manager.paneId,
        label: "Project Manager",
        cwd: "/worktree/integration",
      },
    ],
  });

  assert.equal(allocated.paneId, writer.paneId);
  const requestFrame = captured[0];
  assert.ok(requestFrame);
  assert.equal(requestFrame.operationId, "run-1");
  assert.deepEqual(requestFrame.expectedPaneIds, [manager.paneId, null]);
  assert.deepEqual(requestFrame.assignments, [
    {
      agentId: "manager-1",
      label: "Project Manager",
      cwd: "/worktree/integration",
    },
    {
      agentId: "writer-1",
      label: "Writer",
      cwd: "/worktree/story-1",
    },
  ]);
});

test("Herdr pane allocator rejects live roster adoption and accepts controller order independent of pane slots", async () => {
  const manager = {
    ...pane,
    paneId: "workspace-1:p-manager",
    cwd: "/worktree/integration",
    label: "Mutated label",
    tokens: {
      aw_kind: "agent",
      aw_run: "run-1",
      aw_operation: "run-1",
      aw_agent: "manager-1",
      aw_slot: "0",
    },
  };
  const writer = {
    ...pane,
    paneId: "workspace-1:p-writer",
    label: "Writer",
    tokens: {
      aw_kind: "agent",
      aw_run: "run-1",
      aw_operation: "run-1",
      aw_agent: "writer-1",
      aw_slot: "1",
    },
  };
  const captured: EnsureAgentsTabRequest[] = [];
  const allocator = new HerdrAgentPaneAllocator(
    {
      ensure(input) {
        captured.push(input);
        return Promise.resolve({
          tabId: manager.tabId,
          rootPaneId: manager.paneId,
          paneIds: [manager.paneId, writer.paneId, "workspace-1:p-new"],
          createdTab: false,
          recovered: true,
          rowCount: 1,
          columnCount: 3,
        });
      },
    },
    {
      listPanes: () => Promise.resolve([manager, writer]),
      getPane: () =>
        Promise.resolve({
          ...pane,
          paneId: "workspace-1:p-new",
          tokens: {
            ...pane.tokens,
            aw_agent: "advisor-1",
            aw_slot: "2",
          },
        }),
      closePane: () => Promise.resolve(),
    },
  );

  await allocator.allocate({
    ...request,
    agentId: "advisor-1",
    label: "Software Architect",
    expectedPaneId: null,
    expectedAgents: [
      {
        agentId: "writer-1",
        paneId: writer.paneId,
        label: "Writer",
        cwd: writer.cwd ?? "",
      },
      {
        agentId: "manager-1",
        paneId: manager.paneId,
        label: "Project Manager",
        cwd: manager.cwd,
      },
    ],
  });

  const capturedFrame = captured[0];
  assert.ok(capturedFrame);
  assert.deepEqual(capturedFrame.assignments[0], {
    agentId: "manager-1",
    label: "Project Manager",
    cwd: "/worktree/integration",
  });

  await assert.rejects(
    allocator.allocate({
      ...request,
      agentId: "advisor-1",
      expectedPaneId: null,
      expectedAgents: [
        {
          agentId: "manager-1",
          paneId: manager.paneId,
          label: "Project Manager",
          cwd: "/wrong",
        },
        {
          agentId: "writer-1",
          paneId: writer.paneId,
          label: "Writer",
          cwd: writer.cwd ?? "",
        },
      ],
    }),
    /disagrees with the controller agent roster/u,
  );
});

test("Herdr pane allocator rejects cwd, operation, and slot drift", async () => {
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
      listPanes: () => Promise.resolve([]),
      closePane: () => Promise.resolve(),
    },
  );

  await assert.rejects(
    allocator.allocate(request),
    /final ownership verification/u,
  );

  for (const tokens of [
    { ...pane.tokens, aw_operation: "other-run" },
    { ...pane.tokens, aw_slot: "1" },
  ]) {
    const drifted = new HerdrAgentPaneAllocator(
      { ensure: () => Promise.resolve(evidence) },
      {
        getPane: () => Promise.resolve({ ...pane, tokens }),
        listPanes: () => Promise.resolve([]),
        closePane: () => Promise.resolve(),
      },
    );
    await assert.rejects(
      drifted.allocate(request),
      /final ownership verification/u,
    );
  }
});
