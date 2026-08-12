import { createHash, randomUUID } from "node:crypto";
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

export interface RestoredAgentPane {
  readonly agentId: string;
  readonly slot: number;
  readonly priorPaneId: string;
  readonly replacementPaneId: string;
  readonly sessionId: string;
  readonly processIds: readonly number[];
}

export interface AgentPaneRestorationResult {
  readonly restored: boolean;
  readonly restorations: readonly RestoredAgentPane[];
  /** Compatibility projection for callers that predate restoration sets. */
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
    | "reserveAgentPaneRestorations"
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
  readonly resolveRoleLabel: (agent: AgentState) => Promise<string>;
  readonly preparation: AgentPaneRestorationLaunchPreparer;
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

function exactSlot(value: string | undefined): number | null {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return null;
  }
  const slot = Number(value);
  return Number.isSafeInteger(slot) ? slot : null;
}

function restorationResult(
  restorations: readonly RestoredAgentPane[],
): AgentPaneRestorationResult {
  const ordered = Object.freeze(
    [...restorations].sort((left, right) => left.slot - right.slot),
  );
  const first = ordered[0] ?? null;
  return Object.freeze({
    restored: ordered.length > 0,
    restorations: ordered,
    agentId: first?.agentId ?? null,
    slot: first?.slot ?? null,
    priorPaneId: first?.priorPaneId ?? null,
    replacementPaneId: first?.replacementPaneId ?? null,
    sessionId: first?.sessionId ?? null,
    processIds: first?.processIds ?? Object.freeze([]),
  });
}

function emptyResult(): AgentPaneRestorationResult {
  return restorationResult([]);
}

