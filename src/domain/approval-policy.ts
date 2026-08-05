import { getComplexityPolicy, type ComplexityMode } from "./complexity.ts";

/**
 * A decision the run can reach that may require the user's confirmation before
 * proceeding. Which of these are gated depends on the complexity mode; the TUI
 * renders the gate, but the decision of what to gate lives here so it stays
 * deterministic and testable.
 */
export const APPROVAL_CHECKPOINTS = [
  "domain",
  "team",
  "architecture",
  "technology",
  "stories",
  "acceptance-criteria",
  "branches",
  "integration-target",
  "models",
  "material-decision",
] as const;

export type ApprovalCheckpoint = (typeof APPROVAL_CHECKPOINTS)[number];

/**
 * Per-mode confirmation matrix from the product spec.
 * - LOW assumes weak reasoning: confirm essentially everything material.
 * - NORMAL assumes supervised reasoning: confirm the plan-shaping decisions.
 * - HIGH assumes strong autonomy: no routine confirmation; the user is notified
 *   of material decisions and failures instead of gating on them.
 * Model confirmation is mandatory in LOW and NORMAL.
 */
const REQUIRED: Readonly<
  Record<ComplexityMode, ReadonlySet<ApprovalCheckpoint>>
> = Object.freeze({
  LOW: new Set<ApprovalCheckpoint>([
    "domain",
    "team",
    "architecture",
    "technology",
    "stories",
    "acceptance-criteria",
    "branches",
    "models",
    "material-decision",
  ]),
  NORMAL: new Set<ApprovalCheckpoint>([
    "stories",
    "team",
    "architecture",
    "technology",
    "integration-target",
    "models",
  ]),
  HIGH: new Set<ApprovalCheckpoint>(),
});

/** True when this checkpoint must be confirmed by the user in the given mode. */
export function requiresApproval(
  mode: ComplexityMode,
  checkpoint: ApprovalCheckpoint,
): boolean {
  return REQUIRED[mode].has(checkpoint);
}

/** The checkpoints requiring confirmation in the given mode, in canonical order. */
export function requiredApprovals(
  mode: ComplexityMode,
): readonly ApprovalCheckpoint[] {
  return APPROVAL_CHECKPOINTS.filter((checkpoint) =>
    REQUIRED[mode].has(checkpoint),
  );
}

/**
 * Cross-check with the complexity policy so the mandatory-model-confirmation
 * rule can never drift between the two sources. Model confirmation is required
 * exactly when the policy says so, and that must match the checkpoint matrix.
 */
export function requiresModelConfirmation(mode: ComplexityMode): boolean {
  const fromPolicy = getComplexityPolicy(mode).requiresModelConfirmation;
  const fromMatrix = requiresApproval(mode, "models");
  if (fromPolicy !== fromMatrix) {
    throw new Error(
      `model-confirmation policy disagrees with the approval matrix for ${mode}`,
    );
  }
  return fromPolicy;
}
