import { randomUUID } from "node:crypto";
import type {
  ControllerEventRecord,
  ControllerSnapshot,
  JsonValue,
} from "../../application/ports/controller-repository.ts";
import type {
  ParentManagementGateway,
  ParentManagementRequest,
  ParentManagementResult,
} from "../../application/ports/parent-management.ts";
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

function requiredRunId(input: ParentManagementRequest): string {
  if (input.runId === undefined || input.runId.length === 0) {
    throw new ParentManagementGatewayError(`${input.action} requires a runId`);
  }
  return input.runId;
}

export class ControllerParentManagementGateway implements ParentManagementGateway {
  readonly #clientFactory: ParentControllerClientFactory;

  constructor(clientFactory: ParentControllerClientFactory) {
    this.#clientFactory = clientFactory;
  }

  async execute(
    input: ParentManagementRequest,
  ): Promise<ParentManagementResult> {
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
            after: { revision: 0, eventIndex: -1 },
            limit: 256,
          },
        }),
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
