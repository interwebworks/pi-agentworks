/**
 * Structured messages exchanged between the controller and a child agent
 * session over the newline-delimited transport (see agent-message-codec.ts).
 */

export const AGENT_COMMS_PROTOCOL_VERSION = 1 as const;

export type BlockerReason = "idle" | "blocked" | "timeout";
export type CompletionOutcome = "success" | "early" | "over";

export interface SessionStartedMessage {
  readonly protocolVersion: 1;
  readonly type: "session-started";
  readonly runId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly piSessionPath: string | null;
}

export interface SessionShutdownMessage {
  readonly protocolVersion: 1;
  readonly type: "session-shutdown";
  readonly runId: string;
  readonly agentId: string;
  readonly sessionId: string;
}

export interface OperationStartedMessage {
  readonly protocolVersion: 1;
  readonly type: "operation-started";
  readonly runId: string;
  readonly agentId: string;
  readonly taskId: string | null;
}

export interface OperationProgressMessage {
  readonly protocolVersion: 1;
  readonly type: "operation-progress";
  readonly runId: string;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly output: string | null;
}

export interface OperationCompletedMessage {
  readonly protocolVersion: 1;
  readonly type: "operation-completed";
  readonly runId: string;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly success: boolean;
  readonly revision: number | null;
}

export interface HeartbeatMessage {
  readonly protocolVersion: 1;
  readonly type: "heartbeat";
  readonly runId: string;
  readonly agentId: string;
  readonly elapsedMs: number;
  readonly revision: number | null;
}

export interface AgentBlockedMessage {
  readonly protocolVersion: 1;
  readonly type: "agent-blocked";
  readonly runId: string;
  readonly agentId: string;
  readonly reason: BlockerReason;
  readonly detail: string;
}

/** A writer asks the controller to inspect and commit its worktree. */
export interface CandidateReadyMessage {
  readonly protocolVersion: 1;
  readonly type: "candidate-ready";
  readonly runId: string;
  readonly agentId: string;
}

/** A reviewer reports the exact controller-supplied heads it inspected. */
export interface ReviewSubmittedMessage {
  readonly protocolVersion: 1;
  readonly type: "review-submitted";
  readonly runId: string;
  readonly agentId: string;
  readonly outcome: "approved" | "changes-requested";
  readonly candidateStoryHead: string;
  readonly integrationHead: string;
}

export interface SupervisorNudgeMessage {
  readonly protocolVersion: 1;
  readonly type: "supervisor-nudge";
  readonly runId: string;
  readonly agentId: string;
  readonly reason: BlockerReason;
}

export interface SupervisorCompletionMessage {
  readonly protocolVersion: 1;
  readonly type: "supervisor-completion";
  readonly runId: string;
  readonly agentId: string;
  readonly outcome: CompletionOutcome;
  readonly revision: number | null;
}

export interface SupervisorErrorMessage {
  readonly protocolVersion: 1;
  readonly type: "supervisor-error";
  readonly runId: string;
  readonly agentId: string;
  readonly code: string;
  readonly message: string;
}

export type LifecycleMessage = SessionStartedMessage | SessionShutdownMessage;

export type OperationMessage =
  | OperationStartedMessage
  | OperationProgressMessage
  | OperationCompletedMessage;

export type SupervisorMessage =
  SupervisorNudgeMessage | SupervisorCompletionMessage | SupervisorErrorMessage;

export type AgentMessage =
  | LifecycleMessage
  | OperationMessage
  | HeartbeatMessage
  | AgentBlockedMessage
  | CandidateReadyMessage
  | ReviewSubmittedMessage
  | SupervisorMessage;

export function sessionStarted(
  runId: string,
  agentId: string,
  sessionId: string,
  piSessionPath: string | null = null,
): SessionStartedMessage {
  return Object.freeze({
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    type: "session-started",
    runId,
    agentId,
    sessionId,
    piSessionPath,
  });
}

export function sessionShutdown(
  runId: string,
  agentId: string,
  sessionId: string,
): SessionShutdownMessage {
  return Object.freeze({
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    type: "session-shutdown",
    runId,
    agentId,
    sessionId,
  });
}

export function operationStarted(
  runId: string,
  agentId: string,
  taskId: string | null = null,
): OperationStartedMessage {
  return Object.freeze({
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    type: "operation-started",
    runId,
    agentId,
    taskId,
  });
}

export function operationProgress(
  runId: string,
  agentId: string,
  output: string | null,
  taskId: string | null = null,
): OperationProgressMessage {
  return Object.freeze({
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    type: "operation-progress",
    runId,
    agentId,
    taskId,
    output,
  });
}

export function operationCompleted(
  runId: string,
  agentId: string,
  success: boolean,
  revision: number | null = null,
  taskId: string | null = null,
): OperationCompletedMessage {
  return Object.freeze({
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    type: "operation-completed",
    runId,
    agentId,
    taskId,
    success,
    revision,
  });
}

export function heartbeat(
  runId: string,
  agentId: string,
  elapsedMs: number,
  revision: number | null = null,
): HeartbeatMessage {
  return Object.freeze({
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    type: "heartbeat",
    runId,
    agentId,
    elapsedMs,
    revision,
  });
}

export function agentBlocked(
  runId: string,
  agentId: string,
  reason: BlockerReason,
  detail: string,
): AgentBlockedMessage {
  return Object.freeze({
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    type: "agent-blocked",
    runId,
    agentId,
    reason,
    detail,
  });
}

export function candidateReady(
  runId: string,
  agentId: string,
): CandidateReadyMessage {
  return Object.freeze({
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    type: "candidate-ready",
    runId,
    agentId,
  });
}

export function reviewSubmitted(
  runId: string,
  agentId: string,
  outcome: ReviewSubmittedMessage["outcome"],
  candidateStoryHead: string,
  integrationHead: string,
): ReviewSubmittedMessage {
  return Object.freeze({
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    type: "review-submitted",
    runId,
    agentId,
    outcome,
    candidateStoryHead,
    integrationHead,
  });
}
