import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentPaneRestorationController,
  type AgentPaneRestorationPhase,
} from "../src/application/recovery/agent-pane-restoration.ts";
import { AgentsTabLifecycle } from "../src/application/herdr/agents-tab-lifecycle.ts";
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
import type {
  PiAgentLaunchEvidence,
  PiAgentLaunchRequest,
} from "../src/application/ports/pi-agent-launcher.ts";
import {
  createAgentState,
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import { planPaneGrid } from "../src/domain/pane-grid.ts";
import { SqliteControllerRepository } from "../src/infrastructure/controller/sqlite-controller-repository.ts";

const RUN_ID = "run-1";
const OPERATION_ID = RUN_ID;
const SESSION_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
] as const;
const AGENT_IDS = [
  "agent-0",
  "agent-1",
  "agent-2",
  "agent-3",
  "agent-4",
] as const;

function ownership(slot: number, restorationId?: string) {
  return {
    environment: {
      AGENTWORKS_AGENT_ID: AGENT_IDS[slot] ?? "unknown",
      AGENTWORKS_PANE_KIND: "agent",
      AGENTWORKS_PANE_OPERATION_ID: OPERATION_ID,
      AGENTWORKS_RUN_ID: RUN_ID,
      AGENTWORKS_PANE_SLOT: String(slot),
      ...(restorationId === undefined
        ? {}
        : { AGENTWORKS_PANE_RESTORATION_ID: restorationId }),
    },
    tokens: {
      aw_agent: AGENT_IDS[slot] ?? "unknown",
      aw_kind: "agent",
      aw_operation: OPERATION_ID,
      aw_run: RUN_ID,
      aw_slot: String(slot),
      ...(restorationId === undefined ? {} : { aw_restoration: restorationId }),
    },
  };
}

function pane(slot: number, paneId = `w1P:p${String(slot)}`): HerdrPane {
  const owned = ownership(slot);
  return {
    paneId,
    terminalId: `term-${String(slot)}`,
    workspaceId: "w1P",
    tabId: "w1P:tA",
    focused: slot === 0,
    agentStatus: "unknown",
    revision: 1,
    agent: null,
    agentSession: null,
    cwd: `/worktrees/story-${String(slot)}`,
    foregroundCwd: `/worktrees/story-${String(slot)}`,
    label: `Agent ${String(slot)}`,
    title: null,
    terminalTitle: null,
    terminalTitleStripped: null,
    displayAgent: `Agent ${String(slot)}`,
    stateLabels: {},
    tokens: owned.tokens,
  };
}

class FakeProcessEvidence implements PaneProcessEvidenceGateway {
  readonly environments = new Map<string, Readonly<Record<string, string>>>();

  readShellEnvironment(
    paneId: string,
  ): Promise<PaneShellEnvironmentEvidence | null> {
    const environment = this.environments.get(paneId);
    return Promise.resolve(
      environment === undefined
        ? null
        : { paneId, shellPid: 1_000, environment },
    );
  }
}

class RosterHerdr {
  readonly processEvidence = new FakeProcessEvidence();
  readonly splitRequests: HerdrSplitPaneRequest[] = [];
  readonly createRequests: HerdrCreateTabRequest[] = [];
  readonly rosterSize: number;
  panes: HerdrPane[];
  readonly tabs: HerdrTab[];

  constructor(rosterSize = 3, survivingSlots: readonly number[] = [0, 2]) {
    this.rosterSize = rosterSize;
    this.panes = survivingSlots.map((slot) => pane(slot));
    this.tabs =
      survivingSlots.length === 0
        ? []
        : [
            {
              tabId: "w1P:tA",
              workspaceId: "w1P",
              number: 1,
              label: "Pi Agents",
              focused: false,
              paneCount: survivingSlots.length,
              agentStatus: "unknown",
            },
          ];
    for (const slot of survivingSlots) {
      this.processEvidence.environments.set(
        `w1P:p${String(slot)}`,
        ownership(slot).environment,
      );
    }
  }

  listTabs(): Promise<readonly HerdrTab[]> {
    return Promise.resolve(this.tabs);
  }

  listPanes(): Promise<readonly HerdrPane[]> {
    return Promise.resolve(this.panes);
  }

