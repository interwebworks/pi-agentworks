import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  InvalidRolePackError,
  parseRolePackManifest,
  type RoleDefinition,
  type RolePackManifest,
} from "../../domain/role-pack.ts";

const MANIFEST_FILE = "pack.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;

export type RolePackScope = "builtin" | "user" | "project";

export interface RolePackRoot {
  readonly scope: RolePackScope;
  readonly path: string;
}

export interface LoadedRole extends RoleDefinition {
  readonly runtimeId: string;
  readonly systemPrompt: string;
}

export interface LoadedRolePack {
  readonly manifest: RolePackManifest;
  readonly roles: readonly LoadedRole[];
  readonly scope: RolePackScope;
  readonly directory: string;
  readonly manifestPath: string;
}

export interface RolePackDiagnostic {
  readonly scope: RolePackScope;
  readonly path: string;
  readonly message: string;
}

export interface RolePackDiscoveryOptions {
  readonly roots: readonly RolePackRoot[];
  readonly projectTrusted: boolean;
}

export interface RolePackDiscoveryResult {
  readonly packs: readonly LoadedRolePack[];
  readonly diagnostics: readonly RolePackDiagnostic[];
}

function scopeRank(scope: RolePackScope): number {
  switch (scope) {
    case "builtin":
      return 0;
    case "user":
      return 1;
    case "project":
      return 2;
  }
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function readBoundedUtf8(
  filePath: string,
  maximumBytes: number,
): Promise<string> {
  const metadata = await stat(filePath);
  if (!metadata.isFile()) {
    throw new Error("expected a regular file");
  }
  if (metadata.size > maximumBytes) {
    throw new Error(`file exceeds the ${String(maximumBytes)} byte limit`);
  }
  return readFile(filePath, "utf8");
}

async function readPrompt(
  packDirectory: string,
  promptFile: string,
): Promise<string> {
  const promptPath = path.resolve(packDirectory, promptFile);
  if (!isWithin(promptPath, packDirectory)) {
    throw new Error(`prompt path escapes the pack directory: ${promptFile}`);
  }

  const promptMetadata = await lstat(promptPath);
  if (promptMetadata.isSymbolicLink()) {
    throw new Error(`prompt files cannot be symbolic links: ${promptFile}`);
  }

  const realPackDirectory = await realpath(packDirectory);
  const realPromptPath = await realpath(promptPath);
  if (!isWithin(realPromptPath, realPackDirectory)) {
    throw new Error(
      `prompt resolves outside the pack directory: ${promptFile}`,
    );
  }

  const prompt = await readBoundedUtf8(realPromptPath, MAX_PROMPT_BYTES);
  if (prompt.trim().length === 0) {
    throw new Error(`prompt is empty: ${promptFile}`);
  }
  return prompt;
}

async function loadPack(
  directory: string,
  scope: RolePackScope,
): Promise<LoadedRolePack> {
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error("pack entry must be a real directory, not a symbolic link");
  }

  const manifestPath = path.join(directory, MANIFEST_FILE);
  const manifestMetadata = await lstat(manifestPath);
  if (manifestMetadata.isSymbolicLink()) {
    throw new Error("pack.json cannot be a symbolic link");
  }

  const manifestText = await readBoundedUtf8(manifestPath, MAX_MANIFEST_BYTES);
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText) as unknown;
  } catch (error) {
    throw new Error(
      `pack.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const manifest = parseRolePackManifest(manifestValue);
  const roles = await Promise.all(
    manifest.roles.map(async (role) =>
      Object.freeze({
        ...role,
        runtimeId: `${manifest.id}/${role.id}`,
        systemPrompt: await readPrompt(directory, role.promptFile),
      }),
    ),
  );

  return Object.freeze({
    manifest,
    roles: Object.freeze(roles),
    scope,
    directory,
    manifestPath,
  });
}

export async function discoverRolePacks(
  options: RolePackDiscoveryOptions,
): Promise<RolePackDiscoveryResult> {
  const diagnostics: RolePackDiagnostic[] = [];
  const selected = new Map<string, LoadedRolePack>();
  const roots = [...options.roots]
    .filter((root) => root.scope !== "project" || options.projectTrusted)
    .sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope));
  const seenAtScope = new Set<string>();

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        continue;
      }
      diagnostics.push({
        scope: root.scope,
        path: root.path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const directory = path.join(root.path, entry.name);
      try {
        const pack = await loadPack(directory, root.scope);
        const scopeIdentity = `${root.scope}:${pack.manifest.id}`;
        if (seenAtScope.has(scopeIdentity)) {
          diagnostics.push({
            scope: root.scope,
            path: directory,
            message: `duplicate role pack id at the same scope: ${pack.manifest.id}`,
          });
          continue;
        }
        seenAtScope.add(scopeIdentity);
        selected.set(pack.manifest.id, pack);
      } catch (error) {
        diagnostics.push({
          scope: root.scope,
          path: directory,
          message:
            error instanceof InvalidRolePackError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
        });
      }
    }
  }

  return Object.freeze({
    packs: Object.freeze(
      [...selected.values()].sort((left, right) =>
        left.manifest.id.localeCompare(right.manifest.id),
      ),
    ),
    diagnostics: Object.freeze(diagnostics),
  });
}
