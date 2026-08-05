import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  installChildBridge,
  installChildLockdown,
  resolveChildModeConfiguration,
  type ChildModeEnvironment,
} from "./child-mode.ts";

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
  if (environment.AGENTWORKS_CHILD_MODE !== "1") return;
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
