import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ControllerEventInput,
  ControllerEventRecord,
  ControllerSnapshot,
  JsonValue,
} from "../../application/ports/controller-repository.ts";
import type {
  ParentManagementGateway,
  ParentManagementRequest,
  ParentManagementResult,
} from "../../application/ports/parent-management.ts";
import {
  createRunState,
  createStoryState,
  transitionRun,
  transitionStory,
  type ManagementPaneOrigin,
} from "../../domain/controller-state.ts";
import { DetachedControllerSupervisor } from "./detached-controller-supervisor.ts";
import { GitCliRepositoryInspector } from "../git/git-cli-repository-inspector.ts";
import {
  buildDashboardViewModel,
  type DashboardViewModel,
} from "../../application/tui/dashboard-view-model.ts";
import {
  createManagementDashboardLauncher,
  type ParentManagementPaneLauncher,
} from "../herdr/management-dashboard-launcher.ts";
import {
  integrationBranchForRun,
  storyBranchForRun,
} from "../../domain/workspace-naming.ts";
import type { ControllerClientRequest } from "./unix-controller-transport.ts";
import {
  ControllerRemoteError,
  UnixControllerClient,
} from "./unix-controller-transport.ts";
import {
  discoverControllerRuntime,
  type DiscoveredControllerRuntime,
} from "./controller-runtime.ts";

export interface ParentControllerClient {
  request(input: ControllerClientRequest): Promise<JsonValue>;
  close(): void;
}

export type ParentControllerClientFactory = (
  runId: string,
) => ParentControllerClient | Promise<ParentControllerClient>;

export type ParentLaunchHandler = (
  input: ParentManagementRequest,
) => Promise<ParentManagementResult>;

export class ParentManagementGatewayError extends Error {
  constructor(message: string) {
    super(`Parent management gateway failed: ${message}`);
    this.name = "ParentManagementGatewayError";
  }
}

function record(
  value: JsonValue,
  label: string,
): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ParentManagementGatewayError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function snapshot(value: JsonValue): ControllerSnapshot {
  const object = record(value, "snapshot");
  if (
    typeof object.revision !== "number" ||
    !Number.isSafeInteger(object.revision) ||
    !Array.isArray(object.stories) ||
    !Array.isArray(object.agents) ||
    object.run === null ||
    typeof object.run !== "object" ||
    Array.isArray(object.run)
  ) {
    throw new ParentManagementGatewayError(
      "controller returned an invalid snapshot",
    );
  }
  return value as unknown as ControllerSnapshot;
}

function events(value: JsonValue): readonly ControllerEventRecord[] {
  if (!Array.isArray(value)) {
    throw new ParentManagementGatewayError(
      "controller returned invalid events",
    );
  }
  return value as readonly ControllerEventRecord[];
}

function orchestrationPlan(value: JsonValue): readonly string[] {
  const object = record(value, "orchestration plan");
  if (
    typeof object.revision !== "number" ||
    !Number.isSafeInteger(object.revision) ||
    !Array.isArray(object.actions) ||
    object.actions.length > 64
  ) {
    throw new ParentManagementGatewayError(
      "controller returned an invalid orchestration plan",
    );
  }
  return object.actions.map((action) => {
    if (
      action === null ||
      typeof action !== "object" ||
      Array.isArray(action)
    ) {
      throw new ParentManagementGatewayError(
        "controller returned an invalid orchestration action",
      );
    }
    const actionRecord = action as Readonly<Record<string, JsonValue>>;
    const type = actionRecord.type;
    if (typeof type !== "string" || type.length === 0 || type.length > 64) {
      throw new ParentManagementGatewayError(
        "controller returned an invalid orchestration action",
      );
    }
    const storyId = actionRecord.storyId;
    return typeof storyId === "string" ? `${type}:${storyId}` : type;
  });
}

export interface ControllerDashboardData {
  readonly view: DashboardViewModel;
  readonly plannedActions: readonly string[];
}

