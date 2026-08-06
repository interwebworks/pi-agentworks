import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
} from "./parent-command.ts";

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
    installParentExtension(pi);
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
 * model-callable `agentworks` tool. Neither is wired to the controller
 * runtime yet — both report a clear "not yet wired" stub until the
 * controller-launch slice lands.
 */
export function installParentExtension(pi: ExtensionAPI): void {
  pi.registerCommand("agentworks", {
    description:
      "Launch or inspect an Agentworks run. Usage: /agentworks [LOW|NORMAL|HIGH] <task>",
    handler(args, ctx) {
      const { mode, task } = parseAgentworksCommand(args);
      const modeLabel = mode ?? "(default)";
      ctx.ui.notify(
        task.length > 0
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
    execute(_toolCallId, params) {
      const input = parseAgentworksToolInput(params);
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: `Agentworks action "${input.action}" is not yet wired to the controller runtime.`,
          },
        ],
        details: undefined,
      });
    },
  });
}
