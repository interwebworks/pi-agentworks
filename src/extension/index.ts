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
import { HerdrCliGateway } from "../infrastructure/herdr/herdr-cli-gateway.ts";
import { PaneFocusService } from "../application/herdr/pane-focus-service.ts";
import { resolveAgentworksRuntimeRoot } from "../infrastructure/controller/runtime-root.ts";
import { isControllerRunBackgroundWorkActive } from "../infrastructure/controller/controller-background-work.ts";
import {
  installAgentworksBackgroundWork,
  type AgentworksBackgroundWorkOptions,
} from "./background-work.ts";
import {
  createParentModelPlanner,
  type ParentLaunchPlanner,
} from "./parent-model-planner.ts";

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
  const herdr = new HerdrCliGateway({ herdrPath });
  const paneFocus = new PaneFocusService(herdr);
  const assertOwnedPane = async (
    runId: string,
    agentId: string,
    paneId: string,
  ) => {
    const pane = await herdr.getPane(paneId);
    if (
      pane.tokens.aw_kind !== "agent" ||
      pane.tokens.aw_run !== runId ||
      pane.tokens.aw_agent !== agentId
    ) {
      throw new Error(
        "Herdr pane ownership does not match the controller agent",
      );
    }
    return pane;
  };
  return createDiscoveredParentManagementGateway(runtimeRoot, process.cwd(), {
    enableLiveComposition: true,
    herdrPath,
    agentControl: {
      async focus({ runId, agent }) {
        if (agent.paneId === null) throw new Error("Agent has no live pane");
        await assertOwnedPane(runId, agent.id, agent.paneId);
        await paneFocus.focus(agent.paneId);
      },
      async steer({ runId, agent, message }) {
        if (agent.paneId === null) throw new Error("Agent has no live pane");
        await assertOwnedPane(runId, agent.id, agent.paneId);
        await herdr.sendText(agent.paneId, `${message}\n`);
      },
      async close({ runId, agent }) {
        if (agent.paneId === null) return;
        await assertOwnedPane(runId, agent.id, agent.paneId);
        await herdr.closePane(agent.paneId);
      },
    },
  });
}

function withLaunchRuntime(
  request: ParentManagementRequest,
  context: Pick<ExtensionContext, "model" | "thinkingLevel"> | undefined,
): ParentManagementRequest {
  if (request.action !== "launch" || context?.model === undefined) {
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
      // Keep child task tools network-isolated by default. A role pack may
      // explicitly request network access; the parent must not widen every
      // child implicitly.
      allowHostNetwork: false,
    },
  });
}

async function prepareLaunchRequest(
  request: ParentManagementRequest,
  context: ExtensionContext,
  planner: ParentLaunchPlanner,
): Promise<ParentManagementRequest> {
  const withRuntime = withLaunchRuntime(request, context);
  if (withRuntime.action !== "launch") return withRuntime;
  // This only accommodates minimal extension test doubles. Pi always supplies
  // a model registry to a live extension context.
  if (!("modelRegistry" in context)) return withRuntime;
  const task = withRuntime.task?.trim();
  if (task === undefined || task.length === 0) return withRuntime;
  const plan = await planner.plan({
    task,
    mode: withRuntime.mode ?? "NORMAL",
    context,
  });
  return Object.freeze({ ...withRuntime, plan });
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
  planner: ParentLaunchPlanner = createParentModelPlanner(),
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
        return prepareLaunchRequest(
          {
            action: action ?? "launch",
            ...(mode === null ? {} : { mode }),
            ...(task.length === 0 ? {} : { task }),
            ...(runId === undefined ? {} : { runId }),
          },
          ctx,
          planner,
        )
          .then((request) => gateway.execute(request))
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
            ? `Agentworks: launch of a ${modeLabel} run for "${task}" requires an active controller gateway.`
            : "Agentworks: an active controller gateway is required. Provide a task, e.g. /agentworks NORMAL build the thing.",
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
      "launch, status, approve, reject, steer, pause, resume, focus, close.",
    parameters: AgentworksToolInputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const input = parseAgentworksToolInput(params);
      const result =
        gateway === null
          ? {
              text: `Agentworks action "${input.action}" requires an active controller gateway.`,
            }
          : await prepareLaunchRequest(input, context, planner)
              .then((request) => gateway.execute(request))
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
