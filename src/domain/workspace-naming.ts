const WORKSPACE_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;

function isSafeWorkspaceId(value: string): boolean {
  return (
    WORKSPACE_ID_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.toLowerCase().endsWith(".lock")
  );
}

export class InvalidWorkspaceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkspaceIdentityError";
  }
}

export function integrationBranchForRun(runId: string): string {
  if (!isSafeWorkspaceId(runId)) {
    throw new InvalidWorkspaceIdentityError(
      "Run id is unsafe for Git workspace naming",
    );
  }
  return `agentworks/${runId}/integration`;
}

export function storyBranchForRun(runId: string, storyId: string): string {
  if (!isSafeWorkspaceId(runId) || !isSafeWorkspaceId(storyId)) {
    throw new InvalidWorkspaceIdentityError(
      "Run and story ids are unsafe for Git workspace naming",
    );
  }
  return `agentworks/${runId}/stories/${storyId}`;
}