  createTab(request: HerdrCreateTabRequest): Promise<{
    readonly tab: HerdrTab;
    readonly rootPane: HerdrPane;
  }> {
    this.createRequests.push(request);
    if (this.panes.length > 0) {
      return Promise.reject(
        new Error("restoration must not create a second tab"),
      );
    }
    const rootPane = {
      ...pane(0, "w1P:pNew0"),
      cwd: request.cwd,
      foregroundCwd: request.cwd,
    };
    this.panes.push(rootPane);
    this.processEvidence.environments.set(
      rootPane.paneId,
      request.environment ?? {},
    );
    return Promise.resolve({
      tab: {
        tabId: "w1P:tA",
        workspaceId: "w1P",
        number: 1,
        label: request.label,
        focused: false,
        paneCount: 1,
        agentStatus: "unknown",
      },
      rootPane,
    });
  }

  splitPane(request: HerdrSplitPaneRequest): Promise<HerdrPane> {
    this.splitRequests.push(request);
    const slot = Number(request.environment?.AGENTWORKS_PANE_SLOT);
    const restorationId = request.environment?.AGENTWORKS_PANE_RESTORATION_ID;
    const replacement = {
      ...pane(slot, slot === 1 ? "w1P:p9" : `w1P:pR${String(slot)}`),
      tokens: ownership(slot, restorationId).tokens,
    };
    this.panes.push(replacement);
    this.processEvidence.environments.set(
      replacement.paneId,
      request.environment ?? {},
    );
    return Promise.resolve(replacement);
  }

  renameTab(): Promise<void> {
    return Promise.resolve();
  }

  renamePane(paneId: string, label: string): Promise<void> {
    this.panes = this.panes.map((candidate) =>
      candidate.paneId === paneId ? { ...candidate, label } : candidate,
    );
    return Promise.resolve();
  }

  reportPaneMetadata(report: HerdrPaneMetadataReport): Promise<void> {
    this.panes = this.panes.map((candidate) =>
      candidate.paneId === report.paneId
        ? {
            ...candidate,
            tokens: { ...candidate.tokens, ...(report.tokens ?? {}) },
          }
        : candidate,
    );
    return Promise.resolve();
  }

  getPaneLayout(): Promise<HerdrPaneLayout> {
    const plan = planPaneGrid(this.rosterSize);
    const bySlot = new Map(
      this.panes.map((candidate) => [
        Number(candidate.tokens.aw_slot),
        candidate,
      ]),
    );
    return Promise.resolve({
      workspaceId: "w1P",
      tabId: "w1P:tA",
      zoomed: false,
      area: { x: 0, y: 0, width: 120, height: 120 },
      focusedPaneId: "w1P:p0",
      panes: plan.cells.map((cell) => ({
        paneId: bySlot.get(cell.slot)?.paneId ?? "missing",
        focused: cell.slot === 0,
        rect: {
          x: cell.column * (120 / (plan.rowPaneCounts[cell.row] ?? 1)),
          y: cell.row * 60,
          width: 120 / (plan.rowPaneCounts[cell.row] ?? 1),
          height: 60,
        },
      })),
      splits: plan.splits.map((split, index) => ({
        id: `split-${String(index)}`,
        direction: split.direction,
        ratio: split.ratio,
        rect: { x: 0, y: 0, width: 120, height: 120 },
      })),
    });
  }
}

interface Fixture {
  readonly directory: string;
  readonly repository: SqliteControllerRepository;
  readonly write: {
    readonly ownerId: string;
    readonly fencingToken: number;
    readonly now: number;
  };
  readonly herdr: RosterHerdr;
  readonly processes: Map<string, number>;
  readonly preparedSessions: Set<string>;
  readonly launchedWorktrees: Set<string>;
  controller(
    afterPhase?: (
      phase: AgentPaneRestorationPhase,
      agentId: string,
    ) => void | Promise<void>,
    processExists?: (processId: number) => boolean,
  ): AgentPaneRestorationController;
}

