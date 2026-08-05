export interface PaneShellEnvironmentEvidence {
  readonly paneId: string;
  readonly shellPid: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface PaneProcessEvidenceGateway {
  readShellEnvironment(
    paneId: string,
  ): Promise<PaneShellEnvironmentEvidence | null>;
}
