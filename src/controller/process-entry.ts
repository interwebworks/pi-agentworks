import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AgentMessageController,
  AgentMessageControllerError,
} from "../application/controller/agent-message-controller.ts";
import type {
  ControllerEventCursor,
  ControllerEventInput,
  ControllerSnapshot,
  FencedWrite,
  JsonValue,
} from "../application/ports/controller-repository.ts";
import type {
  AgentState,
  RunState,
  StoryState,
} from "../domain/controller-state.ts";
import {
  decodeAuthenticatedAgentMessage,
  InvalidAgentMessageRouteError,
} from "../application/protocol/agent-message-routing.ts";
import { planOrchestration } from "../domain/orchestration.ts";
import { countOccupiedAgentSlots } from "../domain/scheduling.ts";
import {
  ControllerRuntime,
  ControllerRuntimeError,
} from "../infrastructure/controller/controller-runtime.ts";
import { ControllerRequestError } from "../infrastructure/controller/unix-controller-transport.ts";
import { createProductionOrchestrationProvider } from "../infrastructure/controller/production-orchestration-provider.ts";

export interface ControllerOrchestrationExecutor {
  execute(write: FencedWrite): Promise<JsonValue>;
  restorePanes?(write: FencedWrite): Promise<JsonValue>;
}

export interface ControllerProcessDependencies {
  readonly orchestration?: ControllerOrchestrationExecutor;
  readonly orchestrationFactory?: (
    runtime: ControllerRuntime,
  ) => ControllerOrchestrationExecutor | undefined;
}

export type ControllerProcessCompositionProvider = (
  runtime: ControllerRuntime,
) => ControllerOrchestrationExecutor;

export function createConfiguredControllerProcessDependencies(
  environment: Readonly<Record<string, string | undefined>>,
  provider: ControllerProcessCompositionProvider | undefined,
): ControllerProcessDependencies {
  const orchestrationFactory = resolveConfiguredOrchestrationProvider(
    environment,
    provider,
  );
  return orchestrationFactory === undefined ? {} : { orchestrationFactory };
}

export function resolveConfiguredOrchestrationProvider(
  environment: Readonly<Record<string, string | undefined>>,
  provider: ControllerProcessCompositionProvider | undefined,
): ControllerProcessCompositionProvider | undefined {
  const marker = environment.AGENTWORKS_ENABLE_LIVE_ORCHESTRATION;
  if (marker === undefined) return undefined;
  if (marker !== "1") {
    throw new ControllerRuntimeError(
      "AGENTWORKS_ENABLE_LIVE_ORCHESTRATION must be exactly 1",
    );
  }
  if (provider === undefined) {
    throw new ControllerRuntimeError(
      "Live orchestration is enabled but no composition provider was supplied",
    );
  }
  return provider;
}

export interface ControllerProcessConfiguration {
  readonly runtimeRoot: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly leaseTtlMs?: number;
  readonly renewIntervalMs?: number;
}

