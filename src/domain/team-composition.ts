import { getComplexityPolicy, type ComplexityMode } from "./complexity.ts";
import type { RoleAuthority, RoleWritePolicy } from "./role-pack.ts";

/**
 * The structural subset of a loaded role that team composition needs. A
 * `LoadedRole` from the role-pack repository satisfies this directly, so
 * composition stays a pure domain function with no infrastructure import.
 */
export interface ComposableRole {
  readonly runtimeId: string;
  readonly authority: RoleAuthority;
  readonly writePolicy: RoleWritePolicy;
  readonly required: boolean;
  readonly taskKinds: readonly string[];
}

export type TeamMemberReason =
  "required" | "task-match" | "reviewer-fallback" | "writer-fallback";

export interface TeamMember {
  readonly runtimeId: string;
  readonly authority: RoleAuthority;
  readonly reason: TeamMemberReason;
  readonly matchedKinds: readonly string[];
}

export interface ComposedTeam {
  readonly mode: ComplexityMode;
  readonly maximumAgents: number;
  readonly members: readonly TeamMember[];
}

export interface TeamCompositionRequest {
  readonly taskText: string;
  readonly mode: ComplexityMode;
  readonly roles: readonly ComposableRole[];
}

export class TeamCompositionError extends Error {
  constructor(message: string) {
    super(`Agentworks team composition failed: ${message}`);
    this.name = "TeamCompositionError";
  }
}

const AUTHORITY_ORDER: Readonly<Record<RoleAuthority, number>> = Object.freeze({
  "project-manager": 0,
  reviewer: 1,
  advisor: 2,
  worker: 3,
});

interface ScoredRole {
  readonly role: ComposableRole;
  readonly matched: readonly string[];
}

function tokenize(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 0),
  );
}

/**
 * Rank higher-fit roles first: more task matches, then pack-required roles,
 * then by authority (PM, reviewer, advisor, worker), then runtimeId so the
 * result is fully deterministic.
 */
function compareScored(left: ScoredRole, right: ScoredRole): number {
  if (left.matched.length !== right.matched.length) {
    return right.matched.length - left.matched.length;
  }
  if (left.role.required !== right.role.required) {
    return left.role.required ? -1 : 1;
  }
  const authorityDelta =
    AUTHORITY_ORDER[left.role.authority] -
    AUTHORITY_ORDER[right.role.authority];
  if (authorityDelta !== 0) {
    return authorityDelta;
  }
  return left.role.runtimeId.localeCompare(right.role.runtimeId);
}

function bestBy(
  scored: readonly ScoredRole[],
  predicate: (role: ComposableRole) => boolean,
): ScoredRole | undefined {
  return [...scored]
    .filter((entry) => predicate(entry.role))
    .sort(compareScored)[0];
}

/**
 * Select a task-appropriate team from the available roles, honoring the
 * complexity mode's agent limit. Every team gets exactly one Project Manager,
 * at least one reviewer, and at least one story writer; the remaining budget
 * is filled by task relevance. The agent limit includes the PM and reviewers.
 */
