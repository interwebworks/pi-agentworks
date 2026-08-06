import assert from "node:assert/strict";
import test from "node:test";
import {
  LoadedRoleCatalog,
  LoadedRoleCatalogError,
} from "../src/infrastructure/role-packs/loaded-role-catalog.ts";
import type { LoadedRole } from "../src/infrastructure/role-packs/file-role-pack-repository.ts";

function role(runtimeId: string): LoadedRole {
  return {
    id: runtimeId.split("/").at(-1) ?? runtimeId,
    runtimeId,
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
}

test("loaded role catalog resolves exact runtime identities", async () => {
  const catalog = new LoadedRoleCatalog([role("pack/backend-developer")]);
  assert.equal(
    (await catalog.find("pack/backend-developer"))?.runtimeId,
    "pack/backend-developer",
  );
  assert.equal(await catalog.find("backend-developer"), null);
});

test("loaded role catalog rejects duplicate or incomplete identities", () => {
  assert.throws(
    () => new LoadedRoleCatalog([role("pack/backend"), role("pack/backend")]),
    LoadedRoleCatalogError,
  );
  assert.throws(
    () =>
      new LoadedRoleCatalog([{ ...role("pack/backend"), systemPrompt: "" }]),
    LoadedRoleCatalogError,
  );
});
