import assert from "node:assert/strict";
import test from "node:test";
import type {
  HerdrPane,
  HerdrPaneLayout,
  HerdrPaneMetadataReport,
  HerdrSplitPaneRequest,
} from "../src/application/ports/herdr-gateway.ts";
import type {
  PaneProcessEvidenceGateway,
  PaneShellEnvironmentEvidence,
} from "../src/application/ports/pane-process-evidence.ts";
import {
  ManagementPaneLifecycle,
  ManagementPaneRecoveryRequiredError,
  type EnsureManagementPaneRequest,
} from "../src/application/herdr/management-pane-lifecycle.ts";
import { LinuxPaneProcessEvidenceGateway } from "../src/infrastructure/herdr/linux-pane-process-evidence.ts";

function pane(paneId: string, overrides: Partial<HerdrPane> = {}): HerdrPane {
  return {
    paneId,
    terminalId: `term-${paneId}`,
    workspaceId: "w1P",
    tabId: "w1P:t2",
    focused: paneId === "w1P:p1",
    agentStatus: "unknown",
    revision: 0,
    agent: null,
    agentSession: null,
    cwd: "/worktrees/integration",
    foregroundCwd: "/worktrees/integration",
    label: null,
    title: null,
    terminalTitle: null,
    terminalTitleStripped: null,
    displayAgent: null,
    stateLabels: {},
    tokens: {},
    ...overrides,
  };
}

const OWNERSHIP_ENVIRONMENT = {
  AGENTWORKS_PANE_KIND: "management",
  AGENTWORKS_PANE_OPERATION_ID: "manage-op-1",
  AGENTWORKS_PARENT_PANE_ID: "w1P:p1",
  AGENTWORKS_RUN_ID: "run-1",
};

const REQUEST: EnsureManagementPaneRequest = {
  runId: "run-1",
  operationId: "manage-op-1",
  workspaceId: "w1P",
  parentTabId: "w1P:t2",
  parentPaneId: "w1P:p1",
  expectedPaneId: null,
  cwd: "/worktrees/integration",
  splitRatio: 0.34,
  metadataSequence: 7,
};

class FakeProcessEvidence implements PaneProcessEvidenceGateway {
  readonly environments = new Map<string, Readonly<Record<string, string>>>();

  readShellEnvironment(
    paneId: string,
  ): Promise<PaneShellEnvironmentEvidence | null> {
    const environment = this.environments.get(paneId);
    return Promise.resolve(
      environment === undefined
        ? null
        : {
            paneId,
            shellPid: paneId === "w1P:p2" ? 202 : 303,
            environment,
          },
    );
  }
}

class FakeManagementHerdr {
  panes: HerdrPane[];
  readonly processEvidence: FakeProcessEvidence;
  readonly splitRequests: HerdrSplitPaneRequest[] = [];
  readonly renames: { paneId: string; label: string }[] = [];
  readonly metadata: HerdrPaneMetadataReport[] = [];
  readonly listWorkspaceIds: (string | undefined)[] = [];
  layoutIsAdjacent = true;

  constructor(panes: HerdrPane[], processEvidence: FakeProcessEvidence) {
    this.panes = panes;
    this.processEvidence = processEvidence;
  }

  listPanes(workspaceId?: string): Promise<readonly HerdrPane[]> {
    this.listWorkspaceIds.push(workspaceId);
    return Promise.resolve(
      this.panes.filter(
        (candidate) =>
          workspaceId === undefined || candidate.workspaceId === workspaceId,
      ),
    );
  }

  splitPane(request: HerdrSplitPaneRequest): Promise<HerdrPane> {
    this.splitRequests.push(request);
    const created = pane("w1P:p2");
    this.panes.push(created);
    this.processEvidence.environments.set(
      created.paneId,
      Object.freeze({ ...(request.environment ?? {}) }),
    );
    return Promise.resolve(created);
  }

  renamePane(paneId: string, label: string): Promise<void> {
    this.renames.push({ paneId, label });
    this.panes = this.panes.map((candidate) =>
      candidate.paneId === paneId ? { ...candidate, label } : candidate,
    );
    return Promise.resolve();
  }

  reportPaneMetadata(report: HerdrPaneMetadataReport): Promise<void> {
    this.metadata.push(report);
    this.panes = this.panes.map((candidate) =>
      candidate.paneId === report.paneId
        ? {
            ...candidate,
            title: report.title ?? candidate.title,
            displayAgent: report.displayAgent ?? candidate.displayAgent,
            tokens: { ...candidate.tokens, ...(report.tokens ?? {}) },
          }
        : candidate,
    );
    return Promise.resolve();
  }

