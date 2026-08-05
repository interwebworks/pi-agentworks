const WORKSPACE_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;

function isSafeWorkspaceId(value: string): boolean {
  return (
    WORKSPACE_ID_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.toLowerCase().endsWith(".lock")
  );
}

export function assertSafeWorkspaceId(value: string, label: string): string {
  if (!isSafeWorkspaceId(value)) {
    throw new InvalidWorkspaceIdentityError(`${label} is unsafe`);
  }
  return value;
}

export class InvalidWorkspaceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkspaceIdentityError";
  }
}

export function integrationBranchForRun(runId: string): string {
  assertSafeWorkspaceId(runId, "Run id");
  return `agentworks/${runId}/integration`;
}

export function storyBranchForRun(runId: string, storyId: string): string {
  assertSafeWorkspaceId(runId, "Run id");
  assertSafeWorkspaceId(storyId, "Story id");
  return `agentworks/${runId}/stories/${storyId}`;
}
