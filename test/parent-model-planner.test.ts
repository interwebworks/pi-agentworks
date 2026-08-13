import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createParentModelPlanner } from "../src/extension/parent-model-planner.ts";

const submittedPlan = {
  stories: [
    {
      id: "health-sync",
      title: "Implement Apple Health synchronization",
      narrative:
        "As a user, I want Apple Health data synchronized so that health monitoring is current.",
      objective:
        "Deliver the complete Apple Health synchronization capability.",
      taskKinds: ["software-development", "integration"],
      writable: true,
      dependencies: [],
      scope: {
        included: ["health integration"],
        excluded: ["unrelated features"],
      },
      technologyChoices: ["existing repository stack"],
      constraints: [
        "preserve existing user data and authentication boundaries",
      ],
      deliverables: ["Apple Health integration"],
      acceptanceCriteria: ["authorized health data is synchronized correctly"],
      validation: [{ command: "npm test", expected: "passes" }],
      escalationConditions: ["required Apple Health access is unavailable"],
    },
  ],
};

test("uses the active parent model and requires a structured plan tool call", async () => {
  const calls: unknown[][] = [];
  const planner = createParentModelPlanner();
  const context = {
    cwd: process.cwd(),
    model: { provider: "openai", id: "gpt-5.6" },
    thinkingLevel: "high",
    signal: undefined,
    modelRegistry: {
      complete(
        _model: unknown,
        request: { tools?: readonly { name: string }[] },
      ) {
        calls.push(request.tools?.map((tool) => tool.name) ?? []);
        return Promise.resolve({
          content: [
            {
              type: "toolCall",
              id: "plan-1",
              name: "submit_agentworks_plan",
              arguments: submittedPlan,
            },
          ],
          stopReason: "stop",
        });
      },
    },
  } as unknown as ExtensionContext;

  const plan = await planner.plan({
    task: "Add health monitoring integration with Apple Health.",
    mode: "HIGH",
    context,
  });

  assert.deepEqual(
    plan.stories.map((story) => story.id),
    ["health-sync"],
  );
  assert.deepEqual(calls, [
    [
      "list_repository_files",
      "read_repository_file",
      "search_repository",
      "submit_agentworks_plan",
    ],
  ]);
});
