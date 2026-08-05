import assert from "node:assert/strict";
import test from "node:test";
import type {
  HerdrCreateTabRequest,
  HerdrPane,
  HerdrPaneLayout,
  HerdrPaneMetadataReport,
  HerdrSplitPaneRequest,
  HerdrTab,
} from "../src/application/ports/herdr-gateway.ts";
import type {
  PaneProcessEvidenceGateway,
  PaneShellEnvironmentEvidence,
} from "../src/application/ports/pane-process-evidence.ts";
import {
  AgentsTabLifecycle,
  AgentsTabRecoveryRequiredError,
  type AgentPaneAssignment,
  type EnsureAgentsTabRequest,
} from "../src/application/herdr/agents-tab-lifecycle.ts";
import { planPaneGrid } from "../src/domain/pane-grid.ts";

function assignments(count: number): readonly AgentPaneAssignment[] {
  return Object.freeze(
    Array.from({ length: count }, (_, slot) => ({
      agentId: `agent-${String(slot)}`,
      label: `Agent ${String(slot + 1).padStart(2, "0")}`,
      cwd: `/worktrees/story-${String(slot)}`,
    })),
  );
}

function request(count: number): EnsureAgentsTabRequest {
  return {
    runId: "run-1",
    operationId: "agents-op-1",
    workspaceId: "w1P",
    expectedTabId: null,
    expectedPaneIds: Array.from({ length: count }, () => null),
    assignments: assignments(count),
    metadataSequence: 11,
  };
}

function environment(slot: number): Readonly<Record<string, string>> {
  return {
    AGENTWORKS_AGENT_ID: `agent-${String(slot)}`,
    AGENTWORKS_PANE_KIND: "agent",
    AGENTWORKS_PANE_OPERATION_ID: "agents-op-1",
    AGENTWORKS_RUN_ID: "run-1",
    AGENTWORKS_PANE_SLOT: String(slot),
  };
}

function paneForSlot(slot: number): HerdrPane {
  return {
    paneId: `w1P:p${slot.toString(16).toUpperCase()}`,
    terminalId: `term-${String(slot)}`,
    workspaceId: "w1P",
    tabId: "w1P:tA",
    focused: slot === 0,
    agentStatus: "unknown",
    revision: 0,
    agent: null,
    agentSession: null,
    cwd: `/worktrees/story-${String(slot)}`,
    foregroundCwd: `/worktrees/story-${String(slot)}`,
    label: null,
    title: null,
    terminalTitle: null,
    terminalTitleStripped: null,
    displayAgent: null,
    stateLabels: {},
    tokens: {},
  };
}

class FakeAgentProcessEvidence implements PaneProcessEvidenceGateway {
  readonly environments = new Map<string, Readonly<Record<string, string>>>();

  readShellEnvironment(
    paneId: string,
  ): Promise<PaneShellEnvironmentEvidence | null> {
    const owned = this.environments.get(paneId);
    return Promise.resolve(
      owned === undefined
        ? null
        : {
            paneId,
            shellPid:
              1_000 + Number.parseInt(paneId.split("p").at(-1) ?? "0", 16),
            environment: owned,
          },
    );
  }
}

class FakeAgentsHerdr {
  tabs: HerdrTab[];
  panes: HerdrPane[];
  readonly process: FakeAgentProcessEvidence;
  readonly count: number;
  readonly createRequests: HerdrCreateTabRequest[] = [];
  readonly splitRequests: HerdrSplitPaneRequest[] = [];
  readonly metadata: HerdrPaneMetadataReport[] = [];
  readonly paneRenames: { paneId: string; label: string }[] = [];
  readonly tabRenames: { tabId: string; label: string }[] = [];
  malformedLayout = false;

  constructor(count: number, existingSlots: readonly number[] = []) {
    this.count = count;
    this.process = new FakeAgentProcessEvidence();
    this.tabs =
      existingSlots.length === 0
        ? []
        : [
            {
              tabId: "w1P:tA",
              workspaceId: "w1P",
              number: 10,
              label: "Pi Agents",
              focused: false,
              paneCount: existingSlots.length,
              agentStatus: "unknown",
            },
          ];
    this.panes = existingSlots.map((slot) => paneForSlot(slot));
    for (const slot of existingSlots) {
      this.process.environments.set(
        paneForSlot(slot).paneId,
        environment(slot),
      );
    }
  }

  listTabs(): Promise<readonly HerdrTab[]> {
    return Promise.resolve(this.tabs);
  }

  listPanes(): Promise<readonly HerdrPane[]> {
    return Promise.resolve(this.panes);
  }

  createTab(request_: HerdrCreateTabRequest): Promise<{
    readonly tab: HerdrTab;
    readonly rootPane: HerdrPane;
  }> {
    this.createRequests.push(request_);
    const tab: HerdrTab = {
      tabId: "w1P:tA",
      workspaceId: "w1P",
      number: 10,
      label: request_.label,
      focused: false,
      paneCount: 1,
      agentStatus: "unknown",
    };
    const rootPane = paneForSlot(0);
    this.tabs = [tab];
    this.panes = [rootPane];
    this.process.environments.set(rootPane.paneId, request_.environment ?? {});
    return Promise.resolve({ tab, rootPane });
  }

  splitPane(request_: HerdrSplitPaneRequest): Promise<HerdrPane> {
    this.splitRequests.push(request_);
    const slot = Number(request_.environment?.AGENTWORKS_PANE_SLOT);
    const pane = paneForSlot(slot);
    this.panes.push(pane);
    this.process.environments.set(pane.paneId, request_.environment ?? {});
    return Promise.resolve(pane);
  }

