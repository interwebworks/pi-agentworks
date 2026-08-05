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

export interface CreateCandidateCommitRequest {
  readonly runId: string;
  readonly storyId: string;
  readonly operationId: string;
  readonly originalCheckout: string;
  readonly integrationBranch: string;
  readonly expectedIntegrationHead: string;
  readonly storyBranch: string;
  readonly expectedStoryHead: string;
  readonly worktreePath: string;
  readonly subject: string;
  readonly writerLeaseReleased: boolean;
}

export interface CandidateCommitResult {
  readonly status: "created" | "existing";
  readonly commit: string;
  readonly parent: string;
  readonly integrationHead: string;
  readonly changedPaths: readonly string[];
}

export interface MergeCandidateRequest {
  readonly runId: string;
  readonly storyId: string;
  readonly operationId: string;
  readonly originalCheckout: string;
  readonly integrationBranch: string;
  readonly integrationWorktreePath: string;
  readonly reviewedIntegrationHead: string;
  readonly storyBranch: string;
  readonly storyWorktreePath: string;
  readonly candidateCommit: string;
  readonly writerAgentId: string;
  readonly reviewerAgentId: string;
  readonly requesterRole: string;
  readonly requiredChecksPassed: boolean;
  readonly writerLeaseReleased: boolean;
  readonly controllerLeaseCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
  readonly targetIsDefaultOrProtected: boolean;
  readonly protectedTargetUserApproval: boolean;
  readonly subject: string;
}

export interface MergeCandidateResult {
  readonly status: "created" | "existing";
  readonly mergeCommit: string;
  readonly integrationParent: string;
  readonly candidateParent: string;
  readonly tree: string;
}

export interface GitWorkspaceGateway {
  listWorktrees(originalCheckout: string): readonly GitWorktreeRecord[];
  createIntegrationWorkspace(
    request: CreateIntegrationWorkspaceRequest,
  ): GitWorkspaceResult;
  createStoryWorkspace(
    request: CreateStoryWorkspaceRequest,
  ): GitWorkspaceResult;
  createCandidateCommit(
    request: CreateCandidateCommitRequest,
  ): CandidateCommitResult;
  mergeCandidate(request: MergeCandidateRequest): MergeCandidateResult;
}
