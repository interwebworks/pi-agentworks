import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Agentworks package entrypoint.
 *
 * Runtime registration is added in the parent-extension backlog slice.
 * Keeping this entrypoint inert prevents an incomplete package from advertising
 * commands that cannot yet satisfy the product contract.
 */
export default function agentworks(pi: ExtensionAPI): void {
  void pi;
}
