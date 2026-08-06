import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_AGENTWORKS_RUNTIME_ROOT = join(
  homedir(),
  ".pi",
  "agent",
  "agentworks",
  "runtime",
);

export class InvalidAgentworksRuntimeRootError extends Error {
  constructor(message: string) {
    super(`Invalid Agentworks runtime root: ${message}`);
    this.name = "InvalidAgentworksRuntimeRootError";
  }
}

/**
 * Resolve the private controller runtime location used by the parent Pi
 * extension. An explicit environment value remains an escape hatch for
 * isolated deployments; ordinary Pi sessions need no configuration.
 */
export function resolveAgentworksRuntimeRoot(environment: {
  readonly AGENTWORKS_RUNTIME_ROOT?: string;
}): string {
  const configured = environment.AGENTWORKS_RUNTIME_ROOT;
  if (configured === undefined) return DEFAULT_AGENTWORKS_RUNTIME_ROOT;
  if (configured.trim().length === 0) {
    throw new InvalidAgentworksRuntimeRootError(
      "AGENTWORKS_RUNTIME_ROOT cannot be empty",
    );
  }
  return resolve(configured);
}