function createFixture(
  agentCount = 3,
  survivingSlots: readonly number[] = [0, 2],
  unconfirmedSlots: readonly number[] = [],
): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "agentworks-pane-restore-"));
  const repository = new SqliteControllerRepository(
    join(directory, "controller.sqlite"),
  );
  const lease = repository.acquireLease("controller", 1_000, 10_000);
  const write = {
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    now: 1_100,
  } as const;
  const run = createRunState({
    id: RUN_ID,
    title: "Restore middle pane",
    complexity: "HIGH",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktrees/integration",
    createdAt: 1,
  });
  const rosterAgentIds = AGENT_IDS.slice(0, agentCount);
  const stories = rosterAgentIds.map((_, slot) =>
    createStoryState({
      id: `story-${String(slot)}`,
      runId: RUN_ID,
      title: `Story ${String(slot)}`,
      branchName: `agentworks/run-1/story-${String(slot)}`,
      worktreePath: `/worktrees/story-${String(slot)}`,
      planning: {
        narrative: "Restore safely",
        objective: "Restore safely",
        taskKinds: ["software-development"],
        writable: true,
        scope: { included: ["repo"], excluded: ["secrets"] },
        technologyChoices: ["TypeScript"],
        constraints: ["exact evidence"],
        dependencies: [],
        deliverables: ["restored pane"],
        acceptanceCriteria: ["same session"],
        validation: [{ command: "npm test", expected: "passes" }],
        escalationConditions: ["conflicting evidence"],
      },
      createdAt: 1,
    }),
  );
  const agents = rosterAgentIds.map((agentId, slot) =>
    createAgentState({
      id: agentId,
      runId: RUN_ID,
      roleRuntimeId: `software-development/agent-${String(slot)}`,
      taskId: `story-${String(slot)}`,
      worktreePath: `/worktrees/story-${String(slot)}`,
      createdAt: 1,
    }),
  );
  repository.initializeRun({
    write,
    idempotencyKey: "init",
    request: { command: "init" },
    run,
    stories,
    agents,
    events: [
      {
        eventId: "run-initialized",
        type: "run-initialized",
        entityType: "run",
        entityId: RUN_ID,
        payload: {},
        occurredAt: write.now,
      },
    ],
  });
  for (const [slot, agent] of agents.entries()) {
    repository.materializeAgentLaunch({
      write,
      agent,
      paneId: `w1P:p${String(slot)}`,
      sessionId: SESSION_IDS[slot] ?? SESSION_IDS[0],
      slot,
    });
    if (!unconfirmedSlots.includes(slot)) {
      repository.confirmAgentLaunch({
        write,
        runId: RUN_ID,
        agentId: agent.id,
        paneId: `w1P:p${String(slot)}`,
        sessionId: SESSION_IDS[slot] ?? SESSION_IDS[0],
        processIds: [100 + slot],
        commandSha256: String(slot).repeat(64),
      });
    }
  }
  const herdr = new RosterHerdr(agentCount, survivingSlots);
  const lifecycle = new AgentsTabLifecycle(herdr, herdr.processEvidence);
  const processes = new Map<string, number>(
    survivingSlots.map((slot) => [
      SESSION_IDS[slot] ?? SESSION_IDS[0],
      100 + slot,
    ]),
  );
  const preparedSessions = new Set<string>();
  const launchedWorktrees = new Set<string>();
  const fixture: Fixture = {
    directory,
    repository,
    write,
    herdr,
    processes,
    preparedSessions,
    launchedWorktrees,
    controller(afterPhase, processExists = () => false) {
      let restorationSequence = 0;
      return new AgentPaneRestorationController({
        repository,
        herdr,
        processEvidence: herdr.processEvidence,
        lifecycle,
        resolveRoleLabel: (agent) =>
          Promise.resolve(`Canonical ${agent.roleRuntimeId}`),
        restorationId: () =>
          `restore-missing-${String((restorationSequence += 1))}`,
        processExists,
        ...(afterPhase === undefined
          ? {}
          : {
              afterPhase: (phase, record) => afterPhase(phase, record.agentId),
            }),
        preparation: {
          prepare(input) {
            preparedSessions.add(input.sessionId);
            launchedWorktrees.add(input.agent.worktreePath);
            return Promise.resolve({
              paneId: input.paneId,
              sessionId: input.sessionId,
              requireExistingSession: true,
              task: {
                runId: RUN_ID,
                assignedAgentId: input.agent.id,
                worktreePath: input.agent.worktreePath,
              },
            } as PiAgentLaunchRequest);
          },
        },
        launcher: {
          launch(request): Promise<PiAgentLaunchEvidence> {
            const existing = processes.get(request.sessionId);
            const agentSlot = AGENT_IDS.indexOf(
              request.task.assignedAgentId as (typeof AGENT_IDS)[number],
            );
            const processId = existing ?? 200 + agentSlot;
            processes.set(request.sessionId, processId);
            return Promise.resolve({
              paneId: request.paneId,
              sessionId: request.sessionId,
              processIds: [processId],
              sandbox: {} as PiAgentLaunchEvidence["sandbox"],
              rolePromptPath: "/session/role.md",
              taskPromptPath: "/session/task.md",
              controllerCapabilityPath: "/session/token",
              rolePromptSha256: "a".repeat(64),
              taskPromptSha256: "b".repeat(64),
              commandSha256: "c".repeat(64),
            });
          },
        },
      });
    },
  };
  return fixture;
}

