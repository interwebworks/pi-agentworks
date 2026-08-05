const MAX_PATTERN_LENGTH = 240;

export interface BranchProtectionContext {
  readonly defaultBranch: string | null;
  readonly repositoryProtectedPatterns: readonly string[];
}

export interface BranchProtectionAssessment {
  readonly branch: string;
  readonly protected: boolean;
  readonly reasons: readonly string[];
}

export class InvalidBranchProtectionPatternError extends Error {
  constructor(pattern: string) {
    super(`Invalid protected branch pattern: ${pattern}`);
    this.name = "InvalidBranchProtectionPatternError";
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validatePattern(pattern: string): string {
  if (
    pattern.length < 1 ||
    pattern.length > MAX_PATTERN_LENGTH ||
    pattern.startsWith("-") ||
    hasControlCharacter(pattern) ||
    /[\\:[\]{}]/u.test(pattern) ||
    pattern.includes("..") ||
    pattern.includes("***")
  ) {
    throw new InvalidBranchProtectionPatternError(pattern);
  }
  return pattern;
}

function escapeRegularExpression(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function compilePattern(pattern: string): RegExp {
  const normalized = validatePattern(pattern);
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else if (character !== undefined) {
      expression += escapeRegularExpression(character);
    }
  }
  return new RegExp(`${expression}$`, "u");
}

export function assessBranchProtection(
  inspection: BranchProtectionContext,
  branch: string,
  configuredPatterns: readonly string[] = [],
): BranchProtectionAssessment {
  const reasons: string[] = [];
  if (inspection.defaultBranch === branch) {
    reasons.push("branch is the detected default branch");
  }

  const patterns = [
    ...new Set([
      ...inspection.repositoryProtectedPatterns,
      ...configuredPatterns,
    ]),
  ];
  for (const pattern of patterns) {
    if (compilePattern(pattern).test(branch)) {
      reasons.push(`branch matches protected pattern ${pattern}`);
    }
  }

  return Object.freeze({
    branch,
    protected: reasons.length > 0,
    reasons: Object.freeze(reasons),
  });
}
