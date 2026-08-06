import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
  parseComplexityMode,
  type ComplexityMode,
} from "../domain/complexity.ts";

export interface ParsedAgentworksCommand {
  readonly mode: ComplexityMode | null;
  readonly task: string;
}

/**
 * Parses the `/agentworks` command argument line.
 *
 * `/agentworks` alone (empty/whitespace-only argsLine) yields `{mode: null, task: ""}`.
 * When the first whitespace-delimited token parses as a complexity mode
 * (case-insensitive), it is consumed as the mode and the remainder becomes the
 * task. Otherwise the whole trimmed line is the task and mode is null.
 */
export function parseAgentworksCommand(
  argsLine: string,
): ParsedAgentworksCommand {
  const trimmed = argsLine.trim();
  if (trimmed.length === 0) return Object.freeze({ mode: null, task: "" });

  const firstSpaceIndex = trimmed.search(/\s/u);
  const firstToken =
    firstSpaceIndex === -1 ? trimmed : trimmed.slice(0, firstSpaceIndex);
  const remainder =
    firstSpaceIndex === -1 ? "" : trimmed.slice(firstSpaceIndex + 1).trim();

  try {
    const mode = parseComplexityMode(firstToken);
    return Object.freeze({ mode, task: remainder });
  } catch {
    return Object.freeze({ mode: null, task: trimmed });
  }
}

export const AGENTWORKS_TOOL_ACTIONS = [
  "launch",
  "status",
  "approve",
  "reject",
  "steer",
  "pause",
  "resume",
  "focus",
  "close",
] as const;

const AgentworksToolActionSchema = Type.Union([
  Type.Literal("launch"),
  Type.Literal("status"),
  Type.Literal("approve"),
  Type.Literal("reject"),
  Type.Literal("steer"),
  Type.Literal("pause"),
  Type.Literal("resume"),
  Type.Literal("focus"),
  Type.Literal("close"),
]);

export const AgentworksToolInputSchema = Type.Object(
  {
    action: AgentworksToolActionSchema,
    mode: Type.Optional(
      Type.Union([
        Type.Literal("LOW"),
        Type.Literal("NORMAL"),
        Type.Literal("HIGH"),
      ]),
    ),
    task: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
    runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  },
  { additionalProperties: false },
);

export type AgentworksToolInput = Static<typeof AgentworksToolInputSchema>;

export class InvalidAgentworksToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentworksToolInputError";
  }
}

export function parseAgentworksToolInput(value: unknown): AgentworksToolInput {
  if (!Check(AgentworksToolInputSchema, value)) {
    throw new InvalidAgentworksToolInputError(
      "Invalid agentworks tool input: expected an object with a valid " +
        `action (one of ${AGENTWORKS_TOOL_ACTIONS.join(", ")}) and optional ` +
        "mode/task/runId/message fields",
    );
  }
  return Object.freeze(value);
}

export interface ParentManagementResult {
  readonly text: string;
  readonly notificationType?: "info" | "warning" | "error";
}

/** Controller-backed parent surface injected by the composition root. */
export interface ParentManagementGateway {
  execute(input: AgentworksToolInput): Promise<ParentManagementResult>;
}