function parseArguments(
  arguments_: readonly string[],
): ControllerProcessConfiguration {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new ControllerRuntimeError(
        "Controller process arguments must be name/value pairs",
      );
    }
    if (values.has(name)) {
      throw new ControllerRuntimeError(
        `Controller process argument ${name} is duplicated`,
      );
    }
    values.set(name, value);
  }
  const runtimeRoot = values.get("--runtime-root");
  const runId = values.get("--run-id");
  const ownerId = values.get("--owner-id");
  if (
    runtimeRoot === undefined ||
    runId === undefined ||
    ownerId === undefined
  ) {
    throw new ControllerRuntimeError(
      "Controller process requires --runtime-root, --run-id, and --owner-id",
    );
  }
  const allowedNames = new Set([
    "--runtime-root",
    "--run-id",
    "--owner-id",
    "--lease-ttl-ms",
    "--renew-interval-ms",
  ]);
  if ([...values.keys()].some((name) => !allowedNames.has(name))) {
    throw new ControllerRuntimeError(
      "Controller process received an unknown argument",
    );
  }
  const leaseTtlMs = parseOptionalPositiveInteger(
    values.get("--lease-ttl-ms"),
    "lease ttl",
  );
  const renewIntervalMs = parseOptionalPositiveInteger(
    values.get("--renew-interval-ms"),
    "renew interval",
  );
  return Object.freeze({
    runtimeRoot,
    runId,
    ownerId,
    ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
    ...(renewIntervalMs === undefined ? {} : { renewIntervalMs }),
  });
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new ControllerRuntimeError(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ControllerRuntimeError(`${label} must be a positive integer`);
  }
  return parsed;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function parseEventCursorPayload(payload: JsonValue): {
  readonly after: ControllerEventCursor;
  readonly limit: number;
} {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Event cursor payload is invalid",
    );
  }
  const keys = Object.keys(payload);
  if (
    keys.length !== 3 ||
    !keys.includes("revision") ||
    !keys.includes("eventIndex") ||
    !keys.includes("limit")
  ) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Event cursor payload is invalid",
    );
  }
  const record = payload as Readonly<Record<string, JsonValue>>;
  const revision = record.revision;
  const eventIndex = record.eventIndex;
  const limit = record.limit;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof eventIndex !== "number" ||
    !Number.isSafeInteger(eventIndex) ||
    eventIndex < -1 ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1_000
  ) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Event cursor payload is invalid",
    );
  }
  return Object.freeze({
    after: Object.freeze({ revision, eventIndex }),
    limit,
  });
}

function isEmptyObject(payload: JsonValue): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 0
  );
}

export function resolveControllerOrchestrationExecutor(
  runtime: ControllerRuntime,
  dependencies: ControllerProcessDependencies,
): ControllerOrchestrationExecutor | undefined {
  return (
    dependencies.orchestration ?? dependencies.orchestrationFactory?.(runtime)
  );
}

const orchestrationExecutions = new WeakMap<
  ControllerOrchestrationExecutor,
  Promise<JsonValue>
>();

export async function executeInjectedOrchestration(
  clientKind: "parent" | "management" | "child",
  payload: JsonValue,
  write: FencedWrite,
  executor: ControllerOrchestrationExecutor | undefined,
): Promise<JsonValue> {
  if (clientKind !== "parent") {
    throw new ControllerRequestError(
      "forbidden",
      "Only a parent client can execute orchestration",
    );
  }
  if (!isEmptyObject(payload)) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Orchestration execution payload must be empty",
    );
  }
  if (executor === undefined) {
    throw new ControllerRequestError(
      "not-configured",
      "Live orchestration effects are not configured",
    );
  }
  const previous = orchestrationExecutions.get(executor);
  const execution = (previous ?? Promise.resolve({}))
    .catch(() => ({}))
    .then(() => executor.execute(write));
  orchestrationExecutions.set(executor, execution);
  try {
    return await execution;
  } finally {
    if (orchestrationExecutions.get(executor) === execution) {
      orchestrationExecutions.delete(executor);
    }
  }
}

export async function executeInjectedPaneRestoration(
  clientKind: "parent" | "management" | "child",
  payload: JsonValue,
  write: FencedWrite,
  executor: ControllerOrchestrationExecutor | undefined,
): Promise<JsonValue> {
  if (clientKind !== "parent") {
    throw new ControllerRequestError(
      "forbidden",
      "Only a parent client can restore agent panes",
    );
  }
  if (!isEmptyObject(payload)) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Agent pane restoration payload must be empty",
    );
  }
  if (executor?.restorePanes === undefined) {
    throw new ControllerRequestError(
      "not-configured",
      "Agent pane restoration is not configured",
    );
  }
  return executor.restorePanes(write);
}

