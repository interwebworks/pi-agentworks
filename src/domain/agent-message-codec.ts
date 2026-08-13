import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { AgentMessage } from "./agent-communication.ts";

const MAX_ENCODED_BYTES = 64 * 1024;

const ProtocolVersion = Type.Literal(1);
const RunId = Type.String({ minLength: 1, maxLength: 256 });
const AgentId = Type.String({ minLength: 1, maxLength: 256 });
const NullableString = Type.Union([
  Type.String({ maxLength: 65536 }),
  Type.Null(),
]);
const NullableRevision = Type.Union([Type.Integer(), Type.Null()]);
const BlockerReasonSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("blocked"),
  Type.Literal("timeout"),
]);
const CompletionOutcomeSchema = Type.Union([
  Type.Literal("success"),
  Type.Literal("early"),
  Type.Literal("over"),
]);
const GitObjectId = Type.String({
  minLength: 40,
  maxLength: 64,
  pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
});

const SessionStartedSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("session-started"),
    runId: RunId,
    agentId: AgentId,
    sessionId: Type.String({ minLength: 1, maxLength: 256 }),
    piSessionPath: Type.Union([
      Type.String({ minLength: 1, maxLength: 4096 }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

const SessionShutdownSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("session-shutdown"),
    runId: RunId,
    agentId: AgentId,
    sessionId: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

const OperationStartedSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("operation-started"),
    runId: RunId,
    agentId: AgentId,
    taskId: Type.Union([
      Type.String({ minLength: 1, maxLength: 256 }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

const OperationProgressSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("operation-progress"),
    runId: RunId,
    agentId: AgentId,
    taskId: Type.Union([
      Type.String({ minLength: 1, maxLength: 256 }),
      Type.Null(),
    ]),
    output: NullableString,
  },
  { additionalProperties: false },
);

const OperationCompletedSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("operation-completed"),
    runId: RunId,
    agentId: AgentId,
    taskId: Type.Union([
      Type.String({ minLength: 1, maxLength: 256 }),
      Type.Null(),
    ]),
    success: Type.Boolean(),
    revision: NullableRevision,
  },
  { additionalProperties: false },
);

const HeartbeatSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("heartbeat"),
    runId: RunId,
    agentId: AgentId,
    elapsedMs: Type.Integer({ minimum: 0 }),
    revision: NullableRevision,
  },
  { additionalProperties: false },
);

const AgentBlockedSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("agent-blocked"),
    runId: RunId,
    agentId: AgentId,
    reason: BlockerReasonSchema,
    detail: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { additionalProperties: false },
);

const AgentUnblockedSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("agent-unblocked"),
    runId: RunId,
    agentId: AgentId,
    operation: Type.String({ minLength: 1, maxLength: 4_096 }),
  },
  { additionalProperties: false },
);

const CandidateReadySchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("candidate-ready"),
    runId: RunId,
    agentId: AgentId,
  },
  { additionalProperties: false },
);

const ReviewSubmittedSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("review-submitted"),
    runId: RunId,
    agentId: AgentId,
    outcome: Type.Union([
      Type.Literal("approved"),
      Type.Literal("changes-requested"),
    ]),
    candidateStoryHead: GitObjectId,
    integrationHead: GitObjectId,
  },
  { additionalProperties: false },
);

const SupervisorNudgeSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("supervisor-nudge"),
    runId: RunId,
    agentId: AgentId,
    reason: BlockerReasonSchema,
  },
  { additionalProperties: false },
);

const SupervisorCompletionSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("supervisor-completion"),
    runId: RunId,
    agentId: AgentId,
    outcome: CompletionOutcomeSchema,
    revision: NullableRevision,
  },
  { additionalProperties: false },
);

const SupervisorErrorSchema = Type.Object(
  {
    protocolVersion: ProtocolVersion,
    type: Type.Literal("supervisor-error"),
    runId: RunId,
    agentId: AgentId,
    code: Type.String({ minLength: 1, maxLength: 128 }),
    message: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { additionalProperties: false },
);

const AgentMessageSchema = Type.Union([
  SessionStartedSchema,
  SessionShutdownSchema,
  OperationStartedSchema,
  OperationProgressSchema,
  OperationCompletedSchema,
  HeartbeatSchema,
  AgentBlockedSchema,
  AgentUnblockedSchema,
  CandidateReadySchema,
  ReviewSubmittedSchema,
  SupervisorNudgeSchema,
  SupervisorCompletionSchema,
  SupervisorErrorSchema,
]);

export class InvalidAgentMessageError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid agent message:\n- ${issues.join("\n- ")}`);
    this.name = "InvalidAgentMessageError";
    this.issues = issues;
  }
}

function schemaIssues(value: unknown): string[] {
  return [...Errors(AgentMessageSchema, value)].map((issue) => {
    const location = issue.instancePath.length > 0 ? issue.instancePath : "/";
    return `${location}: ${issue.message}`;
  });
}

export function encodeAgentMessage(message: AgentMessage): string {
  if (!Check(AgentMessageSchema, message)) {
    throw new InvalidAgentMessageError(schemaIssues(message));
  }
  const encoded = JSON.stringify(message);
  if (encoded.includes("\n")) {
    throw new InvalidAgentMessageError([
      "encoded message must not contain a newline",
    ]);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_BYTES) {
    throw new InvalidAgentMessageError([
      `encoded message exceeds ${String(MAX_ENCODED_BYTES)} bytes`,
    ]);
  }
  return encoded;
}

export function decodeAgentMessage(text: string): AgentMessage {
  if (Buffer.byteLength(text, "utf8") > MAX_ENCODED_BYTES) {
    throw new InvalidAgentMessageError([
      `message exceeds ${String(MAX_ENCODED_BYTES)} bytes`,
    ]);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidAgentMessageError(["message is not valid JSON"]);
  }

  if (!Check(AgentMessageSchema, value)) {
    throw new InvalidAgentMessageError(schemaIssues(value));
  }

  return Object.freeze(value);
}

export function frameAgentMessage(message: AgentMessage): string {
  return `${encodeAgentMessage(message)}\n`;
}

export interface ReadAgentMessageFramesResult {
  readonly messages: readonly AgentMessage[];
  readonly rest: string;
}

export function readAgentMessageFrames(
  buffer: string,
): ReadAgentMessageFramesResult {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  if (Buffer.byteLength(rest, "utf8") > MAX_ENCODED_BYTES) {
    throw new InvalidAgentMessageError([
      `partial message exceeds ${String(MAX_ENCODED_BYTES)} bytes`,
    ]);
  }
  const messages = lines
    .filter((line) => line.length > 0)
    .map((line) => decodeAgentMessage(line));
  return Object.freeze({ messages: Object.freeze(messages), rest });
}
