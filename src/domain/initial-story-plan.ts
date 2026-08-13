import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import {
  StoryPlanError,
  validateAndOrderStories,
  type UserStory,
} from "./story-planning.ts";

const NonEmptyString = Type.String({ minLength: 1, maxLength: 4096 });
const StoryId = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
});
const NonEmptyStringArray = Type.Array(NonEmptyString, {
  minItems: 1,
  maxItems: 64,
  uniqueItems: true,
});

export const InitialStorySchema = Type.Object(
  {
    id: StoryId,
    title: Type.String({ minLength: 1, maxLength: 240 }),
    narrative: NonEmptyString,
    objective: NonEmptyString,
    taskKinds: NonEmptyStringArray,
    writable: Type.Literal(true),
    dependencies: Type.Array(StoryId, { maxItems: 32, uniqueItems: true }),
    scope: Type.Object(
      {
        included: NonEmptyStringArray,
        excluded: NonEmptyStringArray,
      },
      { additionalProperties: false },
    ),
    technologyChoices: NonEmptyStringArray,
    constraints: NonEmptyStringArray,
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
      { minItems: 1, maxItems: 16 },
    ),
    escalationConditions: NonEmptyStringArray,
  },
  { additionalProperties: false },
);

export const InitialStoryPlanSchema = Type.Object(
  {
    stories: Type.Array(InitialStorySchema, { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: false },
);

export interface InitialStoryPlan {
  readonly stories: readonly UserStory[];
}

export class InvalidInitialStoryPlanError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Agentworks initial story plan is invalid:\n- ${issues.join("\n- ")}`,
    );
    this.name = "InvalidInitialStoryPlanError";
    this.issues = issues;
  }
}

/**
 * Parse the model-produced plan at the trust boundary, then apply the domain's
 * dependency and writable-delivery invariants before controller initialization.
 */
export function parseInitialStoryPlan(value: unknown): InitialStoryPlan {
  if (!Check(InitialStoryPlanSchema, value)) {
    const issues = [...Errors(InitialStoryPlanSchema, value)].map((issue) => {
      const location =
        issue.instancePath.length === 0 ? "/" : issue.instancePath;
      const detail =
        issue.keyword === "additionalProperties"
          ? ` (${issue.params.additionalProperties.join(", ")})`
          : "";
      return `${location}: ${issue.message}${detail}`;
    });
    throw new InvalidInitialStoryPlanError(issues);
  }

  try {
    const stories = validateAndOrderStories(value.stories);
    return Object.freeze({ stories: Object.freeze([...stories]) });
  } catch (error) {
    if (error instanceof StoryPlanError) {
      throw new InvalidInitialStoryPlanError(error.issues);
    }
    throw error;
  }
}
