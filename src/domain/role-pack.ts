import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

const Identifier = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
});
const ToolName = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: "^[A-Za-z][A-Za-z0-9_:./-]*$",
});
const NonEmptyString = Type.String({ minLength: 1, maxLength: 4096 });
const NonEmptyStringArray = Type.Array(NonEmptyString, {
  minItems: 1,
  maxItems: 64,
  uniqueItems: true,
});

export const ControllerActionSchema = Type.Union([
  Type.Literal("report-status"),
  Type.Literal("contact-manager"),
  Type.Literal("submit-work"),
  Type.Literal("submit-review"),
  Type.Literal("manage-backlog"),
  Type.Literal("assign-task"),
  Type.Literal("steer-agent"),
  Type.Literal("request-candidate-commit"),
  Type.Literal("request-merge"),
  Type.Literal("request-cleanup"),
]);

export const RoleDefinitionSchema = Type.Object(
  {
    id: Identifier,
    label: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ minLength: 1, maxLength: 2048 }),
    authority: Type.Union([
      Type.Literal("project-manager"),
      Type.Literal("reviewer"),
      Type.Literal("worker"),
      Type.Literal("advisor"),
    ]),
    required: Type.Boolean(),
    taskKinds: NonEmptyStringArray,
    responsibilities: NonEmptyStringArray,
    promptFile: Type.String({ minLength: 1, maxLength: 240 }),
    tools: Type.Array(ToolName, { maxItems: 64, uniqueItems: true }),
    controllerActions: Type.Array(ControllerActionSchema, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    writePolicy: Type.Union([
      Type.Literal("read-only"),
      Type.Literal("story-writer"),
    ]),
    networkAccess: Type.Union([
      Type.Literal("disabled"),
      Type.Literal("required"),
    ]),
    defaultModel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    defaultThinking: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const RolePackManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: Identifier,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ minLength: 1, maxLength: 2048 }),
    domains: NonEmptyStringArray,
    requiresPacks: Type.Array(Identifier, {
      maxItems: 32,
      uniqueItems: true,
    }),
    roles: Type.Array(RoleDefinitionSchema, {
      minItems: 1,
      maxItems: 64,
    }),
  },
  { additionalProperties: false },
);

export type RoleDefinition = Static<typeof RoleDefinitionSchema>;
export type RolePackManifest = Static<typeof RolePackManifestSchema>;
export type ControllerAction = Static<typeof ControllerActionSchema>;
export type RoleAuthority = RoleDefinition["authority"];
export type RoleWritePolicy = RoleDefinition["writePolicy"];

export class InvalidRolePackError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Agentworks role pack:\n- ${issues.join("\n- ")}`);
    this.name = "InvalidRolePackError";
    this.issues = issues;
  }
}

function schemaIssues(value: unknown): string[] {
  return [...Errors(RolePackManifestSchema, value)].map((issue) => {
    const location = issue.instancePath.length > 0 ? issue.instancePath : "/";
    const detail =
      issue.keyword === "additionalProperties"
        ? ` (${issue.params.additionalProperties.join(", ")})`
        : "";
    return `${location}: ${issue.message}${detail}`;
  });
}

function domainIssues(manifest: RolePackManifest): string[] {
  const issues: string[] = [];
  const roleIds = new Set<string>();

  for (const role of manifest.roles) {
    if (roleIds.has(role.id)) {
      issues.push(`duplicate role id: ${role.id}`);
    }
    roleIds.add(role.id);

    if (
      role.promptFile.startsWith("/") ||
      role.promptFile.split(/[\\/]/u).includes("..")
    ) {
      issues.push(
        `role ${role.id} promptFile must stay inside its pack directory`,
      );
    }

    const hasWriteTool = role.tools.some(
      (tool) => tool === "write" || tool === "edit",
    );
    if (role.writePolicy === "read-only" && hasWriteTool) {
      issues.push(
        `read-only role ${role.id} cannot include write or edit tools`,
      );
    }
    if (role.writePolicy === "story-writer" && !hasWriteTool) {
      issues.push(`story-writer role ${role.id} must include write or edit`);
    }
    if (
      role.authority !== "project-manager" &&
      role.controllerActions.some((action) =>
        [
          "manage-backlog",
          "assign-task",
          "steer-agent",
          "request-merge",
          "request-cleanup",
        ].includes(action),
      )
    ) {
      issues.push(
        `role ${role.id} requests Project Manager controller authority`,
      );
    }
    if (role.authority === "reviewer" && role.writePolicy !== "read-only") {
      issues.push(`reviewer role ${role.id} must be read-only`);
    }
  }

  if (manifest.requiresPacks.includes(manifest.id)) {
    issues.push("a role pack cannot require itself");
  }

  return issues;
}

export function parseRolePackManifest(value: unknown): RolePackManifest {
  if (!Check(RolePackManifestSchema, value)) {
    throw new InvalidRolePackError(schemaIssues(value));
  }

  const issues = domainIssues(value);
  if (issues.length > 0) {
    throw new InvalidRolePackError(issues);
  }

  return Object.freeze(value);
}
