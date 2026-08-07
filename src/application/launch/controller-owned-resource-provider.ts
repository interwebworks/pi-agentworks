import type { RunState, StoryState } from "../../domain/controller-state.ts";
import type {
  ControllerRepository,
  FencedWrite,
  WriterLease,
} from "../ports/controller-repository.ts";
import type { RoleCatalogEntry } from "./role-resource-resolver.ts";
import type {
  AssignmentLaunchResources,
  StoryAgentKind,
} from "./assignment-preparation.ts";
import type { ControllerSnapshot } from "../ports/controller-repository.ts";

export type ProvisionedAssignmentResources = Omit<
  AssignmentLaunchResources,
  "writerLeaseActive"
> & {
  readonly writerLeaseActive?: boolean;
};

export interface AssignmentPrivilegedResourceProvisioner {
  provision(
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<ProvisionedAssignmentResources>;
  rollback(
    resources: ProvisionedAssignmentResources,
    reason: string,
  ): Promise<void>;
}

export interface ControllerOwnedResourceProviderDependencies {
  readonly repository: Pick<
    ControllerRepository,
    "acquireWriterLease" | "releaseWriterLease" | "materializeAgentLaunch"
  >;
  readonly write: FencedWrite;
  readonly writerLeaseTtlMs: number;
  readonly provisioner: AssignmentPrivilegedResourceProvisioner;
}

export class ControllerOwnedResourceProviderError extends Error {
  constructor(message: string) {
    super(`Controller-owned resource provisioning failed: ${message}`);
    this.name = "ControllerOwnedResourceProviderError";
  }
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ControllerOwnedResourceProviderError(`${label} is empty`);
  }
}

function validateResources(
  resources: ProvisionedAssignmentResources,
  story: StoryState,
  run: RunState,
  kind: StoryAgentKind,
): void {
  if (resources.agent.runId !== run.id) {
    throw new ControllerOwnedResourceProviderError(
      "agent identity does not belong to the run",
    );
  }
  const expectedWorktree =
    kind === "project-manager" ? run.integrationWorktree : story.worktreePath;
  if (resources.agent.worktreePath !== expectedWorktree) {
    throw new ControllerOwnedResourceProviderError(
      "agent worktree does not match its assigned worktree",
    );
  }
  for (const [label, value] of [
    ["pane id", resources.paneId],
    ["session id", resources.sessionId],
    ["session path", resources.sessionPath],
    ["controller socket path", resources.controllerSocketPath],
    ["controller child capability", resources.controllerChildAuthToken],
  ] as const) {
    nonEmpty(value, label);
  }
  if (!resources.controllerFenceCurrent || !resources.expectedRevisionMatches) {
    throw new ControllerOwnedResourceProviderError(
      "controller fence or revision evidence is not current",
    );
  }
}

/**
 * Acquires the controller writer lease around privileged resource provisioning
 * and rolls back both the lease and resources on every preparation failure.
 */
export class ControllerOwnedAssignmentResourceProvider {
  readonly #repository: ControllerOwnedResourceProviderDependencies["repository"];
  readonly #write: FencedWrite;
  readonly #writerLeaseTtlMs: number;
  readonly #provisioner: AssignmentPrivilegedResourceProvisioner;

  constructor(dependencies: ControllerOwnedResourceProviderDependencies) {
    if (dependencies.writerLeaseTtlMs < 1) {
      throw new ControllerOwnedResourceProviderError(
        "writer lease ttl must be positive",
      );
    }
    this.#repository = dependencies.repository;
    this.#write = dependencies.write;
    this.#writerLeaseTtlMs = dependencies.writerLeaseTtlMs;
    this.#provisioner = dependencies.provisioner;
  }

  async resolve(
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AssignmentLaunchResources> {
    let resources: ProvisionedAssignmentResources | null = null;
    let lease: WriterLease | null = null;
    try {
      resources = await this.#provisioner.provision(
        kind,
        role,
        story,
        run,
        snapshot,
      );
      validateResources(resources, story, run, kind);
      if (kind === "writer") {
        lease = this.#repository.acquireWriterLease({
          write: this.#write,
          runId: run.id,
          storyId: story.id,
          ownerAgentId: resources.agent.id,
          ttlMs: this.#writerLeaseTtlMs,
          agent: resources.agent,
        });
        if (
          lease.ownerAgentId !== resources.agent.id ||
          lease.expiresAt === null ||
          lease.expiresAt <= this.#write.now
        ) {
          throw new ControllerOwnedResourceProviderError(
            "writer lease evidence is invalid",
          );
        }
      }
      if (this.#repository.materializeAgentLaunch !== undefined) {
        const launchedAgent = this.#repository.materializeAgentLaunch({
          write: this.#write,
          agent: resources.agent,
          paneId: resources.paneId,
        });
        resources = Object.freeze({ ...resources, agent: launchedAgent });
      }
      return Object.freeze({
        ...resources,
        writerLeaseActive: kind === "writer",
      });
    } catch (error) {
      if (lease !== null) {
        this.#repository.releaseWriterLease({
          write: this.#write,
          runId: run.id,
          storyId: story.id,
          ownerAgentId: lease.ownerAgentId ?? "",
          leaseToken: lease.leaseToken,
        });
      }
      if (resources !== null) {
        await this.#provisioner.rollback(
          resources,
          error instanceof Error
            ? error.message
            : "resource preparation failed",
        );
      }
      throw error;
    }
  }
}
