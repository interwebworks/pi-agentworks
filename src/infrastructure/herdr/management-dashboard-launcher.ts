import { fileURLToPath } from "node:url";
import { ManagementPaneLifecycle } from "../../application/herdr/management-pane-lifecycle.ts";
import type {
  HerdrGateway,
  HerdrPaneProcessInfo,
  HerdrProcess,
} from "../../application/ports/herdr-gateway.ts";
import {
  readProcessStartIdentity,
  resolveControllerRuntimePaths,
} from "../controller/controller-runtime.ts";
import { HerdrCliGateway } from "./herdr-cli-gateway.ts";
import { LinuxPaneProcessEvidenceGateway } from "./linux-pane-process-evidence.ts";
import {
  managementDashboardReadyPath,
  readManagementDashboardReadyProof,
  type ManagementDashboardReadyProof,
} from "./management-dashboard-ready.ts";

const DEFAULT_ENTRY_PATH = fileURLToPath(
  new URL("../../management/process-entry.ts", import.meta.url),
);
const PROCESS_POLL_ATTEMPTS = 100;
const PROCESS_POLL_DELAY_MS = 50;
const SHELL_SETTLE_ATTEMPTS = 20;

type DashboardHerdrGateway = Pick<
  HerdrGateway,
  "assertCompatible" | "getPaneProcessInfo" | "runCommand"
>;

export interface ManagementDashboardLaunchRequest {
  readonly runId: string;
  readonly runtimeRoot: string;
  readonly workspaceId: string;
  readonly parentTabId: string;
  readonly parentPaneId: string;
}

export interface ManagementDashboardLaunchEvidence {
  readonly paneId: string;
  readonly paneCreated: boolean;
  readonly dashboardStarted: boolean;
}

export interface ParentManagementPaneLauncher {
  ensure(
    request: ManagementDashboardLaunchRequest,
  ): Promise<ManagementDashboardLaunchEvidence>;
}

export interface ManagementDashboardLauncherOptions {
  readonly nodePath?: string;
  readonly entryPath?: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly readReadyProof?: (
    path: string,
  ) => ManagementDashboardReadyProof | null;
  readonly readProcessStartIdentity?: (processId: number) => string | null;
}

function exactProcess(
  processInfo: HerdrPaneProcessInfo,
  command: readonly string[],
): HerdrProcess | null {
  return (
    processInfo.foregroundProcesses.find(
      (process) =>
        process.argv !== null &&
        process.argv.length === command.length &&
        process.argv.every((argument, index) => argument === command[index]),
    ) ?? null
  );
}

function isOwnedStableShell(
  processInfo: HerdrPaneProcessInfo,
  expectedCwd: string,
): boolean {
  if (processInfo.foregroundProcesses.length === 0) return true;
  if (processInfo.foregroundProcesses.length !== 1) return false;
  const foreground = processInfo.foregroundProcesses[0];
  return (
    foreground !== undefined &&
    processInfo.shellPid !== null &&
    foreground.pid === processInfo.shellPid &&
    foreground.cwd === expectedCwd
  );
}

function dashboardCommand(
  nodePath: string,
  entryPath: string,
  request: ManagementDashboardLaunchRequest,
  readyPath: string,
): readonly string[] {
  return Object.freeze([
    nodePath,
    "--experimental-strip-types",
    entryPath,
    "--runtime-root",
    request.runtimeRoot,
    "--run-id",
    request.runId,
    "--ready-path",
    readyPath,
  ]);
}

