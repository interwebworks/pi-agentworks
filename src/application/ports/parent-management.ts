export type ParentManagementAction =
  | "launch"
  | "status"
  | "approve"
  | "reject"
  | "steer"
  | "pause"
  | "resume"
  | "focus"
  | "close";

export interface ParentLaunchRuntime {
  readonly workspaceId: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ParentManagementRequest {
  readonly action: ParentManagementAction;
  readonly mode?: "LOW" | "NORMAL" | "HIGH";
  readonly task?: string;
  readonly runId?: string;
  readonly message?: string;
  readonly runtime?: ParentLaunchRuntime;
}

export interface ParentManagementResult {
  readonly text: string;
  readonly notificationType?: "info" | "warning" | "error";
}

export interface ParentManagementGateway {
  execute(input: ParentManagementRequest): Promise<ParentManagementResult>;
}
