import { isAbsolute } from "node:path";
import type {
  HerdrGateway,
  HerdrPane,
  HerdrPaneLayout,
} from "../ports/herdr-gateway.ts";
import type {
  PaneProcessEvidenceGateway,
  PaneShellEnvironmentEvidence,
} from "../ports/pane-process-evidence.ts";
import { planPaneGrid, type PaneGridPlan } from "../../domain/pane-grid.ts";

const AGENTS_TAB_LABEL = "Pi Agents";
const AGENT_SOURCE = "agentworks:controller";
const AGENT_KIND = "agent";
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9]{1,128}$/u;
const TAB_ID_PATTERN = /^[A-Za-z0-9]+:t[A-Za-z0-9]+$/u;
const PANE_ID_PATTERN = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/u;

const ENVIRONMENT_KEYS = Object.freeze({
  agent: "AGENTWORKS_AGENT_ID",
  kind: "AGENTWORKS_PANE_KIND",
  operation: "AGENTWORKS_PANE_OPERATION_ID",
  run: "AGENTWORKS_RUN_ID",
  slot: "AGENTWORKS_PANE_SLOT",
});
const TOKEN_KEYS = Object.freeze({
  agent: "aw_agent",
  kind: "aw_kind",
  operation: "aw_operation",
  run: "aw_run",
  slot: "aw_slot",
});

type AgentsTabHerdrGateway = Pick<
  HerdrGateway,
  | "createTab"
  | "getPaneLayout"
  | "listPanes"
  | "listTabs"
  | "renamePane"
  | "renameTab"
  | "reportPaneMetadata"
  | "splitPane"
>;

export interface AgentPaneAssignment {
  readonly agentId: string;
  readonly label: string;
  readonly cwd: string;
}

export interface EnsureAgentsTabRequest {
  readonly runId: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly expectedTabId: string | null;
  readonly expectedPaneIds: readonly (string | null)[];
  readonly assignments: readonly AgentPaneAssignment[];
  readonly metadataSequence: number;
}

export interface AgentsTabEvidence {
  readonly tabId: string;
  readonly rootPaneId: string;
  readonly paneIds: readonly string[];
  readonly createdTab: boolean;
  readonly recovered: boolean;
  readonly rowCount: number;
  readonly columnCount: number;
}

export class AgentsTabRecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentsTabRecoveryRequiredError";
  }
}

function assertIdentifier(
  value: string,
  pattern: RegExp,
  label: string,
): string {
  if (!pattern.test(value)) {
    throw new AgentsTabRecoveryRequiredError(`${label} is invalid`);
  }
  return value;
}

function baseEnvironment(
  request: EnsureAgentsTabRequest,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [ENVIRONMENT_KEYS.kind]: AGENT_KIND,
    [ENVIRONMENT_KEYS.operation]: request.operationId,
    [ENVIRONMENT_KEYS.run]: request.runId,
  });
}

function slotEnvironment(
  request: EnsureAgentsTabRequest,
  slot: number,
): Readonly<Record<string, string>> {
  const assignment = request.assignments[slot];
  if (assignment === undefined) {
    throw new AgentsTabRecoveryRequiredError("grid slot has no assignment");
  }
  return Object.freeze({
    ...baseEnvironment(request),
    [ENVIRONMENT_KEYS.agent]: assignment.agentId,
    [ENVIRONMENT_KEYS.slot]: String(slot),
  });
}

function slotTokens(
  request: EnsureAgentsTabRequest,
  slot: number,
): Readonly<Record<string, string>> {
  const assignment = request.assignments[slot];
  if (assignment === undefined) {
    throw new AgentsTabRecoveryRequiredError("grid slot has no assignment");
  }
  return Object.freeze({
    [TOKEN_KEYS.agent]: assignment.agentId,
    [TOKEN_KEYS.kind]: AGENT_KIND,
    [TOKEN_KEYS.operation]: request.operationId,
    [TOKEN_KEYS.run]: request.runId,
    [TOKEN_KEYS.slot]: String(slot),
  });
}

