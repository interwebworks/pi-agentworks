import type { RoleWritePolicy } from "./role-pack.ts";
import {
  parseTaskSpecification,
  type TaskSpecification,
} from "./task-specification.ts";

/**
 * A single unit of deliverable work. The Project Manager produces stories from
 * the request; this is the deterministic contract every story must satisfy
 * before it can become an assignment. A `writable` story earns its own branch
 * and worktree; a read-only story (analysis, review) does not write.
 */
export interface UserStory {
  readonly id: string;
  readonly title: string;
  readonly narrative: string;
  readonly objective: string;
  readonly taskKinds: readonly string[];
  readonly writable: boolean;
  readonly dependencies: readonly string[];
  readonly scope: {
    readonly included: readonly string[];
    readonly excluded: readonly string[];
  };
  readonly technologyChoices: readonly string[];
  readonly constraints: readonly string[];
  readonly deliverables: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly validation: readonly {
    readonly command: string;
    readonly expected: string;
  }[];
  readonly escalationConditions: readonly string[];
}

/** The role-side inputs an assignment needs; a `LoadedRole` satisfies it. */
export interface AssignableRole {
  readonly runtimeId: string;
  readonly writePolicy: RoleWritePolicy;
  readonly tools: readonly string[];
}

export interface AssignmentInputs {
  readonly runId: string;
  readonly story: UserStory;
  readonly role: AssignableRole;
  readonly agentId: string;
  /** Absolute path to the original repository checkout. */
  readonly repositoryRoot: string;
  /**
   * The branch and worktree the controller already created for this story
   * (via `GitWorkspaceGateway.createStoryWorkspace`, named per
   * `workspace-naming.ts`). An assignment describes work inside an existing
   * worktree; it never invents its own branch or path naming scheme.
   */
  readonly branchName: string;
  readonly worktreePath: string;
  /** The branch this story's branch was forked from — the run's integration branch. */
  readonly baseBranch: string;
}

export class StoryPlanError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Agentworks story plan is invalid:\n- ${issues.join("\n- ")}`);
    this.name = "StoryPlanError";
    this.issues = issues;
  }
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Validate a story set and return it in dependency order. Rejects duplicate
 * ids, references to unknown stories, dependency cycles, and plans with no
 * writable story (nothing to deliver). The returned order is a stable
 * topological sort suitable for dependency-aware scheduling.
 */
export function validateAndOrderStories(
  stories: readonly UserStory[],
): readonly UserStory[] {
  const issues: string[] = [];

  if (stories.length === 0) {
    throw new StoryPlanError(["a plan must contain at least one story"]);
  }

  const byId = new Map<string, UserStory>();
  for (const story of stories) {
    if (!SLUG_PATTERN.test(story.id)) {
      issues.push(`story id is not a slug: ${story.id}`);
    }
    if (byId.has(story.id)) {
      issues.push(`duplicate story id: ${story.id}`);
    }
    byId.set(story.id, story);
  }

  for (const story of stories) {
    for (const dependency of story.dependencies) {
      if (dependency === story.id) {
        issues.push(`story ${story.id} depends on itself`);
      } else if (!byId.has(dependency)) {
        issues.push(`story ${story.id} depends on unknown story ${dependency}`);
      }
    }
  }

  if (!stories.some((story) => story.writable)) {
    issues.push("a plan must contain at least one writable story");
  }

  if (issues.length > 0) {
    throw new StoryPlanError(issues);
  }

  const ordered = topologicalOrder(stories, byId);
  if (!ordered) {
    throw new StoryPlanError(["story dependencies contain a cycle"]);
  }
  return ordered;
}

/**
 * Kahn's algorithm over the dependency DAG. Ties break on input order so the
 * result is deterministic. Returns undefined when a cycle prevents ordering.
 */
function topologicalOrder(
  stories: readonly UserStory[],
  byId: ReadonlyMap<string, UserStory>,
): readonly UserStory[] | undefined {
  const remaining = new Map<string, number>();
  for (const story of stories) {
    remaining.set(story.id, story.dependencies.length);
  }

  const ordered: UserStory[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const story of stories) {
      if (remaining.get(story.id) === 0) {
        remaining.set(story.id, -1);
        ordered.push(story);
        progressed = true;
        for (const other of stories) {
          if (other.dependencies.includes(story.id)) {
            remaining.set(other.id, (remaining.get(other.id) ?? 0) - 1);
          }
        }
      }
    }
  }

  return ordered.length === byId.size ? ordered : undefined;
}

/**
 * Build a fully prepared, validated task specification (assignment) from a
 * story, its assigned role, and the story's already-created Git worktree. The
 * result is checked against the task-spec contract, so an incomplete
 * assignment throws rather than reaching an agent.
 */
export function buildAssignment(inputs: AssignmentInputs): TaskSpecification {
  const { runId, story, role, agentId, repositoryRoot } = inputs;

  const candidate = {
    schemaVersion: 1 as const,
    runId,
    storyId: story.id,
    taskId: `${runId}:${story.id}:${role.runtimeId}`,
    title: story.title,
    userStory: story.narrative,
    objective: story.objective,
    assignedAgentId: agentId,
    assignedRole: role.runtimeId,
    repositoryRoot,
    baseBranch: inputs.baseBranch,
    branchName: inputs.branchName,
    worktreePath: inputs.worktreePath,
    scope: {
      included: story.scope.included,
      excluded: story.scope.excluded,
    },
    technologyChoices: story.technologyChoices,
    constraints: story.constraints,
    dependencies: story.dependencies,
    deliverables: story.deliverables,
    acceptanceCriteria: story.acceptanceCriteria,
    validation: story.validation,
    escalationConditions: story.escalationConditions,
    allowedTools: role.tools,
    writePolicy: role.writePolicy,
  };

  return parseTaskSpecification(candidate);
}