  renameTab(tabId: string, label: string): Promise<void> {
    this.tabRenames.push({ tabId, label });
    this.tabs = this.tabs.map((tab) =>
      tab.tabId === tabId ? { ...tab, label } : tab,
    );
    return Promise.resolve();
  }

  renamePane(paneId: string, label: string): Promise<void> {
    this.paneRenames.push({ paneId, label });
    this.panes = this.panes.map((pane) =>
      pane.paneId === paneId ? { ...pane, label } : pane,
    );
    return Promise.resolve();
  }

  reportPaneMetadata(report: HerdrPaneMetadataReport): Promise<void> {
    this.metadata.push(report);
    this.panes = this.panes.map((pane) =>
      pane.paneId === report.paneId
        ? { ...pane, tokens: { ...pane.tokens, ...(report.tokens ?? {}) } }
        : pane,
    );
    return Promise.resolve();
  }

  getPaneLayout(): Promise<HerdrPaneLayout> {
    const plan = planPaneGrid(this.count);
    const width = 120;
    const height = 120;
    let slot = 0;
    const panes = [];
    for (const [row, rowSize] of plan.rowPaneCounts.entries()) {
      for (let column = 0; column < rowSize; column += 1) {
        const owned = paneForSlot(slot);
        panes.push({
          paneId: owned.paneId,
          focused: slot === 0,
          rect: {
            x:
              column * (width / rowSize) +
              (this.malformedLayout && slot === 1 ? 1 : 0),
            y: row * (height / plan.rowCount),
            width: width / rowSize,
            height: height / plan.rowCount,
          },
        });
        slot += 1;
      }
    }
    return Promise.resolve({
      workspaceId: "w1P",
      tabId: "w1P:tA",
      zoomed: false,
      area: { x: 0, y: 0, width, height },
      focusedPaneId: "w1P:p0",
      panes,
      splits: [],
    });
  }
}

function fixture(
  count: number,
  existingSlots: readonly number[] = [],
): { herdr: FakeAgentsHerdr; lifecycle: AgentsTabLifecycle } {
  const herdr = new FakeAgentsHerdr(count, existingSlots);
  return {
    herdr,
    lifecycle: new AgentsTabLifecycle(herdr, herdr.process),
  };
}

test("creates deterministic balanced no-focus grids for every size from 1 through 16", async () => {
  for (let count = 1; count <= 16; count += 1) {
    const current = fixture(count);
    const evidence = await current.lifecycle.ensure(request(count));
    const plan = planPaneGrid(count);
    assert.equal(evidence.createdTab, true);
    assert.equal(evidence.paneIds.length, count);
    assert.equal(evidence.rowCount, plan.rowCount);
    assert.equal(evidence.columnCount, plan.columnCount);
    assert.equal(current.herdr.createRequests[0]?.focus, false);
    assert.equal(current.herdr.splitRequests.length, count - 1);
    assert.deepEqual(
      current.herdr.splitRequests.map((split) => ({
        direction: split.direction,
        ratio: split.ratio,
      })),
      plan.splits.map((split) => ({
        direction: split.direction,
        ratio: split.ratio,
      })),
    );
    assert.equal(
      current.herdr.splitRequests.every((split) => split.focus === false),
      true,
    );
    assert.equal(current.herdr.metadata.length, count);
  }
});

test("recovers a partial environment-owned grid and repeated ensure is idempotent", async () => {
  const current = fixture(6, [0, 3]);
  const first = await current.lifecycle.ensure({
    ...request(6),
    expectedTabId: "w1P:tA",
    expectedPaneIds: ["w1P:p0", null, null, "w1P:p3", null, null],
  });
  assert.equal(first.createdTab, false);
  assert.equal(first.recovered, true);
  assert.equal(current.herdr.createRequests.length, 0);
  assert.equal(current.herdr.splitRequests.length, 4);

  const splitCount = current.herdr.splitRequests.length;
  const repeated = await current.lifecycle.ensure({
    ...request(6),
    expectedTabId: "w1P:tA",
    expectedPaneIds: first.paneIds,
  });
  assert.deepEqual(repeated.paneIds, first.paneIds);
  assert.equal(current.herdr.splitRequests.length, splitCount);
});

test("fails closed on duplicate slots, extra panes, stale identities, and malformed geometry", async () => {
  const duplicate = fixture(2, [0, 1]);
  duplicate.herdr.panes.push({ ...paneForSlot(1), paneId: "w1P:pF" });
  duplicate.herdr.process.environments.set("w1P:pF", environment(1));
  await assert.rejects(
    duplicate.lifecycle.ensure(request(2)),
    /Multiple panes claim/u,
  );

  const extra = fixture(1, [0]);
  extra.herdr.panes.push({ ...paneForSlot(0), paneId: "w1P:pF" });
  await assert.rejects(extra.lifecycle.ensure(request(1)), /unowned or extra/u);

  const mismatch = fixture(2, [0]);
  await assert.rejects(
    mismatch.lifecycle.ensure({
      ...request(2),
      expectedTabId: "w1P:tB",
      expectedPaneIds: ["w1P:p9", null],
    }),
    AgentsTabRecoveryRequiredError,
  );

  const malformed = fixture(2);
  malformed.herdr.malformedLayout = true;
  await assert.rejects(
    malformed.lifecycle.ensure(request(2)),
    /not contiguous/u,
  );
});
