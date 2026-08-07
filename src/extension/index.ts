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
import { isControllerRunBackgroundWorkActive } from "../infrastructure/controller/controller-background-work.ts";
import {
  installAgentworksBackgroundWork,
  type AgentworksBackgroundWorkOptions,
} from "./background-work.ts";

/**
 * Agentworks package entrypoint.
 *
 * Ordinary parent sessions expose the Agentworks command, tool, and read-only
 * background-work visibility.
 * A controller-launched sandbox selects child mode with an exact environment
 * marker and a private per-agent authentication capability.
 */
export default function agentworks(pi: ExtensionAPI): void {
  const environment: ChildModeEnvironment = process.env;
  if (environment.AGENTWORKS_CHILD_MODE !== "1") {
    const runtimeRoot = resolveAgentworksRuntimeRoot(environment);
    installParentExtension(pi, createParentGateway(environment, runtimeRoot), {
      isRunActive: (runId) =>
        isControllerRunBackgroundWorkActive(runtimeRoot, runId),
    });
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
  runtimeRoot: string,
): ParentManagementGateway | null {
  const configuredHerdrPath = environment.AGENTWORKS_HERDR_PATH?.trim();
  const herdrPath =
    configuredHerdrPath === undefined || configuredHerdrPath.length === 0
      ? "herdr"
      : configuredHerdrPath;
  return createDiscoveredParentManagementGateway(runtimeRoot, process.cwd(), {
    enableLiveComposition: true,
    herdrPath,
  });
}

function withLaunchRuntime(
  request: ParentManagementRequest,
  context: Pick<ExtensionContext, "model" | "thinkingLevel"> | undefined,
): ParentManagementRequest {
  if (
    (request.action !== "launch" && request.action !== "status") ||
    context?.model === undefined
  ) {
    return request;
  }
  const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
  if (workspaceId === undefined || workspaceId.length === 0) return request;
  const tabId = process.env.HERDR_TAB_ID?.trim();
  const paneId = process.env.HERDR_PANE_ID?.trim();
  const origin =
    tabId === undefined ||
    tabId.length === 0 ||
    paneId === undefined ||
    paneId.length === 0
      ? undefined
      : Object.freeze({ tabId, paneId });
  return Object.freeze({
    ...request,
    runtime: {
      workspaceId,
      ...(origin === undefined ? {} : { origin }),
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
  backgroundWorkOptions: AgentworksBackgroundWorkOptions = {
    isRunActive: () => false,
  },
): void {
  const backgroundWork = installAgentworksBackgroundWork(
    pi,
    backgroundWorkOptions,
  );
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
            if (result.launchedRunId !== undefined) {
              backgroundWork.recordLaunchedRun(result.launchedRunId, ctx);
            }
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
      if (result.launchedRunId !== undefined) {
        backgroundWork.recordLaunchedRun(result.launchedRunId, context);
      }
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: undefined,
      };
    },
  });
}