export type DeferredInitialResumeReason =
  | "eligible"
  | "not-high-complexity"
  | "run-not-ready"
  | "no-stories"
  | "launch-already-started";

export interface DeferredInitialResumeAssessment {
  readonly eligible: boolean;
  readonly reason: DeferredInitialResumeReason;
}

/**
 * Proves that a HIGH run is still at its durable post-initialization boundary.
 * Agent launch materialization is persisted before Pi process launch, so any
 * non-empty agent roster (or story assignment evidence) means this narrowly
 * scoped recovery path must not attempt another launch set.
 */
export function assessDeferredInitialResume(
  snapshot: ControllerSnapshot,
): DeferredInitialResumeAssessment {
  if (snapshot.run.complexity !== "HIGH") {
    return Object.freeze({ eligible: false, reason: "not-high-complexity" });
  }
  if (snapshot.run.status !== "ready") {
    return Object.freeze({ eligible: false, reason: "run-not-ready" });
  }
  if (snapshot.stories.length === 0) {
    return Object.freeze({ eligible: false, reason: "no-stories" });
  }
  const launchStarted =
    snapshot.agents.length > 0 ||
    snapshot.stories.some(
      (story) =>
        story.status !== "ready" ||
        story.assignedAgentId !== null ||
        story.reviewerAgentId !== null ||
        story.candidateStoryHead !== null ||
        story.reviewedIntegrationHead !== null ||
        story.mergeHead !== null,
    );
  return launchStarted
    ? Object.freeze({
        eligible: false,
        reason: "launch-already-started" as const,
      })
    : Object.freeze({ eligible: true, reason: "eligible" as const });
}

const deferredInitialResumes = new WeakMap<
  ControllerRuntime,
  Promise<JsonValue>
>();

function currentResumeWrite(runtime: ControllerRuntime): FencedWrite {
  try {
    runtime.assertReadyForWork();
  } catch {
    throw new ControllerRequestError(
      "recovery-required",
      "Controller recovery reconciliation is required before resuming orchestration",
    );
  }
  const write = runtime.currentWrite();
  const descriptor = runtime.descriptor;
  if (
    descriptor?.ownerId !== write.ownerId ||
    descriptor.fencingToken !== write.fencingToken ||
    descriptor.leaseExpiresAt <= write.now
  ) {
    throw new ControllerRequestError(
      "stale-fence",
      "Deferred orchestration resume requires a current controller fence",
    );
  }
  return write;
}

/**
 * Controller-authoritative, idempotent recovery for the one first tick that
 * was deliberately deferred when mandatory management bootstrap failed.
 * Concurrent parent retries share one in-flight decision and execution.
 */
