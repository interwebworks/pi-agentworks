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
} from "../../domain/controller-state.ts";
import { DetachedControllerSupervisor } from "./detached-controller-supervisor.ts";
import { buildDashboardViewModel } from "../../application/tui/dashboard-view-model.ts";
import type { ControllerClientRequest } from "./unix-controller-transport.ts";
import { UnixControllerClient } from "./unix-controller-transport.ts";
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
      const view = buildDashboardViewModel(current, eventRows);
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
  clientId = randomUUID(),
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
      clientId,
      clientKind: "parent",
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
export function createDiscoveredParentManagementGateway(
  runtimeRoot: string,
  repositoryRoot: string,
): ParentManagementGateway {
  const clientFactory = createDiscoveredParentClientFactory(runtimeRoot);
  const launch = async (
    input: ParentManagementRequest,
  ): Promise<ParentManagementResult> => {
    const runId = launchRunId(input);
    const task = launchTask(input);
    const now = Date.now();
    const root = resolve(repositoryRoot);
    const supervisor = new DetachedControllerSupervisor({
      runtimeRoot,
      runId,
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
        integrationBranch: `agentworks/${runId}/integration`,
        integrationWorktree: `${runtimeRoot}/${runId}/integration-worktree`,
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
        branchName: `agentworks/${runId}/story-1`,
        worktreePath: `${runtimeRoot}/${runId}/story-1-worktree`,
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
      return Object.freeze({
        text: `Agentworks run ${runId} created in planning state for "${task}".`,
      });
    } finally {
      client.close();
    }
  };
  return new ControllerParentManagementGateway(clientFactory, launch);
}
