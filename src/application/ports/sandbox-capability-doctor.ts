import type { SandboxEvidence } from "../../domain/execution-policy.ts";

export type SandboxProbeName =
  | "platform"
  | "executable"
  | "version"
  | "user-namespace"
  | "nested-user-namespace-disabled"
  | "mount-namespace"
  | "pid-namespace"
  | "network-namespace"
  | "root-read-only"
  | "assigned-worktree-writable"
  | "git-metadata-read-only"
  | "environment-sanitized";

export interface SandboxCapabilityProbe {
  readonly name: SandboxProbeName;
  readonly passed: boolean;
  readonly detail: string;
}

export interface SandboxCapabilityReport {
  readonly adapter: "bubblewrap";
  readonly supported: boolean;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly checkedAt: number;
  readonly evidence: SandboxEvidence | null;
  readonly probes: readonly SandboxCapabilityProbe[];
  readonly reasons: readonly string[];
}

export interface SandboxCapabilityDoctor {
  inspect(): SandboxCapabilityReport;
}
