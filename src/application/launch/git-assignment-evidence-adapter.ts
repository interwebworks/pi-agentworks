import type { RunState, StoryState } from "../../domain/controller-state.ts";
import type { GitRepositoryInspector } from "../ports/git-repository-inspector.ts";
import type { GitWorkspaceGateway } from "../ports/git-workspace-gateway.ts";
import type { AssignmentInfrastructureEvidence } from "./assignment-resource-evidence.ts";
import { assertAssignmentInfrastructureEvidence } from "./assignment-resource-evidence.ts";

export interface ExpectedIntegrationHeadResolver {
  resolve(run: RunState, story: StoryState, expectedRevision: number): string;
}

export class GitAssignmentEvidenceAdapterError extends Error {
  constructor(message: string) {
    super(`Git assignment evidence adapter failed: ${message}`);
    this.name = "GitAssignmentEvidenceAdapterError";
  }
}

/**
 * Obtains branch/worktree evidence from the controller's Git ports.
 * Expected heads are supplied explicitly by the controller composition root so
 * this adapter never guesses from a mutable checkout.
 */
export class GitAssignmentEvidenceAdapter {
  readonly #inspector: GitRepositoryInspector;
  readonly #git: GitWorkspaceGateway;
  readonly #expectedIntegrationHead: ExpectedIntegrationHeadResolver;

  constructor(dependencies: {
    readonly inspector: GitRepositoryInspector;
    readonly git: GitWorkspaceGateway;
    readonly expectedIntegrationHead: ExpectedIntegrationHeadResolver;
  }) {
    this.#inspector = dependencies.inspector;
    this.#git = dependencies.git;
    this.#expectedIntegrationHead = dependencies.expectedIntegrationHead;
  }

  provision(
    run: RunState,
    story: StoryState,
    expectedRevision: number,
    agentId: string,
    baseEvidence: Omit<
      AssignmentInfrastructureEvidence,
      "git" | "herdr" | "session"
    > & {
      readonly herdr: AssignmentInfrastructureEvidence["herdr"];
      readonly session: AssignmentInfrastructureEvidence["session"];
    },
  ): AssignmentInfrastructureEvidence {
    const inspection = this.#inspector.inspect(run.originalCheckout);
    if (inspection.repositoryRoot !== run.repositoryRoot) {
      throw new GitAssignmentEvidenceAdapterError(
        "inspected repository root does not match the run",
      );
    }
    this.#inspector.assertBranchExists(inspection, run.integrationBranch);
    const expectedIntegrationHead = this.#expectedIntegrationHead.resolve(
      run,
      story,
      expectedRevision,
    );
    if (expectedIntegrationHead.trim().length === 0) {
      throw new GitAssignmentEvidenceAdapterError(
        "expected integration head is empty",
      );
    }
    const workspace = this.#git.createStoryWorkspace({
      runId: run.id,
      storyId: story.id,
      originalCheckout: run.originalCheckout,
      repositoryRoot: run.repositoryRoot,
      commonGitDirectory: inspection.commonGitDirectory,
      integrationBranch: run.integrationBranch,
      expectedIntegrationHead,
      storyBranch: story.branchName,
      worktreePath: story.worktreePath,
    });
    if (
      workspace.worktreePath !== story.worktreePath ||
      workspace.branch !== story.branchName
    ) {
      throw new GitAssignmentEvidenceAdapterError(
        "Git workspace result does not match the story assignment",
      );
    }
    const evidence: AssignmentInfrastructureEvidence = {
      ...baseEvidence,
      git: {
        commonGitDirectory: inspection.commonGitDirectory,
        baseBranch: run.integrationBranch,
        expectedIntegrationHead,
        integrationBranch: run.integrationBranch,
        storyBranch: story.branchName,
        expectedStoryHead: workspace.branchHead,
        worktreePath: workspace.worktreePath,
      },
    };
    assertAssignmentInfrastructureEvidence(evidence, run, story, agentId);
    return Object.freeze(evidence);
  }
}
