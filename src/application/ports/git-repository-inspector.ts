export interface GitRemote {
  readonly name: string;
  readonly fetchUrl: string | null;
  readonly pushUrl: string | null;
}

export interface GitRepositoryInspection {
  readonly requestedPath: string;
  readonly repositoryRoot: string | null;
  readonly gitDirectory: string;
  readonly commonGitDirectory: string;
  readonly bare: boolean;
  readonly currentBranch: string | null;
  readonly headCommit: string | null;
  readonly localBranches: readonly string[];
  readonly defaultBranch: string | null;
  readonly defaultBranchSource:
    "remote-head" | "single-local-branch" | "conventional-local-branch" | null;
  readonly remotes: readonly GitRemote[];
  readonly repositoryProtectedPatterns: readonly string[];
  readonly objectFormat: "sha1" | "sha256";
}

export interface GitRepositoryInspector {
  inspect(path: string): GitRepositoryInspection;
  assertBranchExists(inspection: GitRepositoryInspection, branch: string): void;
}
