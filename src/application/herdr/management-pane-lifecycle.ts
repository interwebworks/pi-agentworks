import { isAbsolute } from "node:path";
import type { HerdrGateway, HerdrPane } from "../ports/herdr-gateway.ts";
import type {
  PaneProcessEvidenceGateway,
  PaneShellEnvironmentEvidence,
} from "../ports/pane-process-evidence.ts";

const MANAGEMENT_SOURCE = "agentworks:controller";
const MANAGEMENT_KIND = "management";
const MANAGEMENT_LABEL = "Agentworks · Manage";
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9]{1,128}$/u;
const TAB_ID_PATTERN = /^[A-Za-z0-9]+:t[A-Za-z0-9]+$/u;
const PANE_ID_PATTERN = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/u;

const ENVIRONMENT_KEYS = Object.freeze({
  kind: "AGENTWORKS_PANE_KIND",
  operation: "AGENTWORKS_PANE_OPERATION_ID",
  parent: "AGENTWORKS_PARENT_PANE_ID",
  run: "AGENTWORKS_RUN_ID",
});

const TOKEN_KEYS = Object.freeze({
  kind: "aw_kind",
  operation: "aw_operation",
  parent: "aw_parent",
  run: "aw_run",
});

type ManagementHerdrGateway = Pick<
  HerdrGateway,
  | "getPaneLayout"
  | "listPanes"
  | "renamePane"
  | "reportPaneMetadata"
  | "splitPane"
>;

export interface EnsureManagementPaneRequest {
  readonly runId: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly parentTabId: string;
  readonly parentPaneId: string;
  readonly expectedPaneId: string | null;
  readonly cwd: string;
  readonly splitRatio?: number;
  readonly metadataSequence: number;
}

export interface ManagementPaneEvidence {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly parentPaneId: string;
  readonly shellPid: number;
  readonly created: boolean;
  readonly recovered: boolean;
}

export class ManagementPaneRecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagementPaneRecoveryRequiredError";
  }
}

function assertSafeIdentifier(
  value: string,
  pattern: RegExp,
  label: string,
): string {
  if (!pattern.test(value)) {
    throw new ManagementPaneRecoveryRequiredError(`${label} is invalid`);
  }
  return value;
}

function ownershipEnvironment(
  request: EnsureManagementPaneRequest,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [ENVIRONMENT_KEYS.kind]: MANAGEMENT_KIND,
    [ENVIRONMENT_KEYS.operation]: request.operationId,
    [ENVIRONMENT_KEYS.parent]: request.parentPaneId,
    [ENVIRONMENT_KEYS.run]: request.runId,
  });
}

function ownershipTokens(
  request: EnsureManagementPaneRequest,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [TOKEN_KEYS.kind]: MANAGEMENT_KIND,
    [TOKEN_KEYS.operation]: request.operationId,
    [TOKEN_KEYS.parent]: request.parentPaneId,
    [TOKEN_KEYS.run]: request.runId,
  });
}

function containsOwnership(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(
    ([name, value]) => actual[name] === value,
  );
}

export class ManagementPaneLifecycle {
  readonly #herdr: ManagementHerdrGateway;
  readonly #processEvidence: PaneProcessEvidenceGateway;

  constructor(
    herdr: ManagementHerdrGateway,
    processEvidence: PaneProcessEvidenceGateway,
  ) {
    this.#herdr = herdr;
    this.#processEvidence = processEvidence;
  }

  async ensure(
    request: EnsureManagementPaneRequest,
  ): Promise<ManagementPaneEvidence> {
    this.#validateRequest(request);
    const panes = await this.#herdr.listPanes(request.workspaceId);
    const parent = panes.find((pane) => pane.paneId === request.parentPaneId);
    if (
      parent?.workspaceId !== request.workspaceId ||
      parent.tabId !== request.parentTabId
    ) {
      throw new ManagementPaneRecoveryRequiredError(
        "The parent Herdr pane is absent or has moved to another tab",
      );
    }

    const expectedEnvironment = ownershipEnvironment(request);
    const expectedTokens = ownershipTokens(request);
    const candidates: {
      pane: HerdrPane;
      process: PaneShellEnvironmentEvidence;
    }[] = [];
    for (const pane of panes) {
      if (
        pane.paneId === parent.paneId ||
        pane.workspaceId !== request.workspaceId ||
        pane.tabId !== request.parentTabId
      ) {
        continue;
      }
      const hasTokens = containsOwnership(pane.tokens, expectedTokens);
      const process = await this.#processEvidence.readShellEnvironment(
        pane.paneId,
      );
      if (process === null) {
        if (hasTokens) {
          throw new ManagementPaneRecoveryRequiredError(
            `Pane ${pane.paneId} has management metadata without matching process ownership`,
          );
        }
        continue;
      }
      const hasEnvironment = containsOwnership(
        process.environment,
        expectedEnvironment,
      );
      if (hasTokens && !hasEnvironment) {
        throw new ManagementPaneRecoveryRequiredError(
          `Pane ${pane.paneId} has management metadata without matching process ownership`,
        );
      }
      if (hasEnvironment) candidates.push({ pane, process });
    }
    if (candidates.length > 1) {
      throw new ManagementPaneRecoveryRequiredError(
        "Multiple Herdr panes claim the same management operation",
      );
    }

