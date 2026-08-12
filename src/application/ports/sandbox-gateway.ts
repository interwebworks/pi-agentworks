import type { SandboxEvidence } from "../../domain/execution-policy.ts";

export type SandboxNetworkPolicy = "isolated" | "host";

export interface SandboxReadOnlyMount {
  /** Existing host path exposed to the child. */
  readonly sourcePath: string;
  /** Absolute child path, normally below the assigned worktree. */
  readonly destinationPath: string;
}

export interface SandboxLaunchRequest {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly assignedWorktreePath: string;
  readonly worktreeAccess: "read-only" | "read-write";
  readonly gitMetadataPaths: readonly string[];
  readonly sessionPath: string;
  readonly runtimePath: string;
  readonly readOnlyPaths: readonly string[];
  /** Explicit source-to-destination read-only mounts within the sandbox. */
  readonly readOnlyMounts?: readonly SandboxReadOnlyMount[];
  readonly environment: Readonly<Record<string, string>>;
  readonly networkPolicy: SandboxNetworkPolicy;
}

export interface SandboxCommandPlan {
  readonly adapter: "bubblewrap";
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly hostEnvironment: Readonly<Record<string, string>>;
  readonly evidence: SandboxEvidence;
}

export interface SandboxGateway {
  plan(request: SandboxLaunchRequest): SandboxCommandPlan;
}