  getPaneLayout(): Promise<HerdrPaneLayout> {
    const parent = this.panes.find(
      (candidate) => candidate.paneId === "w1P:p1",
    );
    const management = this.panes.find(
      (candidate) => candidate.paneId === "w1P:p2",
    );
    const parentWidth = management === undefined ? 100 : 66;
    return Promise.resolve({
      workspaceId: "w1P",
      tabId: "w1P:t2",
      zoomed: false,
      area: { x: 0, y: 0, width: 100, height: 80 },
      focusedPaneId: parent?.paneId ?? "w1P:p1",
      panes: [
        ...(parent === undefined
          ? []
          : [
              {
                paneId: parent.paneId,
                focused: true,
                rect: { x: 0, y: 0, width: parentWidth, height: 80 },
              },
            ]),
        ...(management === undefined
          ? []
          : [
              {
                paneId: management.paneId,
                focused: false,
                rect: {
                  x: this.layoutIsAdjacent ? 66 : 70,
                  y: 0,
                  width: 34,
                  height: 80,
                },
              },
            ]),
      ],
      splits: [],
    });
  }
}

function lifecycle(panes: HerdrPane[] = [pane("w1P:p1")]): {
  herdr: FakeManagementHerdr;
  process: FakeProcessEvidence;
  lifecycle: ManagementPaneLifecycle;
} {
  const process = new FakeProcessEvidence();
  const herdr = new FakeManagementHerdr(panes, process);
  return {
    herdr,
    process,
    lifecycle: new ManagementPaneLifecycle(herdr, process),
  };
}

test("creates one no-focus right management pane with atomic environment ownership", async () => {
  const fixture = lifecycle();
  const evidence = await fixture.lifecycle.ensure(REQUEST);

  assert.deepEqual(evidence, {
    paneId: "w1P:p2",
    workspaceId: "w1P",
    tabId: "w1P:t2",
    parentPaneId: "w1P:p1",
    shellPid: 202,
    created: true,
    recovered: false,
  });
  assert.deepEqual(fixture.herdr.splitRequests, [
    {
      paneId: "w1P:p1",
      direction: "right",
      ratio: 0.34,
      cwd: "/worktrees/integration",
      environment: OWNERSHIP_ENVIRONMENT,
      focus: false,
    },
  ]);
  assert.deepEqual(fixture.herdr.renames, [
    { paneId: "w1P:p2", label: "Agentworks · Manage" },
  ]);
  assert.deepEqual(fixture.herdr.metadata[0], {
    paneId: "w1P:p2",
    source: "agentworks:controller",
    sequence: 7,
    title: "Agentworks · Manage",
    displayAgent: "Agentworks",
    tokens: {
      aw_kind: "management",
      aw_operation: "manage-op-1",
      aw_parent: "w1P:p1",
      aw_run: "run-1",
    },
  });
});

test("recovers a split interrupted before rename or metadata and remains idempotent", async () => {
  const fixture = lifecycle([pane("w1P:p1"), pane("w1P:p2")]);
  fixture.process.environments.set("w1P:p2", OWNERSHIP_ENVIRONMENT);

  const recovered = await fixture.lifecycle.ensure({
    ...REQUEST,
    expectedPaneId: "w1P:p2",
  });
  assert.equal(recovered.created, false);
  assert.equal(recovered.recovered, true);
  assert.equal(fixture.herdr.splitRequests.length, 0);
  assert.equal(fixture.herdr.metadata.length, 1);

  const repeated = await fixture.lifecycle.ensure({
    ...REQUEST,
    expectedPaneId: "w1P:p2",
  });
  assert.equal(repeated.paneId, "w1P:p2");
  assert.equal(fixture.herdr.splitRequests.length, 0);
});

test("globally rejects duplicate operation ownership before splitting", async () => {
  const fixture = lifecycle([
    pane("w1P:p1"),
    pane("w1P:p2"),
    pane("w9X:p7", {
      workspaceId: "w9X",
      tabId: "w9X:t4",
      focused: false,
    }),
  ]);
  fixture.process.environments.set("w1P:p2", OWNERSHIP_ENVIRONMENT);
  fixture.process.environments.set("w9X:p7", OWNERSHIP_ENVIRONMENT);

  await assert.rejects(
    fixture.lifecycle.ensure(REQUEST),
    /Multiple Herdr panes claim the same management operation/u,
  );
  assert.deepEqual(fixture.herdr.listWorkspaceIds, [undefined]);
  assert.equal(fixture.herdr.splitRequests.length, 0);
  assert.equal(fixture.herdr.renames.length, 0);
  assert.equal(fixture.herdr.metadata.length, 0);
});