/** Read and validate one bounded dashboard frame from an authenticated client. */
export async function readControllerDashboard(
  client: ParentControllerClient,
): Promise<ControllerDashboardData> {
  const current = snapshot(
    await client.request({ action: "snapshot.get", payload: {} }),
  );
  const eventRows = events(
    await client.request({
      action: "events.read",
      payload: {
        revision: 0,
        eventIndex: -1,
        limit: 256,
      },
    }),
  );
  const plannedActions = orchestrationPlan(
    await client.request({ action: "orchestration.plan", payload: {} }),
  );
  return Object.freeze({
    view: buildDashboardViewModel(current, eventRows),
    plannedActions: Object.freeze([...plannedActions]),
  });
}

function requiredRunId(input: ParentManagementRequest): string {
  if (input.runId === undefined || input.runId.length === 0) {
    throw new ParentManagementGatewayError(`${input.action} requires a runId`);
  }
  return input.runId;
}

export class ControllerParentManagementGateway implements ParentManagementGateway {
  readonly #clientFactory: ParentControllerClientFactory;
  readonly #launchHandler: ParentLaunchHandler | null;

  constructor(
    clientFactory: ParentControllerClientFactory,
    launchHandler: ParentLaunchHandler | null = null,
  ) {
    this.#clientFactory = clientFactory;
    this.#launchHandler = launchHandler;
  }