function contains(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(
    ([name, value]) => actual[name] === value,
  );
}

interface OwnedPane {
  readonly pane: HerdrPane;
  readonly process: PaneShellEnvironmentEvidence;
  readonly slot: number;
}

export class AgentsTabLifecycle {
  readonly #herdr: AgentsTabHerdrGateway;
  readonly #processEvidence: PaneProcessEvidenceGateway;

  constructor(
    herdr: AgentsTabHerdrGateway,
    processEvidence: PaneProcessEvidenceGateway,
  ) {
    this.#herdr = herdr;
    this.#processEvidence = processEvidence;
  }

  async ensure(request: EnsureAgentsTabRequest): Promise<AgentsTabEvidence> {
    this.#validate(request);
    const grid = planPaneGrid(request.assignments.length);
    const tabs = await this.#herdr.listTabs(request.workspaceId);
    const panes = await this.#herdr.listPanes(request.workspaceId);
    const potentialTabIds = new Set(
      tabs
        .filter(
          (tab) =>
            tab.label === AGENTS_TAB_LABEL ||
            tab.tabId === request.expectedTabId,
        )
        .map((tab) => tab.tabId),
    );
    const owned = await this.#findOwnedPanes(
      panes.filter((pane) => potentialTabIds.has(pane.tabId)),
      request,
    );
    const ownedTabIds = new Set(owned.map((candidate) => candidate.pane.tabId));
    if (ownedTabIds.size > 1) {
      throw new AgentsTabRecoveryRequiredError(
        "Agent grid ownership is split across multiple Herdr tabs",
      );
    }
    const liveOwnedTabId = owned[0]?.pane.tabId;
    if (
      request.expectedTabId !== null &&
      liveOwnedTabId !== undefined &&
      liveOwnedTabId !== request.expectedTabId
    ) {
      throw new AgentsTabRecoveryRequiredError(
        "Live agent tab ownership disagrees with controller state",
      );
    }
    if (
      request.expectedTabId !== null &&
      liveOwnedTabId === undefined &&
      tabs.some((tab) => tab.tabId === request.expectedTabId)
    ) {
      throw new AgentsTabRecoveryRequiredError(
        "The controller-recorded agent tab exists without ownership evidence",
      );
    }

    const panesBySlot = new Map<number, OwnedPane>();
    for (const candidate of owned) {
      if (panesBySlot.has(candidate.slot)) {
        throw new AgentsTabRecoveryRequiredError(
          `Multiple panes claim agent grid slot ${String(candidate.slot)}`,
        );
      }
      panesBySlot.set(candidate.slot, candidate);
    }
    this.#assertExpectedPaneIds(request, panes, panesBySlot);

