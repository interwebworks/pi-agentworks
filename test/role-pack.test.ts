import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InvalidRolePackError,
  parseRolePackManifest,
  type RolePackManifest,
} from "../src/domain/role-pack.ts";
import {
  discoverRolePacks,
  type RolePackRoot,
} from "../src/infrastructure/role-packs/file-role-pack-repository.ts";

function manifest(id: string, name = id): RolePackManifest {
  return {
    schemaVersion: 1,
    id,
    name,
    description: `${name} role pack`,
    domains: [name],
    requiresPacks: [],
    roles: [
      {
        id: "analyst",
        label: "Analyst",
        description:
          "Analyzes an assigned task without modifying project files.",
        authority: "advisor",
        required: true,
        taskKinds: ["analysis"],
        responsibilities: ["Produce evidence-backed analysis"],
        promptFile: "prompts/analyst.md",
        tools: ["read", "grep", "find", "ls"],
        controllerActions: ["report-status", "contact-manager"],
        writePolicy: "read-only",
        networkAccess: "disabled",
      },
    ],
  };
}

async function createPack(
  root: string,
  directoryName: string,
  value: RolePackManifest,
): Promise<string> {
  const directory = path.join(root, directoryName);
  await mkdir(path.join(directory, "prompts"), { recursive: true });
  await writeFile(
    path.join(directory, "pack.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(directory, "prompts/analyst.md"),
    "You are a careful analyst.\n",
    "utf8",
  );
  return directory;
}

async function withTemporaryRoots(
  run: (roots: {
    builtin: string;
    user: string;
    project: string;
    base: string;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), "agentworks-role-packs-"));
  const roots = {
    base,
    builtin: path.join(base, "builtin"),
    user: path.join(base, "user"),
    project: path.join(base, "project"),
  };
  await Promise.all([
    mkdir(roots.builtin),
    mkdir(roots.user),
    mkdir(roots.project),
  ]);
  try {
    await run(roots);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function discoveryRoots(roots: {
  builtin: string;
  user: string;
  project: string;
}): RolePackRoot[] {
  return [
    { scope: "builtin", path: roots.builtin },
    { scope: "user", path: roots.user },
    { scope: "project", path: roots.project },
  ];
}

function onlyItem<T>(items: readonly T[]): T {
  assert.equal(items.length, 1);
  const item = items[0];
  assert.ok(item);
  return item;
}

test("validates a strict data-only role pack manifest", () => {
  const parsed = parseRolePackManifest(manifest("software-development"));
  assert.equal(parsed.id, "software-development");
  assert.equal(onlyItem(parsed.roles).writePolicy, "read-only");
});

test("rejects write tools on read-only roles", () => {
  const value = manifest("unsafe-pack");
  value.roles[0] = { ...onlyItem(value.roles), tools: ["read", "edit"] };

  assert.throws(
    () => parseRolePackManifest(value),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRolePackError);
      assert.match(error.message, /read-only role analyst/u);
      return true;
    },
  );
});

test("rejects Project Manager authority on ordinary roles", () => {
  const value = manifest("unsafe-authority");
  value.roles[0] = {
    ...onlyItem(value.roles),
    controllerActions: ["report-status", "request-merge"],
  };

  assert.throws(
    () => parseRolePackManifest(value),
    /requests Project Manager controller authority/u,
  );
});

test("loads prompts and gives user packs precedence over builtins", async () => {
  await withTemporaryRoots(async (roots) => {
    await createPack(
      roots.builtin,
      "shared-builtin",
      manifest("shared", "Builtin"),
    );
    await createPack(roots.user, "shared-user", manifest("shared", "User"));

    const result = await discoverRolePacks({
      roots: discoveryRoots(roots),
      projectTrusted: false,
    });

    assert.equal(result.diagnostics.length, 0);
    const pack = onlyItem(result.packs);
    const role = onlyItem(pack.roles);
    assert.equal(pack.scope, "user");
    assert.equal(pack.manifest.name, "User");
    assert.equal(role.runtimeId, "shared/analyst");
    assert.match(role.systemPrompt, /careful analyst/u);
  });
});

test("ignores project packs until project trust is active", async () => {
  await withTemporaryRoots(async (roots) => {
    await createPack(roots.builtin, "shared", manifest("shared", "Builtin"));
    await createPack(roots.project, "shared", manifest("shared", "Project"));

    const untrusted = await discoverRolePacks({
      roots: discoveryRoots(roots),
      projectTrusted: false,
    });
    assert.equal(onlyItem(untrusted.packs).scope, "builtin");

    const trusted = await discoverRolePacks({
      roots: discoveryRoots(roots),
      projectTrusted: true,
    });
    const trustedPack = onlyItem(trusted.packs);
    assert.equal(trustedPack.scope, "project");
    assert.equal(trustedPack.manifest.name, "Project");
  });
});

test("rejects prompt traversal before reading outside the pack", () => {
  const value = manifest("traversal");
  value.roles[0] = {
    ...onlyItem(value.roles),
    promptFile: "../outside.md",
  };
  assert.throws(
    () => parseRolePackManifest(value),
    /must stay inside its pack directory/u,
  );
});

test("rejects symbolic-link prompts", async () => {
  await withTemporaryRoots(async (roots) => {
    const directory = await createPack(
      roots.user,
      "linked",
      manifest("linked"),
    );
    const outside = path.join(roots.base, "outside.md");
    await writeFile(outside, "Malicious replacement prompt\n", "utf8");
    await rm(path.join(directory, "prompts/analyst.md"));
    await symlink(outside, path.join(directory, "prompts/analyst.md"));

    const result = await discoverRolePacks({
      roots: discoveryRoots(roots),
      projectTrusted: false,
    });

    assert.equal(result.packs.length, 0);
    assert.match(
      onlyItem(result.diagnostics).message,
      /cannot be symbolic links/u,
    );
  });
});

test("diagnoses duplicate pack ids at the same scope deterministically", async () => {
  await withTemporaryRoots(async (roots) => {
    await createPack(roots.user, "a-pack", manifest("duplicate", "First"));
    await createPack(roots.user, "b-pack", manifest("duplicate", "Second"));

    const result = await discoverRolePacks({
      roots: discoveryRoots(roots),
      projectTrusted: false,
    });

    assert.equal(onlyItem(result.packs).manifest.name, "First");
    assert.match(
      onlyItem(result.diagnostics).message,
      /duplicate role pack id/u,
    );
  });
});
