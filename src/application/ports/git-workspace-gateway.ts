export interface GitWorktreeRecord {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly prunable: boolean;
  readonly locked: boolean;
}

export interface CreateIntegrationWorkspaceRequest {
  readonly runId: string;
  readonly originalCheckout: string;
  readonly repositoryRoot: string;
  readonly commonGitDirectory: string;
  readonly baseBranch: string;
  readonly expectedBaseHead: string;
  readonly integrationBranch: string;
  readonly worktreePath: string;
}

export interface CreateStoryWorkspaceRequest {
  readonly runId: string;
  readonly storyId: string;
  readonly originalCheckout: string;
  readonly repositoryRoot: string;
  readonly commonGitDirectory: string;
  readonly integrationBranch: string;
  readonly expectedIntegrationHead: string;
  readonly storyBranch: string;
  readonly worktreePath: string;
}

export interface GitWorkspaceResult {
  readonly status: "created" | "recovered" | "existing";
  readonly branch: string;
  readonly branchHead: string;
  readonly worktreePath: string;
}

export interface GitWorkspaceGateway {
  listWorktrees(originalCheckout: string): readonly GitWorktreeRecord[];
  createIntegrationWorkspace(
    request: CreateIntegrationWorkspaceRequest,
  ): GitWorkspaceResult;
  createStoryWorkspace(
    request: CreateStoryWorkspaceRequest,
  ): GitWorkspaceResult;
}
