import { randomUUID } from "node:crypto";
import type {
  AgentLaunchRecord,
  AgentPaneRestorationRecord,
  ConfirmAgentLaunchInput,
  ConfirmAgentPaneRestorationInput,
  ControllerRepository,
  ControllerSnapshot,
  FencedWrite,
} from "../ports/controller-repository.ts";
import type { HerdrGateway, HerdrPane } from "../ports/herdr-gateway.ts";
import type {
  PaneProcessEvidenceGateway,
  PaneShellEnvironmentEvidence,
} from "../ports/pane-process-evidence.ts";
import type {
  PiAgentLaunchRequest,
  PiAgentLauncher,
} from "../ports/pi-agent-launcher.ts";
import type {
  AgentPaneAssignment,
  AgentsTabLifecycle,
} from "../herdr/agents-tab-lifecycle.ts";
import type { AgentState } from "../../domain/controller-state.ts";
import {
  agentsNeedingRestoration,
  assessAgentConnections,
} from "../../domain/agent-connection.ts";

const ACTIVE_AGENT_STATUSES: ReadonlySet<AgentState["status"]> = new Set([
  "launching",
  "idle",
  "working",
  "waiting",
  "blocked",
  "reviewing",
  "disconnected",
]);

const ENVIRONMENT = Object.freeze({
  agent: "AGENTWORKS_AGENT_ID",
  kind: "AGENTWORKS_PANE_KIND",
  operation: "AGENTWORKS_PANE_OPERATION_ID",
  restoration: "AGENTWORKS_PANE_RESTORATION_ID",
  run: "AGENTWORKS_RUN_ID",
  slot: "AGENTWORKS_PANE_SLOT",
});

export type AgentPaneRestorationPhase =
  "reserved" | "pane-created" | "bound" | "process-launched" | "confirmed";

export interface AgentPaneRestorationLaunchPreparer {
  prepare(input: {
    readonly snapshot: ControllerSnapshot;
    readonly agent: AgentState;
    readonly paneId: string;
    readonly sessionId: string;
  }): Promise<PiAgentLaunchRequest>;
}

export interface AgentPaneRestorationResult {
  readonly restored: boolean;
  readonly agentId: string | null;
  readonly slot: number | null;
  readonly priorPaneId: string | null;
  readonly replacementPaneId: string | null;
  readonly sessionId: string | null;
  readonly processIds: readonly number[];
}

export type RestorationRepository = Required<
  Pick<
    ControllerRepository,
    | "bindAgentPaneRestoration"
    | "confirmAgentLaunch"
    | "confirmAgentPaneRestoration"
    | "loadSnapshot"
    | "readAgentLaunch"
    | "readAgentPaneRestoration"
    | "reserveAgentPaneRestoration"
  >
>;

type RestorationHerdrGateway = Pick<HerdrGateway, "listPanes">;

interface RosterEntry {
  readonly agent: AgentState;
  readonly launch: AgentLaunchRecord;
  readonly restoration: AgentPaneRestorationRecord | null;
}

interface StrictOwnedPane {
  readonly pane: HerdrPane;
  readonly process: PaneShellEnvironmentEvidence;
  readonly agentId: string;
  readonly slot: number;
}

export interface AgentPaneRestorationControllerDependencies {
  readonly repository: RestorationRepository;
  readonly herdr: RestorationHerdrGateway;
  readonly processEvidence: PaneProcessEvidenceGateway;
  readonly lifecycle: Pick<AgentsTabLifecycle, "ensure">;
  readonly launcher: PiAgentLauncher;
  readonly preparation: AgentPaneRestorationLaunchPreparer;
  readonly resolveLabel?: (agent: AgentState) => Promise<string>;
  readonly restorationId?: () => string;
  readonly processExists?: (processId: number) => boolean;
  readonly afterPhase?: (
    phase: AgentPaneRestorationPhase,
    record: AgentPaneRestorationRecord,
  ) => void | Promise<void>;
}

export interface RestoreMissingAgentPaneRequest {
  readonly runId: string;
  readonly workspaceId: string;
  readonly write: FencedWrite;
  readonly metadataSequence: number;
}

export class AgentPaneRestorationError extends Error {
  constructor(message: string) {
    super(`Agent pane restoration failed: ${message}`);
    this.name = "AgentPaneRestorationError";
  }
}

const inFlightRestorations = new WeakMap<
  object,
  Map<string, Promise<AgentPaneRestorationResult>>
>();

