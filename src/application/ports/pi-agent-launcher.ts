import type { ComplexityMode } from "../../domain/complexity.ts";
import type { SandboxEvidence } from "../../domain/execution-policy.ts";
import type { RoleDefinition } from "../../domain/role-pack.ts";
import type { TaskSpecification } from "../../domain/task-specification.ts";

export interface PiAgentLaunchRequest {
  readonly complexity: ComplexityMode;
  readonly paneId: string;
  readonly task: TaskSpecification;
  readonly role: RoleDefinition;
  readonly rolePrompt: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly configPath: string;
  readonly runtimePath: string;
  readonly controllerSocketPath: string;
  readonly controllerChildAuthToken: string;
  readonly piCliPath: string;
  readonly piPackagePath: string;
  readonly agentworksPackagePath: string;
  readonly childBridgePath: string;
  readonly nodePath: string;
  readonly gitMetadataPaths: readonly string[];
  readonly additionalReadOnlyPaths: readonly string[];
  readonly writerLeaseActive: boolean;
  readonly controllerFenceCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
}

export interface PiAgentLaunchEvidence {
  readonly paneId: string;
  readonly sessionId: string;
  readonly processIds: readonly number[];
  readonly sandbox: SandboxEvidence;
  readonly rolePromptPath: string;
  readonly taskPromptPath: string;
  readonly controllerCapabilityPath: string;
  readonly rolePromptSha256: string;
  readonly taskPromptSha256: string;
  readonly commandSha256: string;
}

export interface PiAgentLauncher {
  launch(request: PiAgentLaunchRequest): Promise<PiAgentLaunchEvidence>;
}