export function resumeDeferredInitialOrchestration(
  clientKind: "parent" | "management" | "child",
  payload: JsonValue,
  runtime: ControllerRuntime,
  runId: string,
  executor: ControllerOrchestrationExecutor | undefined,
): Promise<JsonValue> {
  if (clientKind !== "parent") {
    return Promise.reject(
      new ControllerRequestError(
        "forbidden",
        "Only a parent client can resume deferred orchestration",
      ),
    );
  }
  if (!isEmptyObject(payload)) {
    return Promise.reject(
      new ControllerRequestError(
        "invalid-payload",
        "Deferred orchestration resume payload must be empty",
      ),
    );
  }
  const inFlight = deferredInitialResumes.get(runtime);
  if (inFlight !== undefined) return inFlight;
  const previousExecution =
    executor === undefined ? undefined : orchestrationExecutions.get(executor);

  const execution = (async (): Promise<JsonValue> => {
    // Share the executor-wide serialization boundary with ordinary first-tick
    // requests. If a normal launch is already in flight, assess durable state
    // only after it settles instead of racing a second launch set beside it.
    await previousExecution?.catch(() => undefined);
    const write = currentResumeWrite(runtime);
    const before = runtime.repository.loadSnapshot(runId);
    if (before === null) {
      throw new ControllerRequestError(
        "unknown-run",
        "Run has not been initialized",
      );
    }
    const assessment = assessDeferredInitialResume(before);
    if (!assessment.eligible) {
      return {
        accepted: true,
        resumed: false,
        reason: assessment.reason,
        revision: before.revision,
        agentCount: before.agents.length,
      };
    }
    if (executor === undefined) {
      throw new ControllerRequestError(
        "not-configured",
        "Live orchestration effects are not configured",
      );
    }

    // Re-read the authority immediately before effects. This rejects a lease
    // expiry or fenced takeover that occurred while evaluating run state.
    const currentWrite = currentResumeWrite(runtime);
    if (
      currentWrite.ownerId !== write.ownerId ||
      currentWrite.fencingToken !== write.fencingToken
    ) {
      throw new ControllerRequestError(
        "stale-fence",
        "Controller fence changed before deferred orchestration resume",
      );
    }
    await executor.execute(currentWrite);
    const after = runtime.repository.loadSnapshot(runId);
    if (after === null || after.agents.length === 0) {
      throw new ControllerRequestError(
        "resume-not-materialized",
        "Deferred orchestration did not durably materialize an agent launch",
      );
    }
    return {
      accepted: true,
      resumed: true,
      reason: "launched",
      revision: after.revision,
      agentCount: after.agents.length,
    };
  })();
  deferredInitialResumes.set(runtime, execution);
  if (executor !== undefined) orchestrationExecutions.set(executor, execution);
  const clearInFlight = (): void => {
    if (deferredInitialResumes.get(runtime) === execution) {
      deferredInitialResumes.delete(runtime);
    }
    if (
      executor !== undefined &&
      orchestrationExecutions.get(executor) === execution
    ) {
      orchestrationExecutions.delete(executor);
    }
  };
  void execution.then(clearInFlight, clearInFlight);
  return execution;
}

function parseRunInitializationPayload(payload: JsonValue): {
  readonly run: RunState;
  readonly stories: readonly StoryState[];
  readonly agents: readonly AgentState[];
  readonly events: readonly ControllerEventInput[];
} {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 4
  ) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Run initialization payload is invalid",
    );
  }
  const record = payload as Readonly<Record<string, JsonValue>>;
  if (
    record.run === null ||
    typeof record.run !== "object" ||
    Array.isArray(record.run) ||
    !Array.isArray(record.stories) ||
    !Array.isArray(record.agents) ||
    !Array.isArray(record.events)
  ) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Run initialization payload is invalid",
    );
  }
  return {
    run: record.run as unknown as RunState,
    stories: record.stories,
    agents: record.agents,
    events: record.events,
  };
}

