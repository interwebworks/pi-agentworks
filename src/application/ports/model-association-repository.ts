import type { RoleAuthority } from "../../domain/role-pack.ts";
import type {
  ModelAssociation,
  ModelAssociationsConfig,
} from "../../domain/model-association.ts";

/**
 * Persists user-configured model associations. Implementations decide whether
 * storage is per-user, per-project, or layered; callers resolve associations
 * against a loaded configuration and an optional runtime fallback.
 */
export interface ModelAssociationRepository {
  /**
   * Load the persisted associations. Returns a fresh default configuration
   * when no configuration has been saved yet.
   */
  load(): ModelAssociationsConfig;

  /**
   * Persist the associations. The saved value must round-trip through the
   * domain schema validator.
   */
  save(config: ModelAssociationsConfig): void;
}

/**
 * Resolves a role's model association from a configuration and a fallback.
 */
export interface RoleModelAssociationResolver {
  resolve(runtimeId: string, authority: RoleAuthority): ModelAssociation;
}
