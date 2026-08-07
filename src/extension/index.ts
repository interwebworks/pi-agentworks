import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  installChildBridge,
  installChildLockdown,
  resolveChildModeConfiguration,
  type ChildModeEnvironment,
} from "./child-mode.ts";
import {
  AgentworksToolInputSchema,
  parseAgentworksCommand,
  parseAgentworksToolInput,
  type ParentManagementGateway,
  type ParentManagementRequest,
  type ParentManagementResult,
} from "./parent-command.ts";
import { createDiscoveredParentManagementGateway } from "../infrastructure/controller/parent-management-gateway.ts";
import { resolveAgentworksRuntimeRoot } from "../infrastructure/controller/runtime-root.ts";

/**
 * Agentworks package entrypoint.
 *
 * The package remains completely dormant during ordinary Pi sessions until the
 * parent-extension backlog slice is complete.
 * A controller-launched sandbox selects child mode with an exact environment
 * marker and a private per-agent authentication capability.
 */
export default function agentworks(pi: ExtensionAPI): void {
  const environment: ChildModeEnvironment = process.env;
  if (environment.AGENTWORKS_CHILD_MODE !== "1") {
    installParentExtension(pi, createParentGateway(environment));
    return;
  }
  try {
    const child = resolveChildModeConfiguration(environment);
    if (child === null) {
      installChildLockdown(pi);
      return;
    }
    installChildBridge(pi, child);
  } catch {
    installChildLockdown(pi);
  }
}

/**
 * Registers the parent-Pi surface: the `/agentworks` command and the
 * model-callable `agentworks` tool. Parent sessions use the private default
 * runtime root unless an explicit runtime-root override is configured.
 */
function createParentGateway(
  environment: ChildModeEnvironment,
): ParentManagementGateway | null {
  return createDiscoveredParentManagementGateway(
    resolveAgentworksRuntimeRoot(environment),
    process.cwd(),
    { enableLiveComposition: true },
  );
}

function withLaunchRuntime(
  request: ParentManagementRequest,
  context: Pick<ExtensionContext, "model" | "thinkingLevel">,
): ParentManagementRequest {
  if (request.action !== "launch" || context.model === undefined) {
    return request;
  }
  const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
  if (workspaceId === undefined || workspaceId.length === 0) return request;
  return Object.freeze({
    ...request,
    runtime: {
      workspaceId,
      provider: context.model.provider,
      model: context.model.id,
      thinking: context.thinkingLevel ?? "off",
      // Model calls must reach either a host-local or remote provider. This
      // temporarily gives the child host networking while egress mediation is
      // still under development.
      allowHostNetwork: true,
    },
  });
}

function gatewayFailure(error: unknown): ParentManagementResult {
  return {
    text: `Agentworks controller request failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    notificationType: "error",
  };
}

function updateParentStatusWidget(
  ui: ExtensionUIContext,
  result: ParentManagementResult,
): void {
  const lines = result.text
    .split("\n")
    .slice(0, 4)
    .map((line) => (line.length > 120 ? `${line.slice(0, 117)}...` : line));
  const headline = lines[0] ?? "idle";
  const marker = result.notificationType === "error" ? "!" : "•";
  ui.setStatus("agentworks", `Agentworks ${marker} ${headline}`);
  ui.setWidget("agentworks-status", lines, { placement: "belowEditor" });
}

export function installParentExtension(
  pi: ExtensionAPI,
  gateway: ParentManagementGateway | null = null,
): void {
  pi.registerCommand("agentworks", {
    description:
      "Launch or inspect an Agentworks run. Usage: /agentworks [LOW|NORMAL|HIGH] <task> or /agentworks status <runId>",
    handler(args, ctx) {
      const { action, mode, task, runId } = parseAgentworksCommand(args);
      if (gateway !== null) {
        return gateway
          .execute(
            withLaunchRuntime(
              {
                action: action ?? "launch",
                ...(mode === null ? {} : { mode }),
                ...(task.length === 0 ? {} : { task }),
                ...(runId === undefined ? {} : { runId }),
              },
              ctx,
            ),
          )
          .catch(gatewayFailure)
          .then((result) => {
            updateParentStatusWidget(ctx.ui, result);
            ctx.ui.notify(result.text, result.notificationType ?? "info");
          });
      }
      const modeLabel = mode ?? "(default)";
      ctx.ui.notify(
        action === "status"
          ? "Agentworks: status requires a run id, e.g. /agentworks status run-123."
          : task.length > 0
            ? `Agentworks: would launch a ${modeLabel} run for "${task}", but this is not yet wired to the controller runtime.`
            : "Agentworks: not yet wired to the controller runtime. Provide a task, e.g. /agentworks NORMAL build the thing.",
        "info",
      );
      return Promise.resolve();
    },
  });

  pi.registerTool({
    name: "agentworks",
    label: "Agentworks",
    description:
      "Launch, inspect, or steer an Agentworks multi-agent run. Actions: " +
      "launch, status, approve, reject, steer, pause, resume, focus, close. " +
      "Not yet wired to the controller runtime.",
    parameters: AgentworksToolInputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const input = parseAgentworksToolInput(params);
      const result =
        gateway === null
          ? {
              text: `Agentworks action "${input.action}" is not yet wired to the controller runtime.`,
            }
          : await gateway
              .execute(withLaunchRuntime(input, context))
              .catch(gatewayFailure);
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: undefined,
      };
    },
  });
}