/** Creates/reconciles the right sibling and starts exactly one live dashboard. */
export class ManagementDashboardLauncher implements ParentManagementPaneLauncher {
  readonly #lifecycle: Pick<ManagementPaneLifecycle, "ensure">;
  readonly #herdr: DashboardHerdrGateway;
  readonly #nodePath: string;
  readonly #entryPath: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #readReadyProof: (
    path: string,
  ) => ManagementDashboardReadyProof | null;
  readonly #readProcessStartIdentity: (processId: number) => string | null;

  constructor(
    lifecycle: Pick<ManagementPaneLifecycle, "ensure">,
    herdr: DashboardHerdrGateway,
    options: ManagementDashboardLauncherOptions = {},
  ) {
    this.#lifecycle = lifecycle;
    this.#herdr = herdr;
    this.#nodePath = options.nodePath ?? process.execPath;
    this.#entryPath = options.entryPath ?? DEFAULT_ENTRY_PATH;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#readReadyProof =
      options.readReadyProof ?? readManagementDashboardReadyProof;
    this.#readProcessStartIdentity =
      options.readProcessStartIdentity ?? readProcessStartIdentity;
  }

  async ensure(
    request: ManagementDashboardLaunchRequest,
  ): Promise<ManagementDashboardLaunchEvidence> {
    await this.#herdr.assertCompatible();
    const runRuntimeDirectory = resolveControllerRuntimePaths(
      request.runtimeRoot,
      request.runId,
    ).runtimeDirectory;
    const pane = await this.#lifecycle.ensure({
      runId: request.runId,
      operationId: `management-${request.runId}`,
      workspaceId: request.workspaceId,
      parentTabId: request.parentTabId,
      parentPaneId: request.parentPaneId,
      expectedPaneId: null,
      cwd: runRuntimeDirectory,
      splitRatio: 0.34,
      metadataSequence: 0,
    });
    const readyPath = managementDashboardReadyPath(runRuntimeDirectory);
    const command = dashboardCommand(
      this.#nodePath,
      this.#entryPath,
      request,
      readyPath,
    );
    let before = await this.#herdr.getPaneProcessInfo(pane.paneId);
    let existing = exactProcess(before, command);
    for (let attempt = 0; attempt < SHELL_SETTLE_ATTEMPTS; attempt += 1) {
      if (before.paneId !== pane.paneId || before.shellPid !== pane.shellPid) {
        throw new Error(
          "Management pane shell ownership changed before dashboard launch",
        );
      }
      existing = exactProcess(before, command);
      if (
        existing !== null ||
        isOwnedStableShell(before, runRuntimeDirectory)
      ) {
        break;
      }
      if (attempt + 1 < SHELL_SETTLE_ATTEMPTS) {
        await this.#sleep(PROCESS_POLL_DELAY_MS);
        before = await this.#herdr.getPaneProcessInfo(pane.paneId);
      }
    }
    if (existing === null && !isOwnedStableShell(before, runRuntimeDirectory)) {
      throw new Error(
        "Management pane has an unexpected foreground process; refusing command injection",
      );
    }

    const started = existing === null;
    if (started) await this.#herdr.runCommand(pane.paneId, command);
    for (let attempt = 0; attempt < PROCESS_POLL_ATTEMPTS; attempt += 1) {
      const current = await this.#herdr.getPaneProcessInfo(pane.paneId);
      const dashboard = exactProcess(current, command);
      const proof = this.#readReadyProof(readyPath);
      if (
        current.paneId === pane.paneId &&
        current.shellPid === pane.shellPid &&
        dashboard !== null &&
        proof?.runId === request.runId &&
        proof.processId === dashboard.pid &&
        this.#readProcessStartIdentity(dashboard.pid) ===
          proof.processStartIdentity
      ) {
        return Object.freeze({
          paneId: pane.paneId,
          paneCreated: pane.created,
          dashboardStarted: started,
        });
      }
      if (attempt + 1 < PROCESS_POLL_ATTEMPTS) {
        await this.#sleep(PROCESS_POLL_DELAY_MS);
      }
    }
    throw new Error(
      "Management dashboard did not authenticate in the owned Herdr pane before timeout",
    );
  }
}

/** Production composition for the parent extension launch path. */
export function createManagementDashboardLauncher(
  herdrPath: string,
): ParentManagementPaneLauncher {
  const herdr = new HerdrCliGateway({ herdrPath });
  const processEvidence = new LinuxPaneProcessEvidenceGateway(herdr);
  const lifecycle = new ManagementPaneLifecycle(herdr, processEvidence);
  return new ManagementDashboardLauncher(lifecycle, herdr);
}
