import type {
  ControllerSnapshot,
  FencedWrite,
} from "../../application/ports/controller-repository.ts";
import type { RunState, StoryState } from "../../domain/controller-state.ts";
import type { ControllerLaunchEndpointResolver } from "../../application/launch/environment-launch-configuration.ts";
import type { ControllerRuntimeDescriptor } from "./controller-runtime.ts";
import type { ControllerRuntime } from "./controller-runtime.ts";

export class RuntimeOrchestrationEndpointError extends Error {
  constructor(message: string) {
    super(`Runtime orchestration endpoint is invalid: ${message}`);
    this.name = "RuntimeOrchestrationEndpointError";
  }
}

export function deriveRuntimeEndpointEvidence(
  descriptor: ControllerRuntimeDescriptor,
  write: FencedWrite,
  runId: string,
  _revision: number,
): Pick<
  ReturnType<ControllerLaunchEndpointResolver["resolve"]>,
  | "controllerSocketPath"
  | "runtimePath"
  | "controllerFenceCurrent"
  | "expectedRevisionMatches"
> {
  void _revision;
  if (descriptor.runId !== runId) {
    throw new RuntimeOrchestrationEndpointError(
      "runtime descriptor run id does not match the assignment",
    );
  }
  const current =
    descriptor.ownerId === write.ownerId &&
    descriptor.fencingToken === write.fencingToken;
  if (!current) {
    throw new RuntimeOrchestrationEndpointError(
      "runtime descriptor is not owned by the current fenced write",
    );
  }
  return {
    controllerSocketPath: descriptor.socketPath,
    runtimePath: descriptor.runtimeDirectory,
    controllerFenceCurrent: true,
    expectedRevisionMatches: true,
  };
}

/** Resolves launch endpoint/fence evidence from the live controller runtime. */
export class ControllerRuntimeLaunchEndpointResolver implements ControllerLaunchEndpointResolver {
  readonly #runtime: ControllerRuntime;

  constructor(runtime: ControllerRuntime) {
    this.#runtime = runtime;
  }

  resolve(
    run: RunState,
    _story: StoryState,
    snapshot: ControllerSnapshot,
  ): ReturnType<ControllerLaunchEndpointResolver["resolve"]> {
    const descriptor = this.#runtime.descriptor;
    if (descriptor === null) {
      throw new RuntimeOrchestrationEndpointError(
        "controller runtime is not running",
      );
    }
    return deriveRuntimeEndpointEvidence(
      descriptor,
      this.#runtime.currentWrite(),
      run.id,
      snapshot.revision,
    );
  }
}
