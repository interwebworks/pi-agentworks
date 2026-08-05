export const COMPLEXITY_MODES = ["LOW", "NORMAL", "HIGH"] as const;

export type ComplexityMode = (typeof COMPLEXITY_MODES)[number];

export type ApprovalPolicy =
  | "every-material-decision"
  | "plan-and-material-deviations"
  | "autonomous-with-hard-guards";

export interface ComplexityPolicy {
  readonly mode: ComplexityMode;
  readonly maximumAgents: number;
  readonly approvalPolicy: ApprovalPolicy;
  readonly requiresModelConfirmation: boolean;
  readonly requiresPlanConfirmation: boolean;
  readonly permitsAutonomousScheduling: boolean;
}

const POLICIES: Readonly<Record<ComplexityMode, ComplexityPolicy>> =
  Object.freeze({
    LOW: Object.freeze({
      mode: "LOW",
      maximumAgents: 4,
      approvalPolicy: "every-material-decision",
      requiresModelConfirmation: true,
      requiresPlanConfirmation: true,
      permitsAutonomousScheduling: false,
    }),
    NORMAL: Object.freeze({
      mode: "NORMAL",
      maximumAgents: 8,
      approvalPolicy: "plan-and-material-deviations",
      requiresModelConfirmation: true,
      requiresPlanConfirmation: true,
      permitsAutonomousScheduling: false,
    }),
    HIGH: Object.freeze({
      mode: "HIGH",
      maximumAgents: 16,
      approvalPolicy: "autonomous-with-hard-guards",
      requiresModelConfirmation: false,
      requiresPlanConfirmation: false,
      permitsAutonomousScheduling: true,
    }),
  });

export function parseComplexityMode(value: string): ComplexityMode {
  const normalized = value.trim().toUpperCase();
  if (COMPLEXITY_MODES.includes(normalized as ComplexityMode)) {
    return normalized as ComplexityMode;
  }

  throw new Error(`Unknown Agentworks complexity mode: ${value}`);
}

export function getComplexityPolicy(mode: ComplexityMode): ComplexityPolicy {
  return POLICIES[mode];
}