export function composeTeam(request: TeamCompositionRequest): ComposedTeam {
  const policy = getComplexityPolicy(request.mode);
  const limit = policy.maximumAgents;
  const tokens = tokenize(request.taskText);

  const scored: ScoredRole[] = request.roles.map((role) => ({
    role,
    matched: role.taskKinds.filter((kind) => tokens.has(kind)),
  }));

  const pm = bestBy(scored, (role) => role.authority === "project-manager");
  if (!pm) {
    throw new TeamCompositionError(
      "no Project Manager role is available; every team requires one",
    );
  }
  const reviewer = bestBy(scored, (role) => role.authority === "reviewer");
  if (!reviewer) {
    throw new TeamCompositionError(
      "no reviewer role is available; a story cannot be integrated without review",
    );
  }
  const writer = bestBy(scored, (role) => role.writePolicy === "story-writer");
  if (!writer) {
    throw new TeamCompositionError(
      "no story-writer role is available; no agent could perform the work",
    );
  }

  const members = new Map<string, TeamMember>();
  const add = (entry: ScoredRole, reason: TeamMemberReason): void => {
    if (members.has(entry.role.runtimeId)) {
      return;
    }
    if (
      entry.role.authority === "project-manager" &&
      entry.role.runtimeId !== pm.role.runtimeId
    ) {
      return; // exactly one Project Manager per team
    }
    if (members.size >= limit) {
      return;
    }
    members.set(entry.role.runtimeId, {
      runtimeId: entry.role.runtimeId,
      authority: entry.role.authority,
      reason,
      matchedKinds: entry.matched,
    });
  };

  // Mandatory core first, so it can never be crowded out by the limit.
  add(pm, "required");
  add(reviewer, reviewer.role.required ? "required" : "reviewer-fallback");
  add(writer, writer.role.required ? "required" : "writer-fallback");

  // Fill the remaining budget with pack-required and task-matched roles.
  const fillable = scored
    .filter(
      (entry) =>
        !members.has(entry.role.runtimeId) &&
        entry.role.authority !== "project-manager" &&
        (entry.role.required || entry.matched.length > 0),
    )
    .sort(compareScored);
  for (const entry of fillable) {
    add(entry, entry.role.required ? "required" : "task-match");
  }

  const ordered = [...members.values()].sort((left, right) => {
    const authorityDelta =
      AUTHORITY_ORDER[left.authority] - AUTHORITY_ORDER[right.authority];
    return authorityDelta !== 0
      ? authorityDelta
      : left.runtimeId.localeCompare(right.runtimeId);
  });

  return Object.freeze({
    mode: request.mode,
    maximumAgents: limit,
    members: Object.freeze(ordered),
  });
}

/**
 * The story-side input role selection needs: which task kinds the story
 * belongs to. A `UserStory` from the story-planning domain satisfies this
 * directly.
 */
export interface AssignableStory {
  readonly taskKinds: readonly string[];
}

function taskKindOverlap(
  storyKinds: readonly string[],
  roleKinds: readonly string[],
): number {
  const storySet = new Set(storyKinds);
  return roleKinds.filter((kind) => storySet.has(kind)).length;
}

/**
 * Pick the best-fit team member with the given authority for a story, scoring
 * candidates by task-kind overlap with their declared role and breaking ties
 * on runtimeId so the choice is deterministic. Returns null when the team has
 * no member of that authority.
 */
function selectByAuthority(
  story: AssignableStory,
  team: ComposedTeam,
  roles: readonly ComposableRole[],
  authority: RoleAuthority,
): TeamMember | null {
  const roleByRuntimeId = new Map(roles.map((role) => [role.runtimeId, role]));
  const candidates = team.members.filter(
    (member) => member.authority === authority,
  );
  if (candidates.length === 0) {
    return null;
  }

  const sorted = [...candidates].sort((left, right) => {
    const leftScore = taskKindOverlap(
      story.taskKinds,
      roleByRuntimeId.get(left.runtimeId)?.taskKinds ?? [],
    );
    const rightScore = taskKindOverlap(
      story.taskKinds,
      roleByRuntimeId.get(right.runtimeId)?.taskKinds ?? [],
    );
    return leftScore !== rightScore
      ? rightScore - leftScore
      : left.runtimeId.localeCompare(right.runtimeId);
  });
  return sorted.length > 0 ? (sorted[0] ?? null) : null;
}

/** Select the best-fit story-writer (authority "worker") for a story. */
export function selectStoryWorker(
  story: AssignableStory,
  team: ComposedTeam,
  roles: readonly ComposableRole[],
): TeamMember | null {
  return selectByAuthority(story, team, roles, "worker");
}

/** Select the best-fit reviewer (authority "reviewer") for a story. */
export function selectStoryReviewer(
  story: AssignableStory,
  team: ComposedTeam,
  roles: readonly ComposableRole[],
): TeamMember | null {
  return selectByAuthority(story, team, roles, "reviewer");
}