  async execute(
    input: ParentManagementRequest,
  ): Promise<ParentManagementResult> {
    if (input.action === "launch") {
      if (this.#launchHandler === null) {
        return Object.freeze({
          text: `Agentworks action "${input.action}" is not yet wired to the controller runtime.`,
          notificationType: "warning",
        });
      }
      return this.#launchHandler(input);
    }
    if (input.action !== "status") {
      return Object.freeze({
        text: `Agentworks action "${input.action}" is not yet wired to the controller runtime.`,
        notificationType: "warning",
      });
    }
    const runId = requiredRunId(input);
    const client = await this.#clientFactory(runId);
    try {
      const { view, plannedActions } = await readControllerDashboard(client);
      const attention = view.supervisorAttention
        .map((item) => `  ! ${item.agentId}: ${item.reason}`)
        .join("\n");
      const stories = Object.entries(view.run.storyStatusCounts)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${status}=${String(count)}`)
        .join(", ");
      return Object.freeze({
        text: [
          `${view.run.title} [${view.run.complexity}] - ${view.run.status}`,
          `Stories: ${stories || "none"}`,
          `Agents: ${String(view.agents.length)}`,
          `Next: ${plannedActions.length > 0 ? plannedActions.join(", ") : "none"}`,
          attention.length > 0 ? `Attention:\n${attention}` : "Attention: none",
        ].join("\n"),
      });
    } finally {
      client.close();
    }
  }
}

/** Build a parent client factory from authenticated runtime discovery. */
export function createDiscoveredParentClientFactory(
  runtimeRoot: string,
  clientId?: string,
  clientKind: "parent" | "management" = "parent",
): ParentControllerClientFactory {
  return async (runId) => {
    const discovered: DiscoveredControllerRuntime | null =
      discoverControllerRuntime(runtimeRoot, runId);
    if (discovered === null) {
      throw new ParentManagementGatewayError(
        `no active controller found for run ${runId}`,
      );
    }
    const client = new UnixControllerClient({
      socketPath: discovered.descriptor.socketPath,
      runId,
      authToken: discovered.authToken,
      clientId: clientId ?? randomUUID(),
      clientKind,
      agentId: null,
    });
    await client.connect();
    return client;
  };
}

function launchRunId(input: ParentManagementRequest): string {
  return (
    input.runId ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  );
}

function launchTask(input: ParentManagementRequest): string {
  const task = input.task?.trim() ?? "";
  if (task.length === 0) {
    throw new ParentManagementGatewayError("launch requires a non-empty task");
  }
  return task;
}

/** Compose the parent surface with detached controller startup and run creation. */
export interface DiscoveredParentManagementGatewayOptions {
  readonly enableLiveComposition?: boolean;
  readonly herdrPath?: string;
  readonly managementPaneLauncher?: ParentManagementPaneLauncher | null;
}

export function createDiscoveredParentManagementGateway(
  runtimeRoot: string,
  repositoryRoot: string,
  options: DiscoveredParentManagementGatewayOptions = {},
): ParentManagementGateway {
  const clientFactory = createDiscoveredParentClientFactory(runtimeRoot);
  const managementPaneLauncher =
    options.managementPaneLauncher === undefined
      ? options.enableLiveComposition === true &&
        options.herdrPath !== undefined
        ? createManagementDashboardLauncher(options.herdrPath)
        : null
      : options.managementPaneLauncher;
  const bootstrapManagementPane = async (
    runId: string,
    origin: ManagementPaneOrigin | undefined,
  ): Promise<{ readonly text: string; readonly failed: boolean }> => {
    if (managementPaneLauncher === null) {
      return Object.freeze({ text: "", failed: false });
    }
    if (origin === undefined) {
      return Object.freeze({
        text: " Management pane recovery refused: the controller has no authoritative parent origin.",
        failed: true,
      });
    }
    try {
      const evidence = await managementPaneLauncher.ensure({
        runId,
        runtimeRoot,
        workspaceId: origin.workspaceId,
        parentTabId: origin.tabId,
        parentPaneId: origin.paneId,
      });
      return Object.freeze({
        text: ` Management pane: ${evidence.paneId}.`,
        failed: false,
      });
    } catch (error) {
      return Object.freeze({
        text: ` Management pane failed: ${
          error instanceof Error ? error.message : String(error)
        }. Retry with /agentworks status ${runId}.`,
        failed: true,
      });
    }
  };
  const launch = async (
    input: ParentManagementRequest,
  ): Promise<ParentManagementResult> => {
    const runId = launchRunId(input);
    const task = launchTask(input);
    const now = Date.now();
    const root = resolve(repositoryRoot);
    const selectedRuntime = input.runtime;
    const liveCompositionReady =
      options.enableLiveComposition === true && selectedRuntime !== undefined;
    if (
      liveCompositionReady &&
      (selectedRuntime.origin === undefined || managementPaneLauncher === null)
    ) {
      return Object.freeze({
        text: "Agentworks did not start because the originating Herdr pane or management dashboard launcher was unavailable.",
        notificationType: "error" as const,
      });
    }
    if (input.mode === "HIGH" && liveCompositionReady) {
      try {
        const repository = new GitCliRepositoryInspector().inspect(root);
        if (repository.headCommit === null) {
          return Object.freeze({
            text: `Agentworks did not start: ${root} has no Git commit. Create the repository's initial commit, then retry.`,
            notificationType: "error" as const,
          });
        }
      } catch (error) {
        return Object.freeze({
          text: `Agentworks did not start: ${root} is not a usable Git checkout (${error instanceof Error ? error.message : String(error)}).`,
          notificationType: "error" as const,
        });
      }
    }
    const supervisor = new DetachedControllerSupervisor({
      runtimeRoot,
      runId,
      environment: liveCompositionReady
        ? {
            AGENTWORKS_ENABLE_LIVE_ORCHESTRATION: "1",
            AGENTWORKS_WORKSPACE_ID: selectedRuntime.workspaceId,
            PI_PROVIDER: selectedRuntime.provider,
            PI_MODEL: selectedRuntime.model,
            PI_REASONING_LEVEL: selectedRuntime.thinking,
            AGENTWORKS_ALLOW_HOST_NETWORK: selectedRuntime.allowHostNetwork
              ? "1"
              : "0",
          }
        : {},
    });
    await supervisor.ensureRunning();
    const client = await clientFactory(runId);
    try {
      const draftRun = createRunState({
        id: runId,
        title: task,
        complexity: input.mode ?? "NORMAL",
        repositoryRoot: root,
        originalCheckout: root,
        baseBranch: "main",
        integrationBranch: integrationBranchForRun(runId),
        integrationWorktree: `${runtimeRoot}/worktrees/${runId}/integration-worktree`,
        ...(selectedRuntime?.origin === undefined
          ? {}
          : {
              managementPaneOrigin: Object.freeze({
                workspaceId: selectedRuntime.workspaceId,
                tabId: selectedRuntime.origin.tabId,
                paneId: selectedRuntime.origin.paneId,
              }),
            }),
        createdAt: now,
      });
      const run = transitionRun(draftRun, {
        type: "plan-prepared",
        at: now,
      });
      const draftStory = createStoryState({
        id: `${runId}-story-1`,
        runId,
        title: task,
        branchName: storyBranchForRun(runId, `${runId}-story-1`),
        worktreePath: `${runtimeRoot}/worktrees/${runId}/story-1-worktree`,
        planning: {
          narrative: task,
          objective: task,
          taskKinds: ["software-development"],
          writable: true,
          scope: { included: ["repository"], excluded: ["secrets"] },
          technologyChoices: ["existing repository stack"],
          constraints: ["stay within the requested task scope"],
          dependencies: [],
          deliverables: [task],
          acceptanceCriteria: [task],
          validation: [{ command: "npm test", expected: "passes" }],
          escalationConditions: ["blocked by missing information or access"],
        },
        createdAt: now,
      });
      const story = transitionStory(draftStory, {
        type: "story-prepared",
        complexity: run.complexity,
        at: now,
      });
      const events: readonly ControllerEventInput[] = [
        {
          eventId: randomUUID(),
          type: "run-plan-prepared",
          entityType: "run",
          entityId: runId,
          payload: {
            title: task,
            complexity: run.complexity,
            status: run.status,
          },
          occurredAt: now,
        },
        {
          eventId: randomUUID(),
          type: "story-prepared",
          entityType: "story",
          entityId: story.id,
          payload: { title: task, status: story.status },
          occurredAt: now,
        },
      ];
      await client.request({
        action: "run.initialize",
        idempotencyKey: `run-initialize-${runId}`,
        payload: {
          run,
          stories: [story],
          agents: [],
          events,
        } as unknown as JsonValue,
      });
      const managementPane = await bootstrapManagementPane(
        runId,
        run.managementPaneOrigin,
      );
      if (managementPane.failed) {
        return Object.freeze({
          text: `Agentworks run ${runId} was saved, but no agent was started.${managementPane.text}`,
          notificationType: "error" as const,
        });
      }
      if (run.complexity === "HIGH") {
        if (!liveCompositionReady) {
          return Object.freeze({
            text: `Agentworks run ${runId} was saved, but no agent was started because the active Pi model or Herdr workspace was unavailable to the extension.${managementPane.text}`,
            notificationType: "error" as const,
          });
        }
        try {
          await client.request({
            action: "orchestration.execute",
            payload: {},
          });
          return Object.freeze({
            text: `Agentworks run ${runId} created and started for "${task}".${managementPane.text}`,
          });
        } catch (error) {
          if (!(
            error instanceof ControllerRemoteError &&
            error.code === "not-configured"
          )) {
            throw error;
          }
          return Object.freeze({
            text: `Agentworks run ${runId} created in planning state for "${task}". Live execution is not configured.${managementPane.text}`,
            notificationType: "warning" as const,
          });
        }
      }
      return Object.freeze({
        text: `Agentworks run ${runId} created in planning state for "${task}".${managementPane.text}`,
      });
    } finally {
      client.close();
    }
  };
  const gateway = new ControllerParentManagementGateway(clientFactory, launch);
  const readManagementPaneOrigin = async (
    runId: string,
  ): Promise<ManagementPaneOrigin | undefined> => {
    const client = await clientFactory(runId);
    try {
      const current = snapshot(
        await client.request({ action: "snapshot.get", payload: {} }),
      );
      return current.run.managementPaneOrigin;
    } finally {
      client.close();
    }
  };
  return Object.freeze({
    async execute(input: ParentManagementRequest) {
      const result = await gateway.execute(input);
      if (
        input.action !== "status" ||
        input.runId === undefined ||
        managementPaneLauncher === null
      ) {
        return result;
      }
      const managementPane = await bootstrapManagementPane(
        input.runId,
        await readManagementPaneOrigin(input.runId),
      );
      if (managementPane.text.length === 0) return result;
      return Object.freeze({
        text: `${result.text}${managementPane.text}`,
        ...(managementPane.failed
          ? { notificationType: "warning" as const }
          : result.notificationType === undefined
            ? {}
            : { notificationType: result.notificationType }),
      });
    },
  });
}
