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

export interface ParentManagementRequest {
  readonly action: ParentManagementAction;
  readonly mode?: "LOW" | "NORMAL" | "HIGH";
  readonly task?: string;
  readonly runId?: string;
  readonly message?: string;
}

export interface ParentManagementResult {
  readonly text: string;
  readonly notificationType?: "info" | "warning" | "error";
}

export interface ParentManagementGateway {
  execute(input: ParentManagementRequest): Promise<ParentManagementResult>;
}
