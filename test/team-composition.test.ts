import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  composeTeam,
  selectStoryReviewer,
  selectStoryWorker,
  TeamCompositionError,
  type ComposableRole,
} from "../src/domain/team-composition.ts";
import { discoverRolePacks } from "../src/infrastructure/role-packs/file-role-pack-repository.ts";

const packRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../role-packs",
);

async function builtinRoles(): Promise<ComposableRole[]> {
  const result = await discoverRolePacks({
    roots: [{ scope: "builtin", path: packRoot }],
    projectTrusted: false,
  });
  assert.equal(result.diagnostics.length, 0, "builtin packs must load cleanly");
  return result.packs.flatMap((pack) => pack.roles);
}

function role(overrides: Partial<ComposableRole>): ComposableRole {
  return {
    runtimeId: "pack/role",
    authority: "worker",
    writePolicy: "story-writer",
    required: false,
    taskKinds: [],
    ...overrides,
  };
}

function ids(team: { members: readonly { runtimeId: string }[] }): string[] {
  return team.members.map((member) => member.runtimeId);
}

test("composes a software team that fits the LOW agent limit", async () => {
  const team = composeTeam({
    taskText: "Build a backend API and a frontend dashboard",
    mode: "LOW",
    roles: await builtinRoles(),
  });

  assert.equal(team.maximumAgents, 4);
  assert.ok(team.members.length <= 4);
  assert.equal(
    team.members.filter((m) => m.authority === "project-manager").length,
    1,
  );
  assert.ok(team.members.some((m) => m.authority === "reviewer"));
  // The API + dashboard task must pull in the matching software workers.
  assert.ok(ids(team).includes("software-development/backend-developer"));
  assert.ok(ids(team).includes("software-development/frontend-developer"));
});

test("HIGH admits a broad software team up to the higher limit", async () => {
  const team = composeTeam({
    taskText:
      "Design architecture, build backend api, build frontend ui, add testing",
    mode: "HIGH",
    roles: await builtinRoles(),
  });

  assert.equal(team.maximumAgents, 16);
  assert.ok(ids(team).includes("software-development/software-architect"));
  assert.ok(ids(team).includes("software-development/test-engineer"));
  // A team is always led by exactly one Project Manager.
  assert.equal(
    team.members.filter((m) => m.authority === "project-manager").length,
    1,
  );
});

test("always includes a story writer even when nothing matches the task", () => {
  const team = composeTeam({
    taskText: "something entirely unrelated to any declared task kind",
    mode: "NORMAL",
    roles: [
      role({
        runtimeId: "p/pm",
        authority: "project-manager",
        writePolicy: "read-only",
        required: true,
      }),
      role({
        runtimeId: "p/rev",
        authority: "reviewer",
        writePolicy: "read-only",
        required: true,
      }),
      role({
        runtimeId: "p/writer",
        authority: "worker",
        writePolicy: "story-writer",
      }),
    ],
  });

  const writer = team.members.find((m) => m.runtimeId === "p/writer");
  assert.ok(writer, "a story writer must be present");
  assert.equal(writer.reason, "writer-fallback");
});

test("never exceeds the mode agent limit", () => {
  const many: ComposableRole[] = [
    role({
      runtimeId: "p/pm",
      authority: "project-manager",
      writePolicy: "read-only",
      required: true,
    }),
    role({
      runtimeId: "p/rev",
      authority: "reviewer",
      writePolicy: "read-only",
      required: true,
    }),
    ...Array.from({ length: 12 }, (_unused, index) =>
      role({ runtimeId: `p/w${String(index)}`, taskKinds: ["build"] }),
    ),
  ];

  const team = composeTeam({
    taskText: "build build build",
    mode: "LOW",
    roles: many,
  });
  assert.ok(team.members.length <= 4);
});

