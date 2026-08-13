import type {
  ModelAssociation,
  ModelAssociationsConfig,
} from "../../domain/model-association.ts";
import type { RoleAuthority } from "../../domain/role-pack.ts";
import { resolveRoleModelAssociation } from "../../domain/model-association.ts";
import type {
  ModelAssociationRepository,
  RoleModelAssociationResolver,
} from "../ports/model-association-repository.ts";

export interface ConfiguredRoleModelAssociationResolverOptions {
  readonly repository: ModelAssociationRepository;
  readonly fallback?: ModelAssociation | null;
}

/**
 * Resolves a role's provider/model/thinking from persisted associations,
 * falling back to the runtime default when nothing matches.
 */
export class ConfiguredRoleModelAssociationResolver implements RoleModelAssociationResolver {
  readonly #repository: ModelAssociationRepository;
  readonly #fallback: ModelAssociation | null;

  constructor(options: ConfiguredRoleModelAssociationResolverOptions) {
    this.#repository = options.repository;
    this.#fallback = options.fallback ?? null;
  }

  resolve(runtimeId: string, authority: RoleAuthority): ModelAssociation {
    return resolveRoleModelAssociation(
      runtimeId,
      authority,
      this.#repository.load(),
      this.#fallback,
    );
  }

  /**
   * Expose the raw configuration for the TUI form so it can be edited and
   * saved back without re-loading from disk.
   */
  loadConfig(): ModelAssociationsConfig {
    return this.#repository.load();
  }
}
