import type { RunState, StoryState } from "../../domain/controller-state.ts";

export interface GitAssignmentEvidence {
  readonly commonGitDirectory: string;
  readonly baseBranch: string;
  readonly expectedIntegrationHead: string;
  readonly integrationBranch: string;
  readonly storyBranch: string;
  readonly expectedStoryHead: string;
  readonly worktreePath: string;
}

export interface HerdrAssignmentEvidence {
  readonly paneId: string;
  readonly cwd: string;
  readonly tokens: Readonly<Record<string, string>>;
}

export interface PrivateSessionEvidence {
  readonly sessionPath: string;
  readonly configPath: string;
  readonly controllerChildAuthToken: string;
}

export interface AssignmentInfrastructureEvidence {
  readonly git: GitAssignmentEvidence;
  readonly herdr: HerdrAssignmentEvidence;
  readonly session: PrivateSessionEvidence;
  readonly controllerSocketPath: string;
  readonly runtimePath: string;
  readonly controllerFenceCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
}

export class AssignmentInfrastructureEvidenceError extends Error {
  constructor(message: string) {
    super(`Assignment infrastructure evidence is invalid: ${message}`);
    this.name = "AssignmentInfrastructureEvidenceError";
  }
}

function required(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new AssignmentInfrastructureEvidenceError(`${label} is empty`);
  }
}

/** Validate cross-system identity before evidence becomes launch input. */
export function assertAssignmentInfrastructureEvidence(
  evidence: AssignmentInfrastructureEvidence,
  run: RunState,
  story: StoryState,
  agentId: string,
): void {
  required(agentId, "agent id");
  required(evidence.git.commonGitDirectory, "common Git directory");
  required(evidence.git.expectedIntegrationHead, "integration head");
  required(evidence.git.expectedStoryHead, "story head");
  required(evidence.git.worktreePath, "Git worktree path");
  required(evidence.herdr.paneId, "Herdr pane id");
  required(evidence.herdr.cwd, "Herdr cwd");
  required(evidence.session.sessionPath, "session path");
  required(evidence.session.configPath, "config path");
  required(evidence.session.controllerChildAuthToken, "child capability");
  required(evidence.controllerSocketPath, "controller socket path");
  required(evidence.runtimePath, "runtime path");
  if (evidence.git.baseBranch !== run.integrationBranch) {
    throw new AssignmentInfrastructureEvidenceError(
      "Git base branch does not match the run integration branch",
    );
  }
  if (evidence.git.integrationBranch !== run.integrationBranch) {
    throw new AssignmentInfrastructureEvidenceError(
      "Git integration branch does not match the run",
    );
  }
  if (evidence.git.storyBranch !== story.branchName) {
    throw new AssignmentInfrastructureEvidenceError(
      "Git story branch does not match the story",
    );
  }
  if (evidence.git.worktreePath !== story.worktreePath) {
    throw new AssignmentInfrastructureEvidenceError(
      "Git worktree does not match the story",
    );
  }
  if (evidence.herdr.cwd !== story.worktreePath) {
    throw new AssignmentInfrastructureEvidenceError(
      "Herdr cwd does not match the story worktree",
    );
  }
  const expectedTokens = {
    aw_kind: "agent",
    aw_run: run.id,
    aw_agent: agentId,
  } as const;
  for (const [key, expected] of Object.entries(expectedTokens)) {
    if (evidence.herdr.tokens[key] !== expected) {
      throw new AssignmentInfrastructureEvidenceError(
        `Herdr ownership token ${key} does not match`,
      );
    }
  }
  if (!evidence.controllerFenceCurrent || !evidence.expectedRevisionMatches) {
    throw new AssignmentInfrastructureEvidenceError(
      "controller fence or revision evidence is stale",
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(evidence.session.controllerChildAuthToken)) {
    throw new AssignmentInfrastructureEvidenceError(
      "controller child capability has invalid format",
    );
  }
}
