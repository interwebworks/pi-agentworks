import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { RoleAuthority } from "./role-pack.ts";

export const MODEL_ASSOCIATION_SCHEMA_VERSION = 1 as const;

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const ThinkingLevelSchema = Type.Union(
  [...THINKING_LEVELS].map((level) => Type.Literal(level)),
);

export const ModelAssociationSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    model: Type.String({ minLength: 1, maxLength: 240 }),
    thinking: Type.Optional(ThinkingLevelSchema),
  },
  { additionalProperties: false },
);

export interface ModelAssociation {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: ThinkingLevel;
}

export interface RoleModelAssociation {
  readonly runtimeId?: string;
  readonly authority?: RoleAuthority;
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string;
}

export const ModelAssociationsConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MODEL_ASSOCIATION_SCHEMA_VERSION),
    default: ModelAssociationSchema,
    associations: Type.Array(
      Type.Object(
        {
          runtimeId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 240 }),
          ),
          authority: Type.Optional(
            Type.Union([
              Type.Literal("project-manager"),
              Type.Literal("advisor"),
              Type.Literal("reviewer"),
              Type.Literal("worker"),
            ]),
          ),
          provider: Type.String({ minLength: 1, maxLength: 128 }),
          model: Type.String({ minLength: 1, maxLength: 240 }),
          thinking: Type.Optional(ThinkingLevelSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export interface ModelAssociationsConfig {
  readonly schemaVersion: typeof MODEL_ASSOCIATION_SCHEMA_VERSION;
  readonly default: ModelAssociation;
  readonly associations: readonly (ModelAssociation & {
    readonly runtimeId?: string;
    readonly authority?: RoleAuthority;
  })[];
}

export class InvalidModelAssociationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Agentworks model association:\n- ${issues.join("\n- ")}`);
    this.name = "InvalidModelAssociationError";
    this.issues = issues;
  }
}

export function parseModelAssociation(value: unknown): ModelAssociation {
  if (!Check(ModelAssociationSchema, value)) {
    const issues = [...Errors(ModelAssociationSchema, value)].map((issue) => {
      const location = issue.instancePath.length > 0 ? issue.instancePath : "/";
      return `${location}: ${issue.message}`;
    });
    throw new InvalidModelAssociationError(issues);
  }
  return Object.freeze(value);
}

export function parseModelAssociationsConfig(
  value: unknown,
): ModelAssociationsConfig {
  if (!Check(ModelAssociationsConfigSchema, value)) {
    const issues = [...Errors(ModelAssociationsConfigSchema, value)].map(
      (issue) => {
        const location =
          issue.instancePath.length > 0 ? issue.instancePath : "/";
        return `${location}: ${issue.message}`;
      },
    );
    throw new InvalidModelAssociationError(issues);
  }
  return Object.freeze(value);
}

export function createDefaultModelAssociationsConfig(
  fallback: ModelAssociation,
): ModelAssociationsConfig {
  return Object.freeze({
    schemaVersion: MODEL_ASSOCIATION_SCHEMA_VERSION,
    default: parseModelAssociation(fallback),
    associations: [],
  });
}

/**
 * Resolve the model association for a role. Precedence:
 * 1. Exact runtimeId match.
 * 2. Authority match.
 * 3. The configured default.
 * 4. The parent/runtime fallback (e.g. the model the user launched with).
 */
function association(
  provider: string,
  model: string,
  thinking: ThinkingLevel | undefined,
): ModelAssociation {
  return thinking === undefined
    ? Object.freeze({ provider, model })
    : Object.freeze({ provider, model, thinking });
}

export function resolveRoleModelAssociation(
  runtimeId: string,
  authority: RoleAuthority,
  config: ModelAssociationsConfig | null,
  fallback: ModelAssociation | null,
): ModelAssociation {
  const match = config?.associations.find(
    (association) => association.runtimeId === runtimeId,
  );
  if (match !== undefined) {
    return association(match.provider, match.model, match.thinking);
  }

  const authorityMatch = config?.associations.find(
    (association) => association.authority === authority,
  );
  if (authorityMatch !== undefined) {
    return association(
      authorityMatch.provider,
      authorityMatch.model,
      authorityMatch.thinking,
    );
  }

  if (config?.default !== undefined) {
    return association(
      config.default.provider,
      config.default.model,
      config.default.thinking,
    );
  }

  if (fallback !== null) {
    return fallback;
  }

  throw new InvalidModelAssociationError([
    `no model association found for ${runtimeId} (${authority}) and no fallback provided`,
  ]);
}