    let tabId = liveOwnedTabId;
    let createdTab = false;
    if (tabId === undefined) {
      const assignment = request.assignments[0];
      if (assignment === undefined) {
        throw new AgentsTabRecoveryRequiredError("agent grid is empty");
      }
      const created = await this.#herdr.createTab({
        workspaceId: request.workspaceId,
        cwd: assignment.cwd,
        label: AGENTS_TAB_LABEL,
        environment: slotEnvironment(request, 0),
        focus: false,
      });
      tabId = created.tab.tabId;
      if (created.tab.workspaceId !== request.workspaceId) {
        throw new AgentsTabRecoveryRequiredError(
          "New agent tab was created in the wrong workspace",
        );
      }
      this.#assertPaneIdentity(
        created.rootPane,
        request.workspaceId,
        tabId,
        assignment,
      );
      const process = await this.#processEvidence.readShellEnvironment(
        created.rootPane.paneId,
      );
      if (
        process === null ||
        !contains(process.environment, slotEnvironment(request, 0))
      ) {
        throw new AgentsTabRecoveryRequiredError(
          "New agent tab root lacks atomic ownership evidence",
        );
      }
      panesBySlot.set(0, {
        pane: created.rootPane,
        process,
        slot: 0,
      });
      createdTab = true;
    }

    const root = panesBySlot.get(0);
    if (root === undefined) {
      throw new AgentsTabRecoveryRequiredError(
        "A partial agent grid exists without its root pane",
      );
    }
    for (const split of grid.splits) {
      const parent = panesBySlot.get(split.parentSlot);
      if (parent === undefined) {
        throw new AgentsTabRecoveryRequiredError(
          `Agent grid is missing split parent slot ${String(split.parentSlot)}`,
        );
      }
      if (panesBySlot.has(split.newSlot)) continue;
      const assignment = request.assignments[split.newSlot];
      if (assignment === undefined) {
        throw new AgentsTabRecoveryRequiredError(
          `Agent grid slot ${String(split.newSlot)} has no assignment`,
        );
      }
      const pane = await this.#herdr.splitPane({
        paneId: parent.pane.paneId,
        direction: split.direction,
        ratio: split.ratio,
        cwd: assignment.cwd,
        environment: slotEnvironment(request, split.newSlot),
        focus: false,
      });
      this.#assertPaneIdentity(pane, request.workspaceId, tabId, assignment);
      const process = await this.#processEvidence.readShellEnvironment(
        pane.paneId,
      );
      if (
        process === null ||
        !contains(process.environment, slotEnvironment(request, split.newSlot))
      ) {
        throw new AgentsTabRecoveryRequiredError(
          `New pane for slot ${String(split.newSlot)} lacks ownership evidence`,
        );
      }
      panesBySlot.set(split.newSlot, { pane, process, slot: split.newSlot });
    }

    const ordered = grid.cells.map((cell) => panesBySlot.get(cell.slot));
    if (ordered.some((candidate) => candidate === undefined)) {
      throw new AgentsTabRecoveryRequiredError("Agent grid is incomplete");
    }
    const complete = ordered as OwnedPane[];
    const liveTabPanes = [
      ...panes.filter((pane) => pane.tabId === tabId),
      ...complete
        .map((candidate) => candidate.pane)
        .filter(
          (pane) => !panes.some((existing) => existing.paneId === pane.paneId),
        ),
    ];
    if (
      liveTabPanes.length !== complete.length ||
      liveTabPanes.some(
        (pane) =>
          !complete.some((candidate) => candidate.pane.paneId === pane.paneId),
      )
    ) {
      throw new AgentsTabRecoveryRequiredError(
        "The dedicated agent tab contains an unowned or extra pane",
      );
    }

    await this.#herdr.renameTab(tabId, AGENTS_TAB_LABEL);
    for (const candidate of complete) {
      const assignment = request.assignments[candidate.slot];
      if (assignment === undefined) {
        throw new AgentsTabRecoveryRequiredError(
          "agent assignment disappeared",
        );
      }
      this.#assertPaneIdentity(
        candidate.pane,
        request.workspaceId,
        tabId,
        assignment,
      );
      await this.#herdr.renamePane(candidate.pane.paneId, assignment.label);
      await this.#herdr.reportPaneMetadata({
        paneId: candidate.pane.paneId,
        source: AGENT_SOURCE,
        sequence: request.metadataSequence,
        title: assignment.label,
        displayAgent: assignment.label,
        tokens: slotTokens(request, candidate.slot),
      });
    }
    const layout = await this.#herdr.getPaneLayout(root.pane.paneId);
    this.#assertBalancedLayout(layout, grid, complete);

    return Object.freeze({
      tabId,
      rootPaneId: root.pane.paneId,
      paneIds: Object.freeze(
        complete.map((candidate) => candidate.pane.paneId),
      ),
      createdTab,
      recovered: !createdTab && owned.length > 0,
      rowCount: grid.rowCount,
      columnCount: grid.columnCount,
    });
  }

  async #findOwnedPanes(
    panes: readonly HerdrPane[],
    request: EnsureAgentsTabRequest,
  ): Promise<readonly OwnedPane[]> {
    const base = baseEnvironment(request);
    const owned: OwnedPane[] = [];
    for (const pane of panes) {
      const tokenBase = {
        [TOKEN_KEYS.kind]: AGENT_KIND,
        [TOKEN_KEYS.operation]: request.operationId,
        [TOKEN_KEYS.run]: request.runId,
      };
      const hasTokens = contains(pane.tokens, tokenBase);
      const process = await this.#processEvidence.readShellEnvironment(
        pane.paneId,
      );
      if (process === null) {
        if (hasTokens) {
          throw new AgentsTabRecoveryRequiredError(
            `Pane ${pane.paneId} has agent metadata without process ownership`,
          );
        }
        continue;
      }
      const hasBaseEnvironment = contains(process.environment, base);
      if (hasTokens && !hasBaseEnvironment) {
        throw new AgentsTabRecoveryRequiredError(
          `Pane ${pane.paneId} has agent metadata without matching process ownership`,
        );
      }
      if (!hasBaseEnvironment) continue;
      const slotValue = process.environment[ENVIRONMENT_KEYS.slot];
      const agentId = process.environment[ENVIRONMENT_KEYS.agent];
      if (
        slotValue === undefined ||
        !/^(?:0|[1-9][0-9]*)$/u.test(slotValue) ||
        agentId === undefined
      ) {
        throw new AgentsTabRecoveryRequiredError(
          `Pane ${pane.paneId} has malformed agent slot ownership`,
        );
      }
      const slot = Number(slotValue);
      const assignment = request.assignments[slot];
      if (!Number.isSafeInteger(slot) || assignment?.agentId !== agentId) {
        throw new AgentsTabRecoveryRequiredError(
          `Pane ${pane.paneId} claims an unknown agent grid slot`,
        );
      }
      owned.push({ pane, process, slot });
    }
    return Object.freeze(owned);
  }

  #validate(request: EnsureAgentsTabRequest): void {
    assertIdentifier(request.runId, SAFE_ID_PATTERN, "run id");
    assertIdentifier(request.operationId, SAFE_ID_PATTERN, "operation id");
    assertIdentifier(request.workspaceId, WORKSPACE_ID_PATTERN, "workspace id");
    if (request.expectedTabId !== null) {
      assertIdentifier(
        request.expectedTabId,
        TAB_ID_PATTERN,
        "expected tab id",
      );
    }
    planPaneGrid(request.assignments.length);
    if (request.expectedPaneIds.length !== request.assignments.length) {
      throw new AgentsTabRecoveryRequiredError(
        "expected pane ids must align with every agent assignment",
      );
    }
    const agentIds = new Set<string>();
    for (const [slot, assignment] of request.assignments.entries()) {
      assertIdentifier(
        assignment.agentId,
        SAFE_ID_PATTERN,
        `agent id ${String(slot)}`,
      );
      if (agentIds.has(assignment.agentId)) {
        throw new AgentsTabRecoveryRequiredError("agent ids must be unique");
      }
      agentIds.add(assignment.agentId);
      if (
        assignment.label.length < 1 ||
        assignment.label.length > 128 ||
        assignment.label.startsWith("-") ||
        assignment.label.includes("\0")
      ) {
        throw new AgentsTabRecoveryRequiredError(
          `agent label ${String(slot)} is invalid`,
        );
      }
      if (!isAbsolute(assignment.cwd)) {
        throw new AgentsTabRecoveryRequiredError(
          `agent cwd ${String(slot)} must be absolute`,
        );
      }
      const expectedPaneId = request.expectedPaneIds[slot];
      if (expectedPaneId !== null && expectedPaneId !== undefined) {
        assertIdentifier(
          expectedPaneId,
          PANE_ID_PATTERN,
          `expected pane id ${String(slot)}`,
        );
      }
    }
    if (
      !Number.isSafeInteger(request.metadataSequence) ||
      request.metadataSequence < 0
    ) {
      throw new AgentsTabRecoveryRequiredError(
        "metadata sequence must be a non-negative safe integer",
      );
    }
  }

  #assertExpectedPaneIds(
    request: EnsureAgentsTabRequest,
    panes: readonly HerdrPane[],
    panesBySlot: ReadonlyMap<number, OwnedPane>,
  ): void {
    for (const [slot, expectedPaneId] of request.expectedPaneIds.entries()) {
      if (expectedPaneId === null) continue;
      const live = panesBySlot.get(slot);
      if (live !== undefined && live.pane.paneId !== expectedPaneId) {
        throw new AgentsTabRecoveryRequiredError(
          `Live pane for slot ${String(slot)} disagrees with controller state`,
        );
      }
      if (
        live === undefined &&
        panes.some((pane) => pane.paneId === expectedPaneId)
      ) {
        throw new AgentsTabRecoveryRequiredError(
          `Controller pane for slot ${String(slot)} exists without ownership`,
        );
      }
    }
  }

  #assertPaneIdentity(
    pane: HerdrPane,
    workspaceId: string,
    tabId: string,
    assignment: AgentPaneAssignment,
  ): void {
    if (
      pane.workspaceId !== workspaceId ||
      pane.tabId !== tabId ||
      pane.cwd !== assignment.cwd
    ) {
      throw new AgentsTabRecoveryRequiredError(
        "Agent pane tab or working directory does not match its assignment",
      );
    }
  }

  #assertBalancedLayout(
    layout: HerdrPaneLayout,
    grid: PaneGridPlan,
    panes: readonly OwnedPane[],
  ): void {
    if (
      layout.panes.length !== panes.length ||
      layout.tabId !== panes[0]?.pane.tabId
    ) {
      throw new AgentsTabRecoveryRequiredError(
        "Herdr layout does not contain the exact agent pane set",
      );
    }
    const expectedPaneIds = new Set(
      panes.map((candidate) => candidate.pane.paneId),
    );
    if (
      layout.panes.some((pane) => !expectedPaneIds.has(pane.paneId)) ||
      grid.paneCount !== panes.length ||
      layout.splits.length !== Math.max(0, panes.length - 1)
    ) {
      throw new AgentsTabRecoveryRequiredError(
        "Herdr layout ownership or split count is invalid",
      );
    }
    const areaRight = layout.area.x + layout.area.width;
    const areaBottom = layout.area.y + layout.area.height;
    let coveredArea = 0;
    for (const [index, pane] of layout.panes.entries()) {
      const rect = pane.rect;
      if (
        rect.width < 1 ||
        rect.height < 1 ||
        rect.x < layout.area.x ||
        rect.y < layout.area.y ||
        rect.x + rect.width > areaRight ||
        rect.y + rect.height > areaBottom
      ) {
        throw new AgentsTabRecoveryRequiredError(
          "Agent grid pane escapes the tab area",
        );
      }
      for (const other of layout.panes.slice(index + 1)) {
        const overlapWidth =
          Math.min(rect.x + rect.width, other.rect.x + other.rect.width) -
          Math.max(rect.x, other.rect.x);
        const overlapHeight =
          Math.min(rect.y + rect.height, other.rect.y + other.rect.height) -
          Math.max(rect.y, other.rect.y);
        if (overlapWidth > 0 && overlapHeight > 0) {
          throw new AgentsTabRecoveryRequiredError("Agent grid panes overlap");
        }
      }
      coveredArea += rect.width * rect.height;
    }
    if (coveredArea !== layout.area.width * layout.area.height) {
      throw new AgentsTabRecoveryRequiredError(
        "Agent grid does not tile the complete tab area",
      );
    }
    if (layout.splits.some((split) => split.ratio < 0.2 || split.ratio > 0.8)) {
      throw new AgentsTabRecoveryRequiredError(
        "Agent grid contains an unbalanced split",
      );
    }
  }
}