test("rejects a role set without a Project Manager", () => {
  assert.throws(
    () =>
      composeTeam({
        taskText: "build it",
        mode: "NORMAL",
        roles: [
          role({
            runtimeId: "p/rev",
            authority: "reviewer",
            writePolicy: "read-only",
          }),
          role({ runtimeId: "p/w", authority: "worker" }),
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof TeamCompositionError);
      assert.match(error.message, /Project Manager/u);
      return true;
    },
  );
});

test("rejects a role set with no story writer", () => {
  assert.throws(
    () =>
      composeTeam({
        taskText: "review only",
        mode: "NORMAL",
        roles: [
          role({
            runtimeId: "p/pm",
            authority: "project-manager",
            writePolicy: "read-only",
          }),
          role({
            runtimeId: "p/rev",
            authority: "reviewer",
            writePolicy: "read-only",
          }),
          role({
            runtimeId: "p/adv",
            authority: "advisor",
            writePolicy: "read-only",
          }),
        ],
      }),
    /no agent could perform the work/u,
  );
});

test("is deterministic across repeated composition", async () => {
  const roles = await builtinRoles();
  const first = composeTeam({
    taskText: "build backend api testing",
    mode: "NORMAL",
    roles,
  });
  const second = composeTeam({
    taskText: "build backend api testing",
    mode: "NORMAL",
    roles,
  });
  assert.deepEqual(ids(first), ids(second));
});

test("selectStoryWorker picks the worker whose role best matches the story", async () => {
  const roles = await builtinRoles();
  const team = composeTeam({
    taskText: "build backend api and frontend ui",
    mode: "HIGH",
    roles,
  });
  const backendStory = { taskKinds: ["backend", "api"] };
  const worker = selectStoryWorker(backendStory, team, roles);
  assert.equal(worker?.runtimeId, "software-development/backend-developer");

  const frontendStory = { taskKinds: ["frontend", "ui"] };
  const frontendWorker = selectStoryWorker(frontendStory, team, roles);
  assert.equal(
    frontendWorker?.runtimeId,
    "software-development/frontend-developer",
  );
});

test("selectStoryWorker falls back deterministically when nothing matches", () => {
  const team = {
    mode: "NORMAL" as const,
    maximumAgents: 8,
    members: [
      {
        runtimeId: "p/pm",
        authority: "project-manager" as const,
        reason: "required" as const,
        matchedKinds: [],
      },
      {
        runtimeId: "p/rev",
        authority: "reviewer" as const,
        reason: "required" as const,
        matchedKinds: [],
      },
      {
        runtimeId: "p/w2",
        authority: "worker" as const,
        reason: "task-match" as const,
        matchedKinds: [],
      },
      {
        runtimeId: "p/w1",
        authority: "worker" as const,
        reason: "task-match" as const,
        matchedKinds: [],
      },
    ],
  };
  const roles: ComposableRole[] = [
    {
      runtimeId: "p/w1",
      authority: "worker",
      writePolicy: "story-writer",
      required: false,
      taskKinds: ["x"],
    },
    {
      runtimeId: "p/w2",
      authority: "worker",
      writePolicy: "story-writer",
      required: false,
      taskKinds: ["y"],
    },
  ];
  const unrelatedStory = { taskKinds: ["nothing-declared-anywhere"] };
  const worker = selectStoryWorker(unrelatedStory, team, roles);
  // Both workers score zero; the tie breaks alphabetically on runtimeId.
  assert.equal(worker?.runtimeId, "p/w1");
});

test("selectStoryWorker returns null when the team has no worker", () => {
  const team = {
    mode: "LOW" as const,
    maximumAgents: 4,
    members: [
      {
        runtimeId: "p/pm",
        authority: "project-manager" as const,
        reason: "required" as const,
        matchedKinds: [],
      },
      {
        runtimeId: "p/rev",
        authority: "reviewer" as const,
        reason: "required" as const,
        matchedKinds: [],
      },
    ],
  };
  assert.equal(selectStoryWorker({ taskKinds: ["x"] }, team, []), null);
});

test("selectStoryReviewer prefers the domain-specific reviewer over the generic one", async () => {
  const roles = await builtinRoles();
  // Include "software" and "review" in the task text so the domain-specific
  // code-reviewer role is actually pulled into the composed team pool.
  const team = composeTeam({
    taskText: "build backend api, software review, and testing",
    mode: "HIGH",
    roles,
  });
  assert.ok(
    team.members.some(
      (m) => m.runtimeId === "software-development/code-reviewer",
    ),
    "the domain reviewer must be present in the team pool for this test to be meaningful",
  );
  const softwareStory = { taskKinds: ["review", "software"] };
  const reviewer = selectStoryReviewer(softwareStory, team, roles);
  assert.equal(reviewer?.runtimeId, "software-development/code-reviewer");
});