test("rejects interrupted ownership with parent or pane-location drift before splitting", async () => {
  const processDrift = lifecycle([pane("w1P:p1"), pane("w1P:p2")]);
  processDrift.process.environments.set("w1P:p2", {
    ...OWNERSHIP_ENVIRONMENT,
    AGENTWORKS_PARENT_PANE_ID: "w1P:p9",
  });
  await assert.rejects(
    processDrift.lifecycle.ensure(REQUEST),
    /process ownership has parent-origin drift/u,
  );
  assert.equal(processDrift.herdr.splitRequests.length, 0);

  const metadataDrift = lifecycle([
    pane("w1P:p1"),
    pane("w1P:p2", {
      tokens: {
        aw_kind: "management",
        aw_operation: "manage-op-1",
        aw_parent: "w1P:p9",
        aw_run: "run-1",
      },
    }),
  ]);
  metadataDrift.process.environments.set("w1P:p2", OWNERSHIP_ENVIRONMENT);
  await assert.rejects(
    metadataDrift.lifecycle.ensure(REQUEST),
    /metadata has parent-origin drift/u,
  );
  assert.equal(metadataDrift.herdr.splitRequests.length, 0);

  const movedSplit = lifecycle([
    pane("w1P:p1"),
    pane("w1P:p2", { tabId: "w1P:t3" }),
  ]);
  movedSplit.process.environments.set("w1P:p2", OWNERSHIP_ENVIRONMENT);
  await assert.rejects(
    movedSplit.lifecycle.ensure(REQUEST),
    /identity or working directory does not match/u,
  );
  assert.equal(movedSplit.herdr.splitRequests.length, 0);

  const movedParent = lifecycle([pane("w1P:p1", { tabId: "w1P:t3" })]);
  await assert.rejects(
    movedParent.lifecycle.ensure(REQUEST),
    /controller-recorded parent Herdr pane is absent or has moved/u,
  );
  assert.equal(movedParent.herdr.splitRequests.length, 0);
});

test("fails closed on ownership spoofing, duplicate claims, stale controller identity, and moved layouts", async () => {
  const tokenSpoof = lifecycle([
    pane("w1P:p1"),
    pane("w1P:p2", {
      tokens: {
        aw_kind: "management",
        aw_operation: "manage-op-1",
        aw_parent: "w1P:p1",
        aw_run: "run-1",
      },
    }),
  ]);
  await assert.rejects(
    tokenSpoof.lifecycle.ensure(REQUEST),
    /metadata without matching process ownership/u,
  );

  const duplicate = lifecycle([pane("w1P:p1"), pane("w1P:p2"), pane("w1P:p3")]);
  duplicate.process.environments.set("w1P:p2", OWNERSHIP_ENVIRONMENT);
  duplicate.process.environments.set("w1P:p3", OWNERSHIP_ENVIRONMENT);
  await assert.rejects(
    duplicate.lifecycle.ensure(REQUEST),
    /Multiple Herdr panes/u,
  );

  const mismatch = lifecycle([pane("w1P:p1"), pane("w1P:p2")]);
  mismatch.process.environments.set("w1P:p2", OWNERSHIP_ENVIRONMENT);
  await assert.rejects(
    mismatch.lifecycle.ensure({ ...REQUEST, expectedPaneId: "w1P:p9" }),
    /disagrees with controller state/u,
  );

  const moved = lifecycle([pane("w1P:p1"), pane("w1P:p2")]);
  moved.process.environments.set("w1P:p2", OWNERSHIP_ENVIRONMENT);
  moved.herdr.layoutIsAdjacent = false;
  await assert.rejects(
    moved.lifecycle.ensure(REQUEST),
    ManagementPaneRecoveryRequiredError,
  );
});

test("Linux pane evidence binds a bounded environment read to a stable shell process", async () => {
  const processInfo = {
    paneId: "w1P:p1",
    shellPid: process.pid,
    foregroundProcessGroupId: null,
    tty: null,
    foregroundProcesses: [],
  };
  const reader = new LinuxPaneProcessEvidenceGateway({
    getPaneProcessInfo: () => Promise.resolve(processInfo),
  });
  const evidence = await reader.readShellEnvironment("w1P:p1");
  assert.ok(evidence);
  assert.equal(evidence.shellPid, process.pid);
  assert.equal(typeof evidence.environment.PATH, "string");
});
