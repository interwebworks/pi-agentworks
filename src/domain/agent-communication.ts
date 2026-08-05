import { type JsonValue, isEmptyObject, toJsonValue } from "./workspace-naming.ts";

/**
 * Agent communication messages for lifecycle, operation, progress, and supervisor interactions.
 */

export const AGENT_COMMS_PROTOCOL_VERSION = 1 as const;

export const SESSION_STATE_READY = "ready";
export const SESSION_STATE_LAUNCHING = "launching";
export const SESSION_STATE_WAITING = "waiting";
export const SESSION_STATE_BLOCKED = "blocked";
export const SESSION_STATE_SHUTTING_DOWN = "shutting_down";

export const OPERATION_STATE_IDLE = "idle";
export const OPERATION_STATE_RUNNING = "running";
export const OPERATION_STATE_FAILED = "failed";
export const OPERATION_STATE_COMPLETE = "complete";

export type AgenticState =
  | { type: typeof SESSION_STATE_READY }
  | { type: typeof SESSION_STATE_LAUNCHING }
  | { type: typeof SESSION_STATE_WAITING; timeoutMs: number; reason?: string }
  | {
      type: typeof SESSION_STATE_BLOCKED;
      reason: string;
    }
  | {
      type: typeof SESSION_STATE_SHUTTING_DOWN;
    };

export type OperationState =
  | { type: typeof OPERATION_STATE_IDLE }
  | { type: typeof OPERATION_STATE_RUNNING }
  | { type: typeof OPERATION_STATE_COMPLETE; success: true; revision: number | null; exitCode: number | null }
  | {
      type: typeof OPERATION_STATE_FAILED;
      failed: true;
      reason: string;
      revision: number | null;
      exitCode: number | null;
    };

export interface SupervisorMessage {
  readonly type: "supervisor_message";
  readonly payload:
    | {
        type: "nudge";
        runId: string;
        agentId: string;
      }
    | {
        type: "completion";
        runId: string;
        agentId: string;
        outcome: "success" | "early" | "over";
      }
    | {
        type: "error";
        runId: string;
        agentId: string;
        code: string;
        message: string;
      };
}

export interface ResultMessage {
  readonly type: "result";
  readonly payload:
    | {
        stage: "launch" | "operation" | "completion" | "session" | "recovery";
        runId: string;
        agentId: string;
        output?: string | null;
        state?: AgenticState;
      }
    | {
        stage: "supervisor";
        runId: string;
        agentId: string;
        message: SupervisorMessage["payload"];
      };
}

export interface AgentHello {
  readonly protocolVersion: typeof AGENT_COMMS_PROTOCOL_VERSION;
  readonly runId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly state: AgenticState;
  readonly operation:
    | {
        state: typeof OPERATION_STATE_IDLE;
      }
    | {
        state: typeof OPERATION_STATE_RUNNING;
        taskId: string;
        revision: number | null;
      }
    | {
        state: typeof OPERATION_STATE_COMPLETE;
        revision: number | null;
        exitCode: number | null;
      }
    | {
        state: typeof OPERATION_STATE_FAILED;
        revision: number | null;
        exitCode: number | null;
        reason: string;
      };
}

export function assertAgentHelloPayload(
  value: unknown,
  maxDepth = 2,
  maxNodes = 1_000,
): asserts value is AgentHello | SupervisorMessage | ResultMessage {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new Error("JSON depth limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new Error("JSON node limit must be a positive safe integer");
  }

  const pending: { readonly value: unknown; readonly depth: number; readonly count: number }[] = [
    { value, depth: 0, count: 0 },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > maxDepth) {
      throw new Error(`JSON payload exceeds depth ${String(maxDepth)}`);
    }
    if (current.count > maxNodes) {
      throw new Error(`JSON payload exceeds ${String(maxNodes)} nodes`);
    }

    const item = current.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new Error("JSON payload numbers must be finite");
      }
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        pending.push({ value: child, depth: current.depth + 1, count: current.count + 1 });
      }
      continue;
    }
    if (typeof item === "object") {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("JSON payload objects must have a plain prototype");
      }
      for (const child of Object.values(item)) {
        pending.push({ value: child, depth: current.depth + 1, count: current.count + 1 });
      }
      continue;
    }
    throw new Error(`JSON payload contains unsupported value type ${typeof item}`);
  }
}

export function createAgentHelloPayload(
  runId: string,
  agentId: string,
  sessionId: string,
  state: AgenticState,
  operation: OperationState,
): AgentHello {
  return {
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    runId,
    agentId,
    sessionId,
    state,
    operation,
  };
}

export function createSupervisorMessagePayload(
  nudge: boolean,
  runId: string,
  agentId: string,
  completion?: "success" | "early" | "over",
  errorCode?: string,
  errorMessage?: string,
): SupervisorMessage["payload"] {
  if (nudge) {
    return {
      type: "nudge",
      runId,
      agentId,
    };
  }
  if (completion === "success") {
    return {
      type: "completion",
      runId,
      agentId,
      outcome: "success",
    };
  }
  if (completion === "early") {
    return {
      type: "completion",
      runId,
      agentId,
      outcome: "early",
    };
  }
  if (completion === "over") {
    return {
      type: "completion",
      runId,
      agentId,
      outcome: "over",
    };
  }
  if (errorCode) {
    return {
      type: "error",
      runId,
      agentId,
      code: errorCode,
      message: errorMessage ?? "",
    };
  }
  throw new Error("Invalid supervisor message type");
}

export function createResultMessagePayload(
  stage: ResultMessage["payload"]["stage"],
  runId: string,
  agentId: string,
  output?: string | null,
  state?: string | Record<string, unknown>,
  message?: SupervisorMessage["payload"],
): ResultMessage["payload"] {
  if (stage === "launch" || stage === "operation" || stage === "completion" || stage === "session") {
    return {
      type: "result",
      stage,
      runId,
      agentId,
      output,
      state: Array.isArray(state) ? state instanceof Map ? Array.from(state.entries()) : state : [state],
    };
  }
  if (stage === "recovery") {
    return {
      type: "result",
      stage,
      runId,
      agentId,
      output,
      state: Array.isArray(state) ? state instanceof Map ? Array.from(state.entries()) : state : [state],
    };
  }
  if (stage === "supervisor") {
    return {
      type: "result",
      stage,
      runId,
      agentId,
      message,
    };
  }
  throw new Error("Invalid result stage");
}

export function createAgentHello(
  runId: string,
  agentId: string,
  sessionId: string,
  state: AgenticState,
  operation: OperationState,
): string {
  const hello = createAgentHelloPayload(runId, agentId, sessionId, state, operation);
  return JSON.stringify(hello);
}

export function parseAgentHello(text: string): AgentHello | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && !Array.isArray(parsed) ? parsed as AgentHello : null;
  } catch {
    return null;
  }
}

export function createSessionShutdownMessage(runId: string, agentId: string): string {
  const shutdown = {
    type: "session_shutdown",
    runId,
    agentId,
    sessionId: "shutdown-marker",
  };
  return JSON.stringify(shutdown);
}