function stableRestorationOperationId(
  runId: string,
  roster: readonly RosterEntry[],
  targets: readonly RosterEntry[],
): string {
  const targetIds = new Set(targets.map((entry) => entry.agent.id));
  const identity = roster
    .map((entry) => ({
      agentId: entry.agent.id,
      paneId: entry.launch.paneId,
      sessionId: entry.launch.sessionId,
      slot: entry.launch.slot,
      missing: targetIds.has(entry.agent.id),
    }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  const digest = createHash("sha256")
    .update(JSON.stringify({ runId, identity }))
    .digest("hex")
    .slice(0, 32);
  return `restore-${digest}`;
}

export class AgentPaneRestorationController {
  readonly #repository: RestorationRepository;
  readonly #herdr: RestorationHerdrGateway;
  readonly #processEvidence: PaneProcessEvidenceGateway;
  readonly #lifecycle: Pick<AgentsTabLifecycle, "ensure">;
  readonly #launcher: PiAgentLauncher;
  readonly #resolveRoleLabel: (agent: AgentState) => Promise<string>;
  readonly #preparation: AgentPaneRestorationLaunchPreparer;
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
    this.#resolveRoleLabel = dependencies.resolveRoleLabel;
    this.#preparation = dependencies.preparation;
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
    if (["completed", "failed", "cancelled"].includes(snapshot.run.status)) {
      return emptyResult();
    }
    const roster = this.#roster(snapshot);
    if (roster.length === 0) return emptyResult();
    const panes = await this.#herdr.listPanes(request.workspaceId);
    const owned = await this.#strictOwnedPanes(request, roster, panes);

    const ownedByAgent = new Map(
      owned.map((candidate) => [candidate.agentId, candidate] as const),
    );
    const hasPendingRestoration = roster.some(
      (entry) =>
        entry.restoration !== null && entry.restoration.status !== "confirmed",
    );
    if (
      !hasPendingRestoration &&
      roster.every(
        (entry) =>
          ownedByAgent.get(entry.agent.id)?.pane.paneId === entry.launch.paneId,
      )
    ) {
      return emptyResult();
    }
    const rosterSlots = new Set<number>();
    for (const entry of roster) {
      const slot = entry.launch.slot;
      if (
        slot === null ||
        slot < 0 ||
        slot >= roster.length ||
        rosterSlots.has(slot)
      ) {
        throw new AgentPaneRestorationError(
          "controller roster lacks complete unique durable slot evidence",
        );
      }
      rosterSlots.add(slot);
      const candidate = ownedByAgent.get(entry.agent.id);
      if (candidate !== undefined && candidate.slot !== slot) {
        throw new AgentPaneRestorationError(
          `agent ${entry.agent.id} live slot conflicts with durable launch authority`,
        );
      }
      if (entry.restoration !== null && entry.restoration.slot !== slot) {
        throw new AgentPaneRestorationError(
          `agent ${entry.agent.id} restoration slot conflicts with durable launch authority`,
        );
      }
    }
    if (
      Array.from({ length: roster.length }, (_, slot) => slot).some(
        (slot) => !rosterSlots.has(slot),
      )
    ) {
      throw new AgentPaneRestorationError(
        "controller roster durable slots are not complete and contiguous",
      );
    }

    const pending = roster.filter(
      (entry) =>
        entry.restoration !== null && entry.restoration.status !== "confirmed",
    );
    let targets: readonly RosterEntry[];
    let reservations: readonly AgentPaneRestorationRecord[];
    if (pending.length > 0) {
      const operationIds = new Set(
        pending.map((entry) => entry.restoration?.operationId),
      );
      if (operationIds.size !== 1 || operationIds.has(undefined)) {
        throw new AgentPaneRestorationError(
          "pending pane restorations have mixed operation identities",
        );
      }
      targets = Object.freeze(
        [...pending].sort(
          (left, right) => (left.launch.slot ?? 0) - (right.launch.slot ?? 0),
        ),
      );
      reservations = Object.freeze(
        targets.map((entry) => {
          const restoration = entry.restoration;
          if (restoration === null) {
            throw new AgentPaneRestorationError(
              "pending restoration disappeared from the controller roster",
            );
          }
          return restoration;
        }),
      );
      const targetIds = new Set(targets.map((entry) => entry.agent.id));
      for (const entry of roster) {
        const candidate = ownedByAgent.get(entry.agent.id);
        if (!targetIds.has(entry.agent.id)) {
          if (candidate?.pane.paneId !== entry.launch.paneId) {
            throw new AgentPaneRestorationError(
              "pending restoration set is mixed with an unreserved pane loss",
            );
          }
          continue;
        }
        const restoration = entry.restoration;
        if (restoration === null) {
          throw new AgentPaneRestorationError(
            "pending restoration authority disappeared",
          );
        }
        if (
          restoration.status === "bound" &&
          (candidate === undefined ||
            restoration.replacementPaneId !== entry.launch.paneId ||
            candidate.pane.paneId !== restoration.replacementPaneId)
        ) {
          throw new AgentPaneRestorationError(
            "bound replacement pane is absent or has conflicting ownership",
          );
        }
        if (
          restoration.status === "reserved" &&
          (entry.launch.processIds.length === 0 ||
            entry.launch.processIds.some((processId) =>
              this.#processExists(processId),
            ))
        ) {
          throw new AgentPaneRestorationError(
            "prior Pi process evidence is missing, still alive, or identity-indeterminate",
          );
        }
      }
    } else {
      targets = Object.freeze(
        roster
          .filter((entry) => ownedByAgent.get(entry.agent.id) === undefined)
          .sort(
            (left, right) => (left.launch.slot ?? 0) - (right.launch.slot ?? 0),
          ),
      );
      if (targets.length === 0) return emptyResult();
      for (const target of targets) {
        if (target.restoration?.status === "confirmed") {
          throw new AgentPaneRestorationError(
            `agent ${target.agent.id} requires a new restoration generation`,
          );
        }
        if (panes.some((pane) => pane.paneId === target.launch.paneId)) {
          throw new AgentPaneRestorationError(
            "controller pane id still exists without exact ownership evidence",
          );
        }
        if (
          target.launch.status !== "confirmed" ||
          target.launch.processIds.length === 0 ||
          target.launch.processIds.some((processId) =>
            this.#processExists(processId),
          )
        ) {
          throw new AgentPaneRestorationError(
            "prior Pi process evidence is missing, still alive, or identity-indeterminate",
          );
        }
      }
      const operationId = stableRestorationOperationId(
        request.runId,
        roster,
        targets,
      );
      reservations = this.#repository.reserveAgentPaneRestorations({
        write: request.write,
        runId: request.runId,
        operationId,
        expectedRevision: snapshot.revision,
        expectedRoster: roster.map((entry) => ({
          agentId: entry.agent.id,
          slot: entry.launch.slot ?? -1,
          paneId: entry.launch.paneId,
          sessionId: entry.launch.sessionId,
        })),
        reservations: targets.map((target) => ({
          agentId: target.agent.id,
          restorationId: this.#restorationId(),
          slot: target.launch.slot ?? -1,
          priorPaneId: target.launch.paneId,
          sessionId: target.launch.sessionId,
        })),
      });
      if (reservations.length !== targets.length) {
        throw new AgentPaneRestorationError(
          "atomic restoration reservation set is incomplete",
        );
      }
      for (const reservation of reservations) {
        await this.#afterPhase("reserved", reservation);
      }
    }

    const tabIds = new Set(owned.map((candidate) => candidate.pane.tabId));
    if (tabIds.size !== 1) {
      throw new AgentPaneRestorationError(
        "surviving controller panes do not prove one exact Herdr tab",
      );
    }
    const tabId = [...tabIds][0];
    if (
      tabId === undefined ||
      panes.some(
        (pane) =>
          pane.tabId === tabId &&
          !owned.some((candidate) => candidate.pane.paneId === pane.paneId),
      )
    ) {
      throw new AgentPaneRestorationError(
        "controller agent tab contains ambiguous or unowned pane identity",
      );
    }

    const canonicalRoleLabels = new Map(
      await Promise.all(
        roster.map(async (entry) => {
          const label = await this.#resolveRoleLabel(entry.agent);
          if (label.trim().length === 0) {
            throw new AgentPaneRestorationError(
              `agent ${entry.agent.id} has no canonical role label`,
            );
          }
          return [entry.agent.id, label] as const;
        }),
      ),
    );
    const beforeMutation = this.#repository.loadSnapshot(request.runId);
    if (
      beforeMutation?.revision !== snapshot.revision ||
      beforeMutation.agents.filter((agent) =>
        ACTIVE_AGENT_STATUSES.has(agent.status),
      ).length !== roster.length
    ) {
      throw new AgentPaneRestorationError(
        "controller roster or capacity changed before Herdr mutation",
      );
    }
    const restorationByAgent = new Map<string, AgentPaneRestorationRecord>();
    for (const entry of roster) {
      if (entry.restoration !== null) {
        restorationByAgent.set(entry.agent.id, entry.restoration);
      }
    }
    for (const reservation of reservations) {
      restorationByAgent.set(reservation.agentId, reservation);
    }
    const assignments: AgentPaneAssignment[] = Array.from({
      length: roster.length,
    });
    const expectedPaneIds: (string | null)[] = Array.from(
      { length: roster.length },
      () => null,
    );
    for (const entry of roster) {
      const slot = entry.launch.slot;
      const label = canonicalRoleLabels.get(entry.agent.id);
      if (slot === null || label === undefined) {
        throw new AgentPaneRestorationError(
          `agent ${entry.agent.id} stable slot or canonical label disappeared`,
        );
      }
      const restoration = restorationByAgent.get(entry.agent.id);
      assignments[slot] = {
        agentId: entry.agent.id,
        label,
        cwd: entry.agent.worktreePath,
        ...(restoration === undefined
          ? {}
          : { restorationId: restoration.restorationId }),
      };
      expectedPaneIds[slot] =
        restoration?.status === "reserved" ? null : entry.launch.paneId;
    }
    const evidence = await this.#lifecycle.ensure({
      runId: request.runId,
      operationId: request.runId,
      workspaceId: request.workspaceId,
      expectedTabId: tabId,
      expectedPaneIds,
      assignments,
      metadataSequence: request.metadataSequence,
    });
    for (const candidate of owned) {
      if (evidence.paneIds[candidate.slot] !== candidate.pane.paneId) {
        throw new AgentPaneRestorationError(
          "restoration moved or adopted a surviving controller pane",
        );
      }
    }

    const boundRecords: AgentPaneRestorationRecord[] = [];
    for (const reservation of reservations) {
      const replacementPaneId = evidence.paneIds[reservation.slot];
      if (
        replacementPaneId === undefined ||
        replacementPaneId === reservation.priorPaneId
      ) {
        throw new AgentPaneRestorationError(
          "Herdr did not create a distinct pane in every reserved slot",
        );
      }
      await this.#afterPhase("pane-created", reservation);
      const bound =
        reservation.status === "reserved"
          ? this.#repository.bindAgentPaneRestoration({
              write: request.write,
              runId: request.runId,
              agentId: reservation.agentId,
              restorationId: reservation.restorationId,
              replacementPaneId,
            })
          : reservation;
      if (
        bound.status === "reserved" ||
        bound.replacementPaneId !== replacementPaneId
      ) {
        throw new AgentPaneRestorationError(
          "durable restoration binding returned conflicting pane evidence",
        );
      }
      boundRecords.push(bound);
      await this.#afterPhase("bound", bound);
    }
    const reboundSnapshot = this.#repository.loadSnapshot(request.runId);
    if (reboundSnapshot === null) {
      throw new AgentPaneRestorationError(
        "controller snapshot disappeared after restoration binding",
      );
    }
    const restored: RestoredAgentPane[] = [];
    for (const bound of boundRecords) {
      const target = targets.find((entry) => entry.agent.id === bound.agentId);
      const reboundAgent = reboundSnapshot.agents.find(
        (agent) => agent.id === bound.agentId,
      );
      if (target === undefined || reboundAgent === undefined) {
        throw new AgentPaneRestorationError(
          "controller restoration target disappeared after binding",
        );
      }
      restored.push(
        await this.#launchBound(
          request,
          reboundSnapshot,
          { ...target, agent: reboundAgent },
          bound,
        ),
      );
    }
    return restorationResult(restored);
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
      // A launch is materialized before Herdr starts Pi. If the controller
      // dies after the process is visible but before confirmation is persisted,
      // the exact owned pane is still safe to retain. Missing panes continue
      // through the normal restoration guards below, which fail closed when
      // prior process evidence is not confirmed.
      if (
        restoration === null &&
        launch.status !== "confirmed" &&
        agent.paneId === null
      ) {
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
      // Management panes carry the run id so their lifecycle can be
      // reconciled, but they are not members of the agent roster. Ignore a
      // management claim before applying the stricter agent identity checks;
      // otherwise the management pane is incorrectly reported as spoofed
      // agent ownership during every restoration tick.
      if (
        pane.tokens.aw_kind === "management" ||
        environment[ENVIRONMENT.kind] === "management"
      ) {
        continue;
      }
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
      if (
        entry?.agent.worktreePath !== pane.cwd ||
        (entry.launch.slot !== null && entry.launch.slot !== slot)
      ) {
        throw new AgentPaneRestorationError(
          `pane ${pane.paneId} is absent from the exact durable controller roster`,
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
  ): Promise<RestoredAgentPane> {
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
      agentId: entry.agent.id,
      slot: restoration.slot,
      priorPaneId: restoration.priorPaneId,
      replacementPaneId: evidence.paneId,
      sessionId: evidence.sessionId,
      processIds: Object.freeze([...evidence.processIds]),
    });
  }
}