export async function runControllerProcess(
  configuration: ControllerProcessConfiguration,
  dependencies: ControllerProcessDependencies = {},
): Promise<number> {
  let stopping = false;
  let orchestrationExecutor = dependencies.orchestration;
  let resolveCompletion: ((exitCode: number) => void) | null = null;
  const completion = new Promise<number>((resolve) => {
    resolveCompletion = resolve;
  });

  const requestStop = async (
    exitCode: number,
    releaseLease: boolean,
  ): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.shutdown({ releaseLease });
    } finally {
      resolveCompletion?.(exitCode);
    }
  };

  const runtime: ControllerRuntime = new ControllerRuntime({
    runtimeRoot: configuration.runtimeRoot,
    runId: configuration.runId,
    ownerId: configuration.ownerId,
    ...(configuration.leaseTtlMs === undefined
      ? {}
      : { leaseTtlMs: configuration.leaseTtlMs }),
    ...(configuration.renewIntervalMs === undefined
      ? {}
      : { renewIntervalMs: configuration.renewIntervalMs }),
    authorizeIdentity(request) {
      if (request.clientKind !== "child") return true;
      if (request.agentId === null) return false;
      const snapshot = runtime.repository.loadSnapshot(configuration.runId);
      return (
        snapshot?.agents.some((agent) => agent.id === request.agentId) ?? false
      );
    },
    handleRequest(request) {
      if (request.clientKind === "child") {
        if (request.agentId === null) {
          throw new ControllerRequestError(
            "invalid-payload",
            "Child requests require an agent identity",
          );
        }
        const snapshot = runtime.repository.loadSnapshot(configuration.runId);
        const agent = snapshot?.agents.find(
          (candidate) => candidate.id === request.agentId,
        );
        if (snapshot === null || agent === undefined) {
          throw new ControllerRequestError(
            "unknown-agent",
            "Child agent is not registered",
          );
        }
        if (request.action === "child.hello") {
          if (!isEmptyObject(request.payload)) {
            throw new ControllerRequestError(
              "invalid-payload",
              "Child hello payload must be empty",
            );
          }
          return toJsonValue({
            runId: configuration.runId,
            agentId: agent.id,
            revision: snapshot.revision,
            status: agent.status,
          });
        }
        if (request.action === "agent.message") {
          try {
            const message = decodeAuthenticatedAgentMessage(
              request.payload,
              configuration.runId,
              agent.id,
            );
            const result = new AgentMessageController(
              runtime.repository,
              Date.now,
            ).apply(message, runtime.currentWrite(), request.requestId);
            return toJsonValue({
              accepted: true,
              changed: result.changed,
              replayed: result.replayed,
              reaction: result.reaction,
              revision: result.revision,
              type: message.type,
            });
          } catch (error) {
            const code =
              error instanceof InvalidAgentMessageRouteError &&
              error.message.includes("identity does not match")
                ? "identity-mismatch"
                : error instanceof AgentMessageControllerError
                  ? "invalid-state"
                  : "invalid-message";
            throw new ControllerRequestError(
              code,
              error instanceof Error
                ? error.message.slice(0, 512)
                : "Child agent message is invalid",
            );
          }
        }
        throw new ControllerRequestError(
          "forbidden",
          "Child clients may only use child.hello and agent.message",
        );
      }
      if (
        request.clientKind === "management" &&
        request.action !== "snapshot.get" &&
        request.action !== "events.read" &&
        request.action !== "orchestration.plan"
      ) {
        throw new ControllerRequestError(
          "forbidden",
          "Management clients may only read snapshots, events, and orchestration plans",
        );
      }
      switch (request.action) {
        case "controller.ping": {
          if (!isEmptyObject(request.payload)) {
            throw new ControllerRequestError(
              "invalid-payload",
              "Ping payload must be empty",
            );
          }
          return toJsonValue({
            runId: configuration.runId,
            processId: process.pid,
            ownerId: configuration.ownerId,
            revision:
              runtime.repository.loadSnapshot(configuration.runId)?.revision ??
              null,
            recovery: runtime.descriptor?.recovery ?? null,
          });
        }
        case "run.initialize": {
          if (request.clientKind !== "parent") {
            throw new ControllerRequestError(
              "forbidden",
              "Only a parent client can initialize a run",
            );
          }
          const initialization = parseRunInitializationPayload(request.payload);
          if (initialization.run.id !== configuration.runId) {
            throw new ControllerRequestError(
              "invalid-payload",
              "Run initialization id does not match the controller run",
            );
          }
          const result = runtime.repository.initializeRun({
            write: runtime.currentWrite(),
            idempotencyKey:
              request.idempotencyKey ?? `run-initialize-${configuration.runId}`,
            request: request.payload,
            ...initialization,
          });
          return toJsonValue(result);
        }
        case "orchestration.execute": {
          return executeInjectedOrchestration(
            request.clientKind,
            request.payload,
            runtime.currentWrite(),
            orchestrationExecutor,
          );
        }
        case "orchestration.restore-panes": {
          return executeInjectedPaneRestoration(
            request.clientKind,
            request.payload,
            runtime.currentWrite(),
            orchestrationExecutor,
          );
        }
        case "orchestration.resume-initial": {
          return resumeDeferredInitialOrchestration(
            request.clientKind,
            request.payload,
            runtime,
            configuration.runId,
            orchestrationExecutor,
          );
        }
        case "orchestration.plan": {
          if (!isEmptyObject(request.payload)) {
            throw new ControllerRequestError(
              "invalid-payload",
              "Orchestration planning payload must be empty",
            );
          }
          const snapshot = runtime.repository.loadSnapshot(configuration.runId);
          if (snapshot === null) {
            throw new ControllerRequestError(
              "unknown-run",
              "Run has not been initialized",
            );
          }
          const actions = planOrchestration(
            snapshot.stories.map((story) => ({
              id: story.id,
              status: story.status,
              dependencies: [],
              reviewerAssigned: story.reviewerAgentId !== null,
            })),
            snapshot.run.complexity,
            countOccupiedAgentSlots(snapshot.agents),
          );
          if (actions.length > 64) {
            throw new ControllerRequestError(
              "invalid-state",
              "Orchestration plan exceeds the bounded action limit",
            );
          }
          return toJsonValue({
            runId: configuration.runId,
            revision: snapshot.revision,
            actions,
          });
        }
        case "snapshot.get": {
          if (!isEmptyObject(request.payload)) {
            throw new ControllerRequestError(
              "invalid-payload",
              "Snapshot payload must be empty",
            );
          }
          return toJsonValue(
            runtime.repository.loadSnapshot(configuration.runId),
          );
        }
        case "events.read": {
          const cursor = parseEventCursorPayload(request.payload);
          return toJsonValue(
            runtime.repository.readEvents(
              configuration.runId,
              cursor.after,
              cursor.limit,
            ),
          );
        }
        case "controller.shutdown": {
          if (request.clientKind !== "parent") {
            throw new ControllerRequestError(
              "forbidden",
              "Only a parent client can stop the controller",
            );
          }
          if (!isEmptyObject(request.payload)) {
            throw new ControllerRequestError(
              "invalid-payload",
              "Shutdown payload must be empty",
            );
          }
          setTimeout(() => void requestStop(0, true), 25);
          return Object.freeze({ accepted: true });
        }
        default:
          throw new ControllerRequestError(
            "unknown-action",
            `Unsupported controller action ${request.action}`,
          );
      }
    },
    onFatalError(error) {
      process.stderr.write(
        `Controller lease renewal failed: ${error.message}\n`,
      );
      void requestStop(1, false);
    },
  });

  await runtime.start();
  try {
    orchestrationExecutor = resolveControllerOrchestrationExecutor(
      runtime,
      dependencies,
    );
  } catch (error) {
    await runtime.shutdown({ releaseLease: true });
    throw error;
  }
  const onTerminate = (): void => {
    void requestStop(0, true);
  };
  process.once("SIGTERM", onTerminate);
  process.once("SIGINT", onTerminate);
  try {
    return await completion;
  } finally {
    process.off("SIGTERM", onTerminate);
    process.off("SIGINT", onTerminate);
  }
}

async function main(): Promise<void> {
  const configuration = parseArguments(process.argv.slice(2));
  const productionProvider =
    process.env.AGENTWORKS_ENABLE_LIVE_ORCHESTRATION === "1"
      ? createProductionOrchestrationProvider(
          process.env,
          fileURLToPath(new URL("../..", import.meta.url)),
        )
      : undefined;
  const orchestrationFactory = resolveConfiguredOrchestrationProvider(
    process.env,
    productionProvider,
  );
  process.exitCode = await runControllerProcess(
    configuration,
    orchestrationFactory === undefined ? {} : { orchestrationFactory },
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  void main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown controller failure";
    process.stderr.write(`Agentworks controller failed: ${message}\n`);
    process.exitCode = 1;
  });
}
