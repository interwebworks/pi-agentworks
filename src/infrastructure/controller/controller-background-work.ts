import { DatabaseSync } from "node:sqlite";
import type { AgentStatus, RunStatus } from "../../domain/controller-state.ts";
import { occupiesAgentCapacity } from "../../domain/scheduling.ts";
import {
  discoverControllerRuntime,
  readProcessStartIdentity,
} from "./controller-runtime.ts";

const ALL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "planning",
  "awaiting-approval",
  "ready",
  "active",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const ALL_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "planned",
  "launching",
  "idle",
  "working",
  "waiting",
  "blocked",
  "reviewing",
  "completed",
  "failed",
  "disconnected",
  "closed",
]);

interface StatusRow {
  readonly status: string;
}

function processMatches(
  processId: number,
  processStartIdentity: string | null,
): boolean {
  try {
    process.kill(processId, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  return (
    processStartIdentity === null ||
    readProcessStartIdentity(processId) === processStartIdentity
  );
}

/**
 * Synchronously probe whether a securely discovered controller owns unclosed
 * agent work that Pi should continue waiting for.
 *
 * The probe is deliberately read-only and has no launch or controller command
 * authority. Callers retain a tracked item when this function throws so an
 * observation failure cannot hide possibly active work.
 */
export function isControllerRunBackgroundWorkActive(
  runtimeRoot: string,
  runId: string,
  now = Date.now(),
): boolean {
  const discovered = discoverControllerRuntime(runtimeRoot, runId);
  if (discovered === null) return false;
  const descriptor = discovered.descriptor;
  if (
    descriptor.leaseExpiresAt <= now ||
    !processMatches(descriptor.processId, descriptor.processStartIdentity)
  ) {
    return false;
  }

  const database = new DatabaseSync(descriptor.databasePath, {
    readOnly: true,
  });
  try {
    const run = database
      .prepare("SELECT status FROM runs WHERE run_id = ?")
      .get(runId) as unknown as StatusRow | undefined;
    if (run === undefined) return false;
    if (!ALL_RUN_STATUSES.has(run.status as RunStatus)) {
      throw new Error(`Controller run ${runId} has an invalid status`);
    }
    if (TERMINAL_RUN_STATUSES.has(run.status as RunStatus)) return false;

    const agents = database
      .prepare("SELECT status FROM agents WHERE run_id = ?")
      .all(runId) as unknown as readonly StatusRow[];
    if (
      agents.some(
        (agent) => !ALL_AGENT_STATUSES.has(agent.status as AgentStatus),
      )
    ) {
      throw new Error(`Controller run ${runId} has an invalid agent status`);
    }
    return agents.some((agent) =>
      occupiesAgentCapacity(agent.status as AgentStatus),
    );
  } finally {
    database.close();
  }
}
