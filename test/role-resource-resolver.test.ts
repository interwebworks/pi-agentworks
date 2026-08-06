import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import type { ControllerSnapshot } from "../src/application/ports/controller-repository.ts";
import {
  ExplicitRoleResourceResolver,
  RoleResourceResolverError,
  type AssignmentResourceProvider,
  type RoleCatalog,
  type RoleCatalogEntry,
} from "../src/application/launch/role-resource-resolver.ts";
import type { AssignmentLaunchResources } from "../src/application/launch/assignment-preparation.ts";

const role: RoleCatalogEntry = {
  id: "backend-developer",
  runtimeId: "software-development/backend-developer",
  label: "Backend Developer",
  description: "Builds backend changes.",
  authority: "worker",
  required: false,
  taskKinds: ["software-development"],
  responsibilities: ["implement changes"],
  promptFile: "backend.md",
  tools: ["read", "write"],
  controllerActions: ["report-status"],
  writePolicy: "story-writer",
  networkAccess: "disabled",
  systemPrompt: "Build carefully.",
};

function fixture(): {
  readonly snapshot: ControllerSnapshot;
  readonly story: ControllerSnapshot["stories"][number];
  readonly run: ControllerSnapshot["run"];
} {
  const run = createRunState({
    id: "run-1",
    title: "Ship",
    complexity: "HIGH",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktree/integration",
    createdAt: 1,
  });
  const story = createStoryState({
    id: "story-1",
    runId: run.id,
    title: "Story",
    branchName: "agentworks/run-1/story-1",
    worktreePath: "/worktree/story-1",
    createdAt: 1,
  });
  return {
    snapshot: { revision: 1, run, stories: [story], agents: [] },
    story,
    run,
  };
}

test("role/resource resolver preserves runtime role identity and delegates complete resources", async () => {
  const { snapshot, story, run } = fixture();
  let resolvedRole: string | null = null;
  let delegatedRole: string | null = null;
  const catalog: RoleCatalog = {
    find: (runtimeId) => {
      resolvedRole = runtimeId;
      return Promise.resolve(runtimeId === role.runtimeId ? role : null);
    },
  };
  const resources = {} as unknown as AssignmentLaunchResources;
  const provider: AssignmentResourceProvider = {
    resolve: (_kind, selected) => {
      delegatedRole = selected.runtimeId;
      return Promise.resolve(resources);
    },
  };
  const resolver = new ExplicitRoleResourceResolver({
    catalog,
    selector: { select: () => Promise.resolve(role.runtimeId) },
    resources: provider,
  });

  const resolved = await resolver.resolveRole("writer", story, run, snapshot);
  const delegated = await resolver.resolveResources(
    "writer",
    story,
    run,
    snapshot,
  );

  assert.equal(resolved.runtimeId, role.runtimeId);
  assert.equal(resolved.rolePrompt, role.systemPrompt);
  assert.equal(resolvedRole, role.runtimeId);
  assert.equal(delegatedRole, role.runtimeId);
  assert.equal(delegated, resources);
});

test("role/resource resolver fails closed on unavailable roles", async () => {
  const { snapshot, story, run } = fixture();
  const resolver = new ExplicitRoleResourceResolver({
    catalog: { find: () => Promise.resolve(null) },
    selector: { select: () => Promise.resolve("missing/role") },
    resources: {} as AssignmentResourceProvider,
  });

  await assert.rejects(
    resolver.resolveRole("writer", story, run, snapshot),
    (error: unknown) =>
      error instanceof RoleResourceResolverError &&
      error.message.includes("missing/role is unavailable"),
  );
});
