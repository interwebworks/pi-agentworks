import type { InitialStoryPlan } from "../../domain/initial-story-plan.ts";

export type ParentManagementAction =
  | "launch"
  | "status"
  | "approve"
  | "reject"
  | "steer"
  | "pause"
  | "resume"
  | "focus"
  | "close"
  | "restart";

export interface ParentLaunchRuntime {
  readonly workspaceId: string;
  readonly origin?: {
    readonly tabId: string;
    readonly paneId: string;
  };
  readonly provider: string;
  readonly model: string;
  readonly thinking:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly allowHostNetwork: boolean;
}

export interface ParentManagementRequest {
  readonly action: ParentManagementAction;
  readonly mode?: "LOW" | "NORMAL" | "HIGH";
  readonly task?: string;
  /** Validated by the parent model before controller initialization. */
  readonly plan?: InitialStoryPlan;
  readonly runId?: string;
  readonly agentId?: string;
  readonly message?: string;
  readonly runtime?: ParentLaunchRuntime;
}

export interface ParentManagementResult {
  readonly text: string;
  readonly notificationType?: "info" | "warning" | "error";
  /** A newly initialized run that belongs to the calling parent Pi session. */
  readonly launchedRunId?: string;
}

export interface ParentManagementGateway {
  execute(input: ParentManagementRequest): Promise<ParentManagementResult>;
}