    const existingExpected =
      request.expectedPaneId === null
        ? undefined
        : panes.find((pane) => pane.paneId === request.expectedPaneId);
    const candidate = candidates[0];
    if (
      request.expectedPaneId !== null &&
      candidate !== undefined &&
      candidate.pane.paneId !== request.expectedPaneId
    ) {
      throw new ManagementPaneRecoveryRequiredError(
        "Live management pane ownership disagrees with controller state",
      );
    }
    if (existingExpected !== undefined && candidate === undefined) {
      throw new ManagementPaneRecoveryRequiredError(
        "The controller-recorded pane exists without matching ownership evidence",
      );
    }

    if (candidate !== undefined) {
      this.#assertPaneIdentity(candidate.pane, request);
      await this.#reconcileDisplay(
        candidate.pane.paneId,
        request,
        expectedTokens,
      );
      await this.#assertRightOfParent(
        request.parentPaneId,
        candidate.pane.paneId,
      );
      return Object.freeze({
        paneId: candidate.pane.paneId,
        workspaceId: candidate.pane.workspaceId,
        tabId: candidate.pane.tabId,
        parentPaneId: request.parentPaneId,
        shellPid: candidate.process.shellPid,
        created: false,
        recovered: true,
      });
    }

    const pane = await this.#herdr.splitPane({
      paneId: request.parentPaneId,
      direction: "right",
      ratio: request.splitRatio ?? 0.34,
      cwd: request.cwd,
      environment: expectedEnvironment,
      focus: false,
    });
    this.#assertPaneIdentity(pane, request);
    const process = await this.#processEvidence.readShellEnvironment(
      pane.paneId,
    );
    if (
      process === null ||
      !containsOwnership(process.environment, expectedEnvironment)
    ) {
      throw new ManagementPaneRecoveryRequiredError(
        "New management pane lacks atomic process ownership evidence",
      );
    }
    await this.#reconcileDisplay(pane.paneId, request, expectedTokens);
    await this.#assertRightOfParent(request.parentPaneId, pane.paneId);
    return Object.freeze({
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      parentPaneId: request.parentPaneId,
      shellPid: process.shellPid,
      created: true,
      recovered: false,
    });
  }

  #validateRequest(request: EnsureManagementPaneRequest): void {
    assertSafeIdentifier(request.runId, RUN_ID_PATTERN, "run id");
    assertSafeIdentifier(
      request.operationId,
      OPERATION_ID_PATTERN,
      "operation id",
    );
    assertSafeIdentifier(
      request.workspaceId,
      WORKSPACE_ID_PATTERN,
      "workspace id",
    );
    assertSafeIdentifier(request.parentTabId, TAB_ID_PATTERN, "parent tab id");
    assertSafeIdentifier(
      request.parentPaneId,
      PANE_ID_PATTERN,
      "parent pane id",
    );
    if (request.expectedPaneId !== null) {
      assertSafeIdentifier(
        request.expectedPaneId,
        PANE_ID_PATTERN,
        "expected management pane id",
      );
    }
    if (!isAbsolute(request.cwd)) {
      throw new ManagementPaneRecoveryRequiredError(
        "management pane cwd must be absolute",
      );
    }
    if (
      !Number.isSafeInteger(request.metadataSequence) ||
      request.metadataSequence < 0
    ) {
      throw new ManagementPaneRecoveryRequiredError(
        "metadata sequence must be a non-negative safe integer",
      );
    }
    if (
      request.splitRatio !== undefined &&
      (!Number.isFinite(request.splitRatio) ||
        request.splitRatio <= 0 ||
        request.splitRatio >= 1)
    ) {
      throw new ManagementPaneRecoveryRequiredError(
        "management split ratio must be between zero and one",
      );
    }
  }

  #assertPaneIdentity(
    pane: HerdrPane,
    request: EnsureManagementPaneRequest,
  ): void {
    if (
      pane.workspaceId !== request.workspaceId ||
      pane.tabId !== request.parentTabId ||
      pane.cwd !== request.cwd
    ) {
      throw new ManagementPaneRecoveryRequiredError(
        "Management pane identity or working directory does not match the run",
      );
    }
  }

  async #reconcileDisplay(
    paneId: string,
    request: EnsureManagementPaneRequest,
    tokens: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#herdr.renamePane(paneId, MANAGEMENT_LABEL);
    await this.#herdr.reportPaneMetadata({
      paneId,
      source: MANAGEMENT_SOURCE,
      sequence: request.metadataSequence,
      title: MANAGEMENT_LABEL,
      displayAgent: "Agentworks",
      tokens,
    });
  }

  async #assertRightOfParent(
    parentPaneId: string,
    managementPaneId: string,
  ): Promise<void> {
    const layout = await this.#herdr.getPaneLayout(parentPaneId);
    const parent = layout.panes.find((pane) => pane.paneId === parentPaneId);
    const management = layout.panes.find(
      (pane) => pane.paneId === managementPaneId,
    );
    if (
      parent === undefined ||
      management?.rect.x !== parent.rect.x + parent.rect.width ||
      management.rect.y !== parent.rect.y ||
      management.rect.height !== parent.rect.height
    ) {
      throw new ManagementPaneRecoveryRequiredError(
        "Management pane is not the exact right-side sibling of the parent pane",
      );
    }
  }
}
