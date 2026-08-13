import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ModelAssociationRepository } from "../../application/ports/model-association-repository.ts";
import {
  createDefaultModelAssociationsConfig,
  parseModelAssociationsConfig,
  type ModelAssociationsConfig,
  type ModelAssociation,
} from "../../domain/model-association.ts";

export class FileModelAssociationRepositoryError extends Error {
  constructor(message: string) {
    super(`File model association repository failed: ${message}`);
    this.name = "FileModelAssociationRepositoryError";
  }
}

export interface FileModelAssociationRepositoryOptions {
  readonly configDirectory?: string;
  readonly fallback?: ModelAssociation;
}

function defaultConfigDirectory(): string {
  return join(homedir(), ".config", "pi-agentworks");
}

/**
 * Stores model associations in a user-private JSON file under the Agentworks
 * configuration directory. Writes are atomic (temp file + rename) and the file
 * is created with 0o600 permissions.
 */
export class FileModelAssociationRepository implements ModelAssociationRepository {
  readonly #path: string;
  readonly #fallback: ModelAssociation | null;

  constructor(options: FileModelAssociationRepositoryOptions = {}) {
    const directory = options.configDirectory ?? defaultConfigDirectory();
    this.#path = join(directory, "model-associations.json");
    this.#fallback = options.fallback ?? null;
  }

  load(): ModelAssociationsConfig {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return createDefaultModelAssociationsConfig(
          this.#fallback ?? this.#parentFallback(),
        );
      }
      throw new FileModelAssociationRepositoryError(
        error instanceof Error ? error.message : "cannot read associations",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new FileModelAssociationRepositoryError(
        `associations file contains invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    try {
      return parseModelAssociationsConfig(parsed);
    } catch (error) {
      throw new FileModelAssociationRepositoryError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  save(config: ModelAssociationsConfig): void {
    const validated = parseModelAssociationsConfig(config);
    const content = `${JSON.stringify(validated, null, 2)}\n`;
    const directory = dirname(this.#path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.#path}.tmp`;
    writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, this.#path);
  }

  #parentFallback(): ModelAssociation {
    const provider = process.env.PI_PROVIDER?.trim() ?? "";
    const model = process.env.PI_MODEL?.trim() ?? "";
    if (provider.length === 0 || model.length === 0) {
      throw new FileModelAssociationRepositoryError(
        "no default model association configured and no PI_PROVIDER/PI_MODEL environment values are available; set associations explicitly",
      );
    }
    return Object.freeze({ provider, model });
  }
}
