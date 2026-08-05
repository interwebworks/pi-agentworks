const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export class InvalidWorkspaceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkspaceIdentityError";
  }
}

export function integrationBranchForRun(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new InvalidWorkspaceIdentityError(
      "Run id is unsafe for Git workspace naming",
    );
  }
  return `agentworks/${runId}/integration`;
}

export function storyBranchForRun(runId: string, storyId: string): string {
  if (!RUN_ID_PATTERN.test(runId) || !RUN_ID_PATTERN.test(storyId)) {
    throw new InvalidWorkspaceIdentityError(
      "Run and story ids are unsafe for Git workspace naming",
    );
  }
  return `agentworks/${runId}/stories/${storyId}`;
}