function roleLabel(runtimeId: string): string {
  const roleId = runtimeId.split("/").at(-1) ?? runtimeId;
  return roleId
    .split(/[-_]/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function exactSlot(value: string | undefined): number | null {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return null;
  }
  const slot = Number(value);
  return Number.isSafeInteger(slot) ? slot : null;
}

function emptyResult(): AgentPaneRestorationResult {
  return Object.freeze({
    restored: false,
    agentId: null,
    slot: null,
    priorPaneId: null,
    replacementPaneId: null,
    sessionId: null,
    processIds: Object.freeze([]),
  });
}

export class AgentPaneRestorationController {
  readonly #repository: RestorationRepository;
  readonly #herdr: RestorationHerdrGateway;
  readonly #processEvidence: PaneProcessEvidenceGateway;
  readonly #lifecycle: Pick<AgentsTabLifecycle, "ensure">;
  readonly #launcher: PiAgentLauncher;
  readonly #preparation: AgentPaneRestorationLaunchPreparer;
  readonly #resolveLabel: (agent: AgentState) => Promise<string>;
  readonly #restorationId: () => string;
  readonly #processExists: (processId: number) => boolean;
  readonly #afterPhase: NonNullable<
    AgentPaneRestorationControllerDependencies["afterPhase"]
  >;

  constructor(dependencies: AgentPaneRestorationControllerDependencies) {
    this.#repository = dependencies.repository;
    this.#herdr = dependencies.herdr;
    this.#processEvidence = dependencies.processEvidence;
    this.#lifecycle = dependencies.lifecycle;
    this.#launcher = dependencies.launcher;
    this.#preparation = dependencies.preparation;
    this.#resolveLabel =
      dependencies.resolveLabel ??
      ((agent) => Promise.resolve(roleLabel(agent.roleRuntimeId)));
    this.#restorationId = dependencies.restorationId ?? randomUUID;
    this.#processExists =
      dependencies.processExists ??
      ((processId) => {
        try {
          process.kill(processId, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      });
    this.#afterPhase = dependencies.afterPhase ?? (() => undefined);
  }

  restoreMissingPane(
    request: RestoreMissingAgentPaneRequest,
  ): Promise<AgentPaneRestorationResult> {
    let operations = inFlightRestorations.get(this.#repository);
    if (operations === undefined) {
      operations = new Map();
      inFlightRestorations.set(this.#repository, operations);
    }
    const key = `${request.runId}\0${request.workspaceId}`;
    const existing = operations.get(key);
    if (existing !== undefined) return existing;
    const operation = this.#restoreOnce(request).finally(() => {
      if (operations.get(key) === operation) operations.delete(key);
    });
    operations.set(key, operation);
    return operation;
  }

  async #restoreOnce(
    request: RestoreMissingAgentPaneRequest,
  ): Promise<AgentPaneRestorationResult> {
    if (
      !Number.isSafeInteger(request.metadataSequence) ||
      request.metadataSequence < 0
    ) {
      throw new AgentPaneRestorationError(
        "metadata sequence must be a non-negative safe integer",
      );
    }
    const snapshot = this.#repository.loadSnapshot(request.runId);
    if (snapshot === null) {
      throw new AgentPaneRestorationError("controller run is unavailable");
    }
    const roster = this.#roster(snapshot);
    if (roster.length === 0) return emptyResult();
    const panes = await this.#herdr.listPanes(request.workspaceId);
    const owned = await this.#strictOwnedPanes(request, roster, panes);

    const pendingBound = roster.find(
      (entry) =>
        entry.restoration?.status === "bound" &&
        entry.restoration.replacementPaneId === entry.launch.paneId,
    );
    if (pendingBound !== undefined) {
      const restoration = pendingBound.restoration;
      if (restoration?.replacementPaneId == null) {
        throw new AgentPaneRestorationError(
          "bound restoration evidence is incomplete",
        );
      }
      const pane = owned.find(
        (candidate) =>
          candidate.agentId === pendingBound.agent.id &&
          candidate.pane.paneId === restoration.replacementPaneId &&
          candidate.slot === restoration.slot,
      );
      if (pane === undefined) {
        throw new AgentPaneRestorationError(
          "bound replacement pane is absent or has conflicting ownership",
        );
      }
      return this.#launchBound(request, snapshot, pendingBound, restoration);
    }

    const surviving = owned.filter((candidate) => {
      const entry = roster.find((item) => item.agent.id === candidate.agentId);
      return entry?.launch.paneId === candidate.pane.paneId;
    });
    const assessments = agentsNeedingRestoration(
      assessAgentConnections(
        roster.map((entry) => ({
          agentId: entry.agent.id,
          paneId: entry.launch.paneId,
          ownershipToken: entry.agent.id,
          sessionPresent: entry.launch.sessionId.length > 0,
          status: entry.agent.status,
        })),
        surviving.map((candidate) => ({
          paneId: candidate.pane.paneId,
          ownershipToken: candidate.agentId,
        })),
      ),
    );
    const missing = assessments.map((assessment) => {
      if (assessment.restoration !== "resume-session") {
        throw new AgentPaneRestorationError(
          `agent ${assessment.agentId} lacks exact reusable Pi session evidence`,
        );
      }
      const entry = roster.find(
        (candidate) => candidate.agent.id === assessment.agentId,
      );
      if (entry === undefined) {
        throw new AgentPaneRestorationError(
          "pane-loss assessment returned an unknown controller agent",
        );
      }
      return entry;
    });
    if (missing.length === 0) return emptyResult();
    if (missing.length !== 1 || surviving.length !== roster.length - 1) {
      throw new AgentPaneRestorationError(
        "exactly one controller-owned pane must be missing",
      );
    }
    const target = missing[0];
    if (target === undefined) {
      throw new AgentPaneRestorationError("missing roster target disappeared");
    }
    if (panes.some((pane) => pane.paneId === target.launch.paneId)) {
      throw new AgentPaneRestorationError(
        "controller pane id still exists without exact ownership evidence",
      );
    }
    if (
      target.launch.processIds.length === 0 ||
      target.launch.processIds.some((processId) =>
        this.#processExists(processId),
      )
    ) {
      throw new AgentPaneRestorationError(
        "prior Pi process evidence is missing, still alive, or identity-indeterminate",
      );
    }
    const occupiedSlots = new Set(surviving.map((candidate) => candidate.slot));
    if (
      occupiedSlots.size !== surviving.length ||
      [...occupiedSlots].some((slot) => slot < 0 || slot >= roster.length)
    ) {
      throw new AgentPaneRestorationError(
        "surviving pane slots are duplicate or outside the controller roster",
      );
    }
    const holes = Array.from(
      { length: roster.length },
      (_, slot) => slot,
    ).filter((slot) => !occupiedSlots.has(slot));
    if (holes.length !== 1) {
      throw new AgentPaneRestorationError(
        "surviving panes do not prove one exact missing slot",
      );
    }
    const slot = holes[0];
    if (slot === undefined) {
      throw new AgentPaneRestorationError("missing slot disappeared");
    }
    const tabIds = new Set(owned.map((candidate) => candidate.pane.tabId));
    if (tabIds.size !== 1) {
      throw new AgentPaneRestorationError(
        "surviving controller panes do not prove one exact Herdr tab",
      );
    }
    const existingReservation = target.restoration;
    const reservation = this.#repository.reserveAgentPaneRestoration({
      write: request.write,
      runId: request.runId,
      agentId: target.agent.id,
      restorationId:
        existingReservation?.restorationId ?? this.#restorationId(),
      operationId: request.runId,
      slot,
      priorPaneId: target.launch.paneId,
      sessionId: target.launch.sessionId,
    });
    await this.#afterPhase("reserved", reservation);

    const labels = new Map(
      await Promise.all(
        roster.map(async (entry) => {
          const label = (await this.#resolveLabel(entry.agent)).trim();
          if (label.length === 0) {
            throw new AgentPaneRestorationError(
              `agent ${entry.agent.id} has no canonical role label`,
            );
          }
          return [entry.agent.id, label] as const;
        }),
      ),
    );
    const assignments: AgentPaneAssignment[] = Array.from({
      length: roster.length,
    });
    const expectedPaneIds: (string | null)[] = Array.from(
      {
        length: roster.length,
      },
      () => null,
    );
    for (const candidate of surviving) {
      const entry = roster.find((item) => item.agent.id === candidate.agentId);
      if (entry === undefined) {
        throw new AgentPaneRestorationError(
          "surviving pane is absent from the controller roster",
        );
      }
      assignments[candidate.slot] = {
        agentId: entry.agent.id,
        label: labels.get(entry.agent.id) ?? "",
        cwd: entry.agent.worktreePath,
      };
      expectedPaneIds[candidate.slot] = entry.launch.paneId;
    }
    assignments[slot] = {
      agentId: target.agent.id,
      label: labels.get(target.agent.id) ?? "",
      cwd: target.agent.worktreePath,
      restorationId: reservation.restorationId,
    };
    const evidence = await this.#lifecycle.ensure({
      runId: request.runId,
      operationId: reservation.operationId,
      workspaceId: request.workspaceId,
      expectedTabId: [...tabIds][0] ?? null,
      expectedPaneIds,
      assignments,
      metadataSequence: request.metadataSequence,
    });
    const replacementPaneId = evidence.paneIds[slot];
    if (
      replacementPaneId === undefined ||
      replacementPaneId === reservation.priorPaneId
    ) {
      throw new AgentPaneRestorationError(
        "Herdr did not create a distinct pane in the reserved slot",
      );
    }
    for (const candidate of surviving) {
      if (evidence.paneIds[candidate.slot] !== candidate.pane.paneId) {
        throw new AgentPaneRestorationError(
          "restoration moved or adopted a surviving controller pane",
        );
      }
    }
    await this.#afterPhase("pane-created", reservation);
    const bound = this.#repository.bindAgentPaneRestoration({
      write: request.write,
      runId: request.runId,
      agentId: target.agent.id,
      restorationId: reservation.restorationId,
      replacementPaneId,
    });
    await this.#afterPhase("bound", bound);
    const reboundSnapshot = this.#repository.loadSnapshot(request.runId);
    if (reboundSnapshot === null) {
      throw new AgentPaneRestorationError(
        "controller snapshot disappeared after restoration binding",
      );
    }
    const reboundAgent = reboundSnapshot.agents.find(
      (agent) => agent.id === target.agent.id,
    );
    if (reboundAgent === undefined) {
      throw new AgentPaneRestorationError(
        "controller agent disappeared after restoration binding",
      );
    }
    return this.#launchBound(
      request,
      reboundSnapshot,
      { ...target, agent: reboundAgent },
      bound,
    );
  }

  #roster(snapshot: ControllerSnapshot): readonly RosterEntry[] {
    const entries: RosterEntry[] = [];
    for (const agent of snapshot.agents) {
      if (!ACTIVE_AGENT_STATUSES.has(agent.status)) continue;
      const launch = this.#repository.readAgentLaunch(
        snapshot.run.id,
        agent.id,
      );
      if (launch === null) {
        throw new AgentPaneRestorationError(
          `active agent ${agent.id} has no durable launch record`,
        );
      }
      if (agent.paneId !== null && launch.paneId !== agent.paneId) {
        throw new AgentPaneRestorationError(
          `agent ${agent.id} pane authority conflicts with its launch record`,
        );
      }
      if (agent.paneId === null && agent.status !== "disconnected") {
        throw new AgentPaneRestorationError(
          `active agent ${agent.id} lacks controller pane authority`,
        );
      }
      const restoration = this.#repository.readAgentPaneRestoration(
        snapshot.run.id,
        agent.id,
      );
      if (restoration === null && launch.status !== "confirmed") {
        throw new AgentPaneRestorationError(
          `agent ${agent.id} launch is not confirmed for pane restoration`,
        );
      }
      entries.push(Object.freeze({ agent, launch, restoration }));
    }
    return Object.freeze(entries);
  }

  async #strictOwnedPanes(
    request: RestoreMissingAgentPaneRequest,
    roster: readonly RosterEntry[],
    panes: readonly HerdrPane[],
  ): Promise<readonly StrictOwnedPane[]> {
    const owned: StrictOwnedPane[] = [];
    for (const pane of panes) {
      const process = await this.#processEvidence.readShellEnvironment(
        pane.paneId,
      );
      const environment = process?.environment ?? {};
      const related =
        pane.tokens.aw_run === request.runId ||
        environment[ENVIRONMENT.run] === request.runId;
      if (!related) continue;
      const agentId = pane.tokens.aw_agent;
      const slot = exactSlot(pane.tokens.aw_slot);
      const processSlot = exactSlot(environment[ENVIRONMENT.slot]);
      if (
        process === null ||
        pane.tokens.aw_kind !== "agent" ||
        pane.tokens.aw_operation !== request.runId ||
        agentId === undefined ||
        slot === null ||
        environment[ENVIRONMENT.kind] !== "agent" ||
        environment[ENVIRONMENT.operation] !== request.runId ||
        environment[ENVIRONMENT.agent] !== agentId ||
        processSlot !== slot
      ) {
        throw new AgentPaneRestorationError(
          `pane ${pane.paneId} has stale, conflicting, or spoofed ownership evidence`,
        );
      }
      const entry = roster.find((candidate) => candidate.agent.id === agentId);
      if (entry?.agent.worktreePath !== pane.cwd) {
        throw new AgentPaneRestorationError(
          `pane ${pane.paneId} is absent from the exact controller roster`,
        );
      }
      if (pane.paneId !== entry.launch.paneId) {
        const restoration = entry.restoration;
        if (
          restoration?.status !== "reserved" ||
          restoration.replacementPaneId !== null ||
          restoration.slot !== slot ||
          pane.tokens.aw_restoration !== restoration.restorationId ||
          environment[ENVIRONMENT.restoration] !== restoration.restorationId
        ) {
          throw new AgentPaneRestorationError(
            `pane ${pane.paneId} conflicts with controller pane authority`,
          );
        }
      } else if (entry.restoration?.replacementPaneId === pane.paneId) {
        if (
          pane.tokens.aw_restoration !== entry.restoration.restorationId ||
          environment[ENVIRONMENT.restoration] !==
            entry.restoration.restorationId
        ) {
          throw new AgentPaneRestorationError(
            `pane ${pane.paneId} lacks its durable restoration nonce`,
          );
        }
      }
      if (
        owned.some(
          (candidate) =>
            candidate.slot === slot || candidate.agentId === agentId,
        )
      ) {
        throw new AgentPaneRestorationError(
          "multiple panes claim one controller agent or slot",
        );
      }
      owned.push({ pane, process, agentId, slot });
    }
    return Object.freeze(owned);
  }

  async #launchBound(
    request: RestoreMissingAgentPaneRequest,
    snapshot: ControllerSnapshot,
    entry: RosterEntry,
    restoration: AgentPaneRestorationRecord,
  ): Promise<AgentPaneRestorationResult> {
    if (
      restoration.replacementPaneId === null ||
      restoration.status === "reserved"
    ) {
      throw new AgentPaneRestorationError(
        "replacement pane is not durably bound",
      );
    }
    const launchRequest = await this.#preparation.prepare({
      snapshot,
      agent: entry.agent,
      paneId: restoration.replacementPaneId,
      sessionId: restoration.sessionId,
    });
    if (
      launchRequest.paneId !== restoration.replacementPaneId ||
      launchRequest.sessionId !== restoration.sessionId ||
      launchRequest.requireExistingSession !== true ||
      (entry.agent.piSessionPath !== null &&
        launchRequest.expectedSessionFile !== entry.agent.piSessionPath) ||
      launchRequest.task.runId !== request.runId ||
      launchRequest.task.assignedAgentId !== entry.agent.id ||
      launchRequest.task.worktreePath !== entry.agent.worktreePath
    ) {
      throw new AgentPaneRestorationError(
        "prepared Pi relaunch does not preserve exact existing session, pane, agent, run, or worktree authority",
      );
    }
    const evidence = await this.#launcher.launch(launchRequest);
    if (
      evidence.paneId !== restoration.replacementPaneId ||
      evidence.sessionId !== restoration.sessionId
    ) {
      throw new AgentPaneRestorationError(
        "secure Pi relaunch returned conflicting pane or session evidence",
      );
    }
    await this.#afterPhase("process-launched", restoration);
    const confirmation: ConfirmAgentLaunchInput = {
      write: request.write,
      runId: request.runId,
      agentId: entry.agent.id,
      paneId: evidence.paneId,
      sessionId: evidence.sessionId,
      processIds: evidence.processIds,
      commandSha256: evidence.commandSha256,
    };
    this.#repository.confirmAgentLaunch(confirmation);
    const finalConfirmation: ConfirmAgentPaneRestorationInput = {
      write: request.write,
      runId: request.runId,
      agentId: entry.agent.id,
      restorationId: restoration.restorationId,
      replacementPaneId: evidence.paneId,
      sessionId: evidence.sessionId,
    };
    const confirmed =
      this.#repository.confirmAgentPaneRestoration(finalConfirmation);
    await this.#afterPhase("confirmed", confirmed);
    return Object.freeze({
      restored: true,
      agentId: entry.agent.id,
      slot: restoration.slot,
      priorPaneId: restoration.priorPaneId,
      replacementPaneId: evidence.paneId,
      sessionId: evidence.sessionId,
      processIds: Object.freeze([...evidence.processIds]),
    });
  }
}
