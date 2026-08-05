import path from "node:path";
import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

const NonEmptyString = Type.String({ minLength: 1 });
const NonEmptyStringArray = Type.Array(NonEmptyString, { minItems: 1 });

export const TaskSpecificationSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: NonEmptyString,
    storyId: NonEmptyString,
    taskId: NonEmptyString,
    title: NonEmptyString,
    userStory: NonEmptyString,
    objective: NonEmptyString,
    assignedAgentId: NonEmptyString,
    assignedRole: NonEmptyString,
    repositoryRoot: NonEmptyString,
    baseBranch: NonEmptyString,
    branchName: NonEmptyString,
    worktreePath: NonEmptyString,
    scope: Type.Object(
      {
        included: NonEmptyStringArray,
        excluded: NonEmptyStringArray,
      },
      { additionalProperties: false },
    ),
    technologyChoices: NonEmptyStringArray,
    constraints: NonEmptyStringArray,
    dependencies: Type.Array(NonEmptyString),
    deliverables: NonEmptyStringArray,
    acceptanceCriteria: NonEmptyStringArray,
    validation: Type.Array(
      Type.Object(
        {
          command: NonEmptyString,
          expected: NonEmptyString,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    escalationConditions: NonEmptyStringArray,
    allowedTools: NonEmptyStringArray,
    writePolicy: Type.Union([
      Type.Literal("read-only"),
      Type.Literal("story-writer"),
      Type.Literal("pm-integration"),
    ]),
  },
  { additionalProperties: false },
);

export type TaskSpecification = Static<typeof TaskSpecificationSchema>;

export class InvalidTaskSpecificationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Agentworks task specification:\n- ${issues.join("\n- ")}`);
    this.name = "InvalidTaskSpecificationError";
    this.issues = issues;
  }
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isPlausibleBranchName(value: string): boolean {
  return (
    value.length <= 240 &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[\s~^:?*[\\]/u.test(value)
  );
}

function collectDomainIssues(task: TaskSpecification): string[] {
  const issues: string[] = [];
  const repositoryRoot = path.resolve(task.repositoryRoot);
  const worktreePath = path.resolve(task.worktreePath);

  if (!path.isAbsolute(task.repositoryRoot)) {
    issues.push("repositoryRoot must be absolute");
  }
  if (!path.isAbsolute(task.worktreePath)) {
    issues.push("worktreePath must be absolute");
  }
  if (isPathWithin(worktreePath, repositoryRoot)) {
    issues.push(
      "worktreePath must be outside the original repository checkout",
    );
  }
  if (task.branchName === task.baseBranch) {
    issues.push("branchName must differ from baseBranch");
  }
  if (!isPlausibleBranchName(task.branchName)) {
    issues.push("branchName is not a safe Git branch name");
  }
  if (!isPlausibleBranchName(task.baseBranch)) {
    issues.push("baseBranch is not a safe Git branch name");
  }
  if (
    task.writePolicy === "read-only" &&
    task.allowedTools.some((tool) => ["write", "edit"].includes(tool))
  ) {
    issues.push("read-only assignments cannot include write or edit tools");
  }
  if (
    task.writePolicy !== "read-only" &&
    !task.allowedTools.some((tool) => ["write", "edit"].includes(tool))
  ) {
    issues.push(
      "write-capable assignments must include write or edit in allowedTools",
    );
  }

  return issues;
}

export function parseTaskSpecification(value: unknown): TaskSpecification {
  if (!Check(TaskSpecificationSchema, value)) {
    const issues = [...Errors(TaskSpecificationSchema, value)].map((issue) => {
      const location = issue.instancePath.length > 0 ? issue.instancePath : "/";
      const detail =
        issue.keyword === "additionalProperties"
          ? ` (${issue.params.additionalProperties.join(", ")})`
          : "";
      return `${location}: ${issue.message}${detail}`;
    });
    throw new InvalidTaskSpecificationError(issues);
  }

  const task = value;
  const domainIssues = collectDomainIssues(task);
  if (domainIssues.length > 0) {
    throw new InvalidTaskSpecificationError(domainIssues);
  }

  return Object.freeze(task);
}
