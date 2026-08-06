import type {
  RoleCatalog,
  RoleCatalogEntry,
} from "../../application/launch/role-resource-resolver.ts";
import type {
  LoadedRole,
  LoadedRolePack,
} from "./file-role-pack-repository.ts";

export class LoadedRoleCatalogError extends Error {
  constructor(message: string) {
    super(`Loaded role catalog failed: ${message}`);
    this.name = "LoadedRoleCatalogError";
  }
}

/** Exact runtime-id lookup over already validated role-pack discovery output. */
export class LoadedRoleCatalog implements RoleCatalog {
  readonly #roles: ReadonlyMap<string, RoleCatalogEntry>;

  constructor(roles: readonly LoadedRole[]) {
    const entries = new Map<string, RoleCatalogEntry>();
    for (const role of roles) {
      if (
        role.runtimeId.trim().length === 0 ||
        role.systemPrompt.trim().length === 0
      ) {
        throw new LoadedRoleCatalogError(
          "role runtime identity and system prompt are required",
        );
      }
      if (entries.has(role.runtimeId)) {
        throw new LoadedRoleCatalogError(
          `duplicate role runtime id ${role.runtimeId}`,
        );
      }
      entries.set(role.runtimeId, role);
    }
    this.#roles = new Map(entries);
  }

  static fromPacks(packs: readonly LoadedRolePack[]): LoadedRoleCatalog {
    return new LoadedRoleCatalog(packs.flatMap((pack) => pack.roles));
  }

  find(runtimeId: string): Promise<RoleCatalogEntry | null> {
    return Promise.resolve(this.#roles.get(runtimeId) ?? null);
  }
}