function assertNoDuplicates(fixture: Fixture): void {
  const snapshot = fixture.repository.loadSnapshot(RUN_ID);
  assert.ok(snapshot);
  assert.equal(snapshot.agents.length, 3);
  assert.equal(new Set(snapshot.agents.map((agent) => agent.id)).size, 3);
  assert.equal(
    new Set(snapshot.agents.map((agent) => agent.worktreePath)).size,
    3,
  );
  assert.equal(fixture.herdr.tabs.length, 1);
  assert.equal(fixture.herdr.createRequests.length, 0);
  assert.equal(fixture.herdr.panes.length, 3);
  assert.equal(
    new Set(fixture.herdr.panes.map((entry) => entry.paneId)).size,
    3,
  );
  assert.equal(fixture.processes.size, 3);
  assert.equal(fixture.processes.get(SESSION_IDS[1]), 201);
  assert.deepEqual([...fixture.preparedSessions], [SESSION_IDS[1]]);
  assert.deepEqual([...fixture.launchedWorktrees], ["/worktrees/story-1"]);
}

test("retains an exact live pane when launch confirmation was interrupted", async () => {
  const fixture = createFixture(3, [0, 1, 2], [1]);
  try {
    const result = await fixture.controller().restoreMissingPane({
      runId: RUN_ID,
      workspaceId: "w1P",
      write: fixture.write,
      metadataSequence: 1,
    });

    assert.deepEqual(result, {
      restored: false,
      restorations: [],
      agentId: null,
      slot: null,
      priorPaneId: null,
      replacementPaneId: null,
      sessionId: null,
      processIds: [],
    });
    assert.equal(
      fixture.repository.readAgentLaunch(RUN_ID, "agent-1")?.status,
      "materialized",
    );
    assert.equal(fixture.herdr.splitRequests.length, 0);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("ignores a run-scoped management pane while restoring agent slots", async () => {
  const fixture = createFixture();
  try {
    fixture.herdr.panes.push({
      ...pane(0, "w1P:pM"),
      tabId: "w1P:tM",
      cwd: "/management",
      foregroundCwd: "/management",
      label: "Agentworks Management",
      tokens: {
        aw_kind: "management",
        aw_operation: `management-${RUN_ID}`,
        aw_run: RUN_ID,
      },
    });
    fixture.herdr.processEvidence.environments.set("w1P:pM", {
      AGENTWORKS_PANE_KIND: "management",
      AGENTWORKS_PANE_OPERATION_ID: `management-${RUN_ID}`,
      AGENTWORKS_RUN_ID: RUN_ID,
    });

    const result = await fixture.controller().restoreMissingPane({
      runId: RUN_ID,
      workspaceId: "w1P",
      write: fixture.write,
      metadataSequence: 1,
    });

    assert.equal(result.restored, true);
    assert.equal(result.agentId, "agent-1");
    assert.equal(fixture.herdr.splitRequests.length, 1);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("recreates the dedicated agent tab when every owned pane was restarted", async () => {
  const fixture = createFixture(3, []);
  try {
    const result = await fixture.controller().restoreMissingPane({
      runId: RUN_ID,
      workspaceId: "w1P",
      write: fixture.write,
      metadataSequence: 1,
    });

    assert.equal(result.restored, true);
    assert.equal(result.restorations.length, 3);
    assert.equal(fixture.herdr.createRequests.length, 1);
    assert.equal(fixture.herdr.panes.length, 3);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("restores missing slots 1 and 3 in a five-agent roster without moving surviving slots 0, 2, or 4", async () => {
  const fixture = createFixture(5, [0, 2, 4]);
  try {
    const result = await fixture.controller().restoreMissingPane({
      runId: RUN_ID,
      workspaceId: "w1P",
      write: fixture.write,
      metadataSequence: 1,
    });

    assert.equal(result.restored, true);
    assert.deepEqual(
      result.restorations.map((restoration) => ({
        agentId: restoration.agentId,
        slot: restoration.slot,
        sessionId: restoration.sessionId,
      })),
      [
        { agentId: "agent-1", slot: 1, sessionId: SESSION_IDS[1] },
        { agentId: "agent-3", slot: 3, sessionId: SESSION_IDS[3] },
      ],
    );
    assert.deepEqual(
      fixture.herdr.panes
        .filter((entry) => [0, 2, 4].includes(Number(entry.tokens.aw_slot)))
        .map((entry) => entry.paneId),
      ["w1P:p0", "w1P:p2", "w1P:p4"],
    );
    assert.deepEqual(
      fixture.herdr.splitRequests.map(
        (request) => request.environment?.AGENTWORKS_PANE_SLOT,
      ),
      ["1", "3"],
    );
    assert.equal(fixture.herdr.createRequests.length, 0);
    assert.equal(fixture.herdr.panes.length, 5);
    assert.equal(
      new Set(fixture.herdr.panes.map((entry) => entry.paneId)).size,
      5,
    );
    assert.equal(fixture.processes.size, 5);
    assert.deepEqual(
      [...fixture.preparedSessions],
      [SESSION_IDS[1], SESSION_IDS[3]],
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("restores missing middle slot 1 without moving slots 0 or 2 and reuses the exact Pi session", async () => {
  const fixture = createFixture();
  try {
    const result = await fixture.controller().restoreMissingPane({
      runId: RUN_ID,
      workspaceId: "w1P",
      write: fixture.write,
      metadataSequence: 1,
    });

    assert.deepEqual(result, {
      restored: true,
      restorations: [
        {
          agentId: "agent-1",
          slot: 1,
          priorPaneId: "w1P:p1",
          replacementPaneId: "w1P:p9",
          sessionId: SESSION_IDS[1],
          processIds: [201],
        },
      ],
      agentId: "agent-1",
      slot: 1,
      priorPaneId: "w1P:p1",
      replacementPaneId: "w1P:p9",
      sessionId: SESSION_IDS[1],
      processIds: [201],
    });
    assert.equal(fixture.herdr.splitRequests.length, 1);
    assert.equal(fixture.herdr.splitRequests[0]?.paneId, "w1P:p0");
    assert.equal(
      fixture.herdr.splitRequests[0].environment?.AGENTWORKS_PANE_SLOT,
      "1",
    );
    assert.equal(
      fixture.herdr.panes.find((entry) => entry.tokens.aw_slot === "0")?.paneId,
      "w1P:p0",
    );
    assert.equal(
      fixture.herdr.panes.find((entry) => entry.tokens.aw_slot === "2")?.paneId,
      "w1P:p2",
    );
    assert.equal(
      fixture.repository.readAgentLaunch(RUN_ID, "agent-1")?.sessionId,
      SESSION_IDS[1],
    );
    assert.equal(
      fixture.repository.readAgentPaneRestoration(RUN_ID, "agent-1")?.status,
      "confirmed",
    );
    assertNoDuplicates(fixture);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("reserves the complete missing set atomically before the first Herdr mutation", async () => {
  const fixture = createFixture(5, [0, 2, 4]);
  try {
    let inspected = false;
    await assert.rejects(
      fixture
        .controller((phase) => {
          if (phase !== "reserved" || inspected) return;
          inspected = true;
          assert.equal(fixture.herdr.splitRequests.length, 0);
          const reservations = ["agent-1", "agent-3"].map((agentId) =>
            fixture.repository.readAgentPaneRestoration(RUN_ID, agentId),
          );
          assert.deepEqual(
            reservations.map((reservation) => reservation?.status),
            ["reserved", "reserved"],
          );
          assert.equal(
            new Set(reservations.map((reservation) => reservation?.operationId))
              .size,
            1,
          );
          assert.match(
            reservations[0]?.operationId ?? "",
            /^restore-[a-f0-9]{32}$/u,
          );
          throw new Error("stop after atomic reservation proof");
        })
        .restoreMissingPane({
          runId: RUN_ID,
          workspaceId: "w1P",
          write: fixture.write,
          metadataSequence: 1,
        }),
      /stop after atomic reservation proof/u,
    );
    assert.equal(inspected, true);
    assert.equal(fixture.herdr.splitRequests.length, 0);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("concurrent multi-pane restoration requests coalesce to one exact resource set", async () => {
  const fixture = createFixture(5, [0, 2, 4]);
  try {
    const first = fixture.controller();
    const second = fixture.controller();
    const request = {
      runId: RUN_ID,
      workspaceId: "w1P",
      write: fixture.write,
      metadataSequence: 1,
    } as const;
    const [left, right] = await Promise.all([
      first.restoreMissingPane(request),
      second.restoreMissingPane(request),
    ]);
    assert.deepEqual(left, right);
    assert.equal(left.restorations.length, 2);
    assert.equal(fixture.herdr.splitRequests.length, 2);
    assert.equal(fixture.herdr.panes.length, 5);
    assert.equal(fixture.processes.size, 5);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("multi-agent restoration converges across every per-agent kill point", async () => {
  const phases: readonly AgentPaneRestorationPhase[] = [
    "reserved",
    "pane-created",
    "bound",
    "process-launched",
    "confirmed",
  ];
  for (const killPhase of phases) {
    for (const killAgentId of ["agent-1", "agent-3"] as const) {
      const fixture = createFixture(5, [0, 2, 4]);
      let killed = false;
      try {
        await assert.rejects(
          fixture
            .controller((phase, agentId) => {
              if (!killed && phase === killPhase && agentId === killAgentId) {
                killed = true;
                throw new Error(`kill ${agentId} after ${phase}`);
              }
            })
            .restoreMissingPane({
              runId: RUN_ID,
              workspaceId: "w1P",
              write: fixture.write,
              metadataSequence: 1,
            }),
          new RegExp(`kill ${killAgentId} after ${killPhase}`, "u"),
        );
        assert.equal(killed, true);
        await fixture.controller().restoreMissingPane({
          runId: RUN_ID,
          workspaceId: "w1P",
          write: fixture.write,
          metadataSequence: 1,
        });
        assert.equal(fixture.herdr.createRequests.length, 0);
        assert.equal(fixture.herdr.panes.length, 5);
        assert.equal(
          new Set(fixture.herdr.panes.map((entry) => entry.paneId)).size,
          5,
        );
        assert.equal(fixture.processes.size, 5);
        assert.equal(fixture.repository.loadSnapshot(RUN_ID)?.agents.length, 5);
        assert.deepEqual(
          ["agent-1", "agent-3"].map(
            (agentId) =>
              fixture.repository.readAgentPaneRestoration(RUN_ID, agentId)
                ?.status,
          ),
          ["confirmed", "confirmed"],
        );
      } finally {
        fixture.repository.close();
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  }
});

test("every restoration kill point converges without duplicate tab, pane, process, session, worktree, or agent", async () => {
  const phases: readonly AgentPaneRestorationPhase[] = [
    "reserved",
    "pane-created",
    "bound",
    "process-launched",
    "confirmed",
  ];
  for (const killPhase of phases) {
    const fixture = createFixture();
    let killed = false;
    try {
      await assert.rejects(
        fixture
          .controller((phase) => {
            if (!killed && phase === killPhase) {
              killed = true;
              throw new Error(`kill after ${phase}`);
            }
          })
          .restoreMissingPane({
            runId: RUN_ID,
            workspaceId: "w1P",
            write: fixture.write,
            metadataSequence: 1,
          }),
        new RegExp(`kill after ${killPhase}`, "u"),
      );
      assert.equal(killed, true);
      await fixture.controller().restoreMissingPane({
        runId: RUN_ID,
        workspaceId: "w1P",
        write: fixture.write,
        metadataSequence: 1,
      });
      assert.equal(fixture.herdr.splitRequests.length, 1);
      assertNoDuplicates(fixture);
    } finally {
      fixture.repository.close();
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("multi-pane restoration refuses partial prior-process evidence before reserving any slot", async () => {
  const fixture = createFixture(5, [0, 2, 4]);
  try {
    await assert.rejects(
      fixture
        .controller(undefined, (processId) => processId === 103)
        .restoreMissingPane({
          runId: RUN_ID,
          workspaceId: "w1P",
          write: fixture.write,
          metadataSequence: 1,
        }),
      /prior Pi process evidence is missing, still alive, or identity-indeterminate/u,
    );
    assert.equal(fixture.herdr.splitRequests.length, 0);
    assert.equal(
      fixture.repository.readAgentPaneRestoration(RUN_ID, "agent-1"),
      null,
    );
    assert.equal(
      fixture.repository.readAgentPaneRestoration(RUN_ID, "agent-3"),
      null,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("restoration refuses a mixed partial reservation set before Herdr mutation", async () => {
  const fixture = createFixture(5, [0, 2, 4]);
  try {
    fixture.repository.reserveAgentPaneRestoration({
      write: fixture.write,
      runId: RUN_ID,
      agentId: "agent-1",
      restorationId: "partial-reservation",
      operationId: "mixed-operation",
      slot: 1,
      priorPaneId: "w1P:p1",
      sessionId: SESSION_IDS[1],
    });
    await assert.rejects(
      fixture.controller().restoreMissingPane({
        runId: RUN_ID,
        workspaceId: "w1P",
        write: fixture.write,
        metadataSequence: 1,
      }),
      /mixed with an unreserved pane loss/u,
    );
    assert.equal(fixture.herdr.splitRequests.length, 0);
    assert.equal(
      fixture.repository.readAgentPaneRestoration(RUN_ID, "agent-3"),
      null,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("restoration refuses an unowned pane in the exact agent tab before splitting", async () => {
  const fixture = createFixture(5, [0, 2, 4]);
  try {
    fixture.herdr.panes.push({
      ...pane(0, "w1P:pX"),
      cwd: "/unowned",
      foregroundCwd: "/unowned",
      tokens: {},
    });
    await assert.rejects(
      fixture.controller().restoreMissingPane({
        runId: RUN_ID,
        workspaceId: "w1P",
        write: fixture.write,
        metadataSequence: 1,
      }),
      /ambiguous or unowned pane identity/u,
    );
    assert.equal(fixture.herdr.splitRequests.length, 0);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("restoration refuses a still-live prior Pi process before creating a replacement", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      fixture
        .controller(undefined, (processId) => processId === 101)
        .restoreMissingPane({
          runId: RUN_ID,
          workspaceId: "w1P",
          write: fixture.write,
          metadataSequence: 1,
        }),
      /prior Pi process evidence is missing, still alive, or identity-indeterminate/u,
    );
    assert.equal(fixture.herdr.splitRequests.length, 0);
    assert.equal(
      fixture.repository.readAgentPaneRestoration(RUN_ID, "agent-1"),
      null,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("restoration refuses spoofed replacement evidence without mutating controller authority", async () => {
  const fixture = createFixture();
  try {
    fixture.herdr.panes.push({
      ...pane(1, "w1P:p9"),
      tokens: { ...ownership(1).tokens, aw_restoration: "spoofed" },
    });
    fixture.herdr.processEvidence.environments.set("w1P:p9", {
      ...ownership(1).environment,
      AGENTWORKS_PANE_RESTORATION_ID: "spoofed",
    });
    await assert.rejects(
      fixture.controller().restoreMissingPane({
        runId: RUN_ID,
        workspaceId: "w1P",
        write: fixture.write,
        metadataSequence: 1,
      }),
      /conflicts with controller pane authority/u,
    );
    assert.equal(fixture.herdr.splitRequests.length, 0);
    assert.equal(
      fixture.repository.readAgentLaunch(RUN_ID, "agent-1")?.paneId,
      "w1P:p1",
    );
    assert.equal(
      fixture.repository.readAgentPaneRestoration(RUN_ID, "agent-1"),
      null,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
