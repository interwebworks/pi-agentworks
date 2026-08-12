import { randomUUID } from "node:crypto";
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
import type { AgentMessage } from "../domain/agent-communication.ts";
import type {
  AgentState,
  RunState,
  StoryState,
} from "../domain/controller-state.ts";
import {
  transitionAgent,
  transitionRun,
  transitionStory,
} from "../domain/controller-state.ts";
import { assessManagementQuitReadiness } from "../domain/management-quit.ts";
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
import { createProductionOrchestrationProviderFromComposition } from "../infrastructure/controller/production-orchestration-provider.ts";
import {
  authenticateControllerLaunchComposition,
  createControllerLaunchComposition,
  sameControllerLaunchComposition,
  verifyControllerLaunchComposition,
  type ControllerLaunchComposition,
} from "../infrastructure/controller/controller-launch-composition.ts";

export interface ControllerOrchestrationExecutor {
  execute(write: FencedWrite): Promise<JsonValue>;
  handleAgentMessage?(
    message: AgentMessage,
    write: FencedWrite,
    requestId: string,
  ): Promise<JsonValue>;
  restorePanes?(write: FencedWrite): Promise<JsonValue>;
}

export interface ControllerProcessDependencies {
  readonly orchestration?: ControllerOrchestrationExecutor;
  readonly orchestrationFactory?: (
    runtime: ControllerRuntime,
  ) => ControllerOrchestrationExecutor | undefined;
  readonly launchComposition?: ControllerLaunchComposition;
  readonly requirePersistedLaunchComposition?: boolean;
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
  readonly requireLaunchComposition?: boolean;
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
    "--require-launch-composition",
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
  const requireComposition = values.get("--require-launch-composition");
  if (requireComposition !== undefined && requireComposition !== "1") {
    throw new ControllerRuntimeError(
      "require launch composition must be exactly 1",
    );
  }
  return Object.freeze({
    runtimeRoot,
    runId,
    ownerId,
    ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
    ...(renewIntervalMs === undefined ? {} : { renewIntervalMs }),
    ...(requireComposition === undefined
      ? {}
      : { requireLaunchComposition: true }),
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

type LaunchCompositionRepository = Required<
  Pick<
    ControllerRuntime["repository"],
    "bindControllerLaunchComposition" | "readControllerLaunchComposition"
  >
>;

function launchCompositionRepository(
  runtime: ControllerRuntime,
): LaunchCompositionRepository {
  const repository = runtime.repository;
  if (
    repository.bindControllerLaunchComposition === undefined ||
    repository.readControllerLaunchComposition === undefined
  ) {
    throw new ControllerRuntimeError(
      "Controller repository does not support launch composition evidence",
    );
  }
  return repository as LaunchCompositionRepository;
}

function verifyPersistedLaunchComposition(
  repository: ControllerRuntime["repository"],
  authToken: string,
  expected: ControllerLaunchComposition,
): void {
  if (repository.readControllerLaunchComposition === undefined) {
    throw new ControllerRuntimeError(
      "Controller repository does not support launch composition evidence",
    );
  }
  const record = repository.readControllerLaunchComposition(expected.runId);
  if (record === null) {
    throw new ControllerRuntimeError(
      "Persisted controller launch composition is missing",
    );
  }
  const persisted = verifyControllerLaunchComposition(
    record.compositionJson,
    record.authenticationTag,
    authToken,
  );
  if (!sameControllerLaunchComposition(persisted, expected)) {
    throw new ControllerRuntimeError(
      "Persisted controller launch composition differs from restart composition",
    );
  }
}

function bindLaunchComposition(
  clientKind: "parent" | "management" | "child",
  payload: JsonValue,
  runtime: ControllerRuntime,
  composition: ControllerLaunchComposition | undefined,
): JsonValue {
  if (clientKind !== "parent") {
    throw new ControllerRequestError(
      "forbidden",
      "Only a parent client can bind launch composition evidence",
    );
  }
  if (!isEmptyObject(payload)) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Launch composition binding payload must be empty",
    );
  }
  if (composition === undefined) {
    throw new ControllerRequestError(
      "not-configured",
      "Trusted launch composition is unavailable",
    );
  }
  const authenticated = authenticateControllerLaunchComposition(
    composition,
    runtime.authToken,
  );
  const bound = launchCompositionRepository(
    runtime,
  ).bindControllerLaunchComposition({
    write: runtime.currentWrite(),
    runId: composition.runId,
    compositionJson: authenticated.serialized,
    authenticationTag: authenticated.authenticationTag,
  });
  return {
    accepted: true,
    runId: bound.runId,
    boundAt: bound.boundAt,
    authenticationTag: bound.authenticationTag,
  };
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
const agentMessageExecutions = new WeakMap<
  ControllerOrchestrationExecutor,
  Map<string, Promise<JsonValue>>
>();

function enqueueExecutorOperation(
  executor: ControllerOrchestrationExecutor,
  operation: () => Promise<JsonValue>,
): Promise<JsonValue> {
  const previous = orchestrationExecutions.get(executor);
  const execution = (previous ?? Promise.resolve({}))
    .catch(() => ({}))
    .then(operation);
  orchestrationExecutions.set(executor, execution);
  const clear = (): void => {
    if (orchestrationExecutions.get(executor) === execution) {
      orchestrationExecutions.delete(executor);
    }
  };
  void execution.then(clear, clear);
  return execution;
}

function requiresLifecycleHandler(message: AgentMessage): boolean {
  return ["candidate-ready", "review-submitted"].includes(message.type);
}

function triggersOrchestrationTick(message: AgentMessage): boolean {
  return [
    "candidate-ready",
    "review-submitted",
    "operation-completed",
    "session-shutdown",
  ].includes(message.type);
}

function agentMessageResponse(
  message: AgentMessage,
  result: ReturnType<AgentMessageController["apply"]>,
): JsonValue {
  return toJsonValue({
    accepted: true,
    changed: result.changed,
    replayed: result.replayed,
    reaction: result.reaction,
    revision: result.revision,
    type: message.type,
  });
}

/**
 * Commit one authenticated child message, then perform any privileged
 * lifecycle action and bounded orchestration drain behind the same
 * executor-wide serialization boundary. Duplicate in-flight request ids share
 * one promise, and all effects necessarily begin after the message commit.
 */
export function executeCommittedAgentMessage(
  message: AgentMessage,
  requestId: string,
  runtime: ControllerRuntime,
  executor: ControllerOrchestrationExecutor | undefined,
): Promise<JsonValue> {
  const apply = (): ReturnType<AgentMessageController["apply"]> =>
    new AgentMessageController(runtime.repository, Date.now).apply(
      message,
      runtime.currentWrite(),
      requestId,
    );
  if (executor === undefined) {
    const result = apply();
    if (requiresLifecycleHandler(message)) {
      return Promise.reject(
        new ControllerRequestError(
          "not-configured",
          "Controller lifecycle effects are not configured",
        ),
      );
    }
    return Promise.resolve(agentMessageResponse(message, result));
  }

  let requests = agentMessageExecutions.get(executor);
  if (requests === undefined) {
    requests = new Map();
    agentMessageExecutions.set(executor, requests);
  }
  const existing = requests.get(requestId);
  if (existing !== undefined) return existing;
  const execution = enqueueExecutorOperation(executor, async () => {
    const result = apply();
    if (executor.handleAgentMessage !== undefined) {
      await executor.handleAgentMessage(
        message,
        currentControllerWrite(runtime, "processing child lifecycle"),
        requestId,
      );
    } else if (requiresLifecycleHandler(message)) {
      throw new ControllerRequestError(
        "not-configured",
        "Controller lifecycle effects are not configured",
      );
    }
    if (triggersOrchestrationTick(message)) {
      await executor.execute(
        currentControllerWrite(runtime, "advancing child lifecycle"),
      );
    }
    return agentMessageResponse(message, result);
  });
  requests.set(requestId, execution);
  const clear = (): void => {
    if (requests.get(requestId) === execution) requests.delete(requestId);
  };
  void execution.then(clear, clear);
  return execution;
}

export async function executeInjectedOrchestration(
  clientKind: "parent" | "management" | "child",
  payload: JsonValue,
  write: FencedWrite,
  executor: ControllerOrchestrationExecutor | undefined,
): Promise<JsonValue> {
  if (clientKind !== "parent" && clientKind !== "management") {
    throw new ControllerRequestError(
      "forbidden",
      "Only parent or management clients can execute orchestration",
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
  try {
    return await enqueueExecutorOperation(executor, () =>
      executor.execute(write),
    );
  } catch (error) {
    if (error instanceof ControllerRequestError) throw error;
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/[\r\n\t]+/gu, " ")
      .trim()
      .slice(0, 400);
    throw new ControllerRequestError(
      "orchestration-failed",
      `Orchestration failed: ${detail || "unknown error"}`,
    );
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
  return enqueueExecutorOperation(executor, async () => {
    try {
      return await (executor.restorePanes?.(write) ?? Promise.resolve({}));
    } catch (error) {
      if (error instanceof ControllerRequestError) throw error;
      const message =
        error instanceof Error
          ? error.message.slice(0, 512)
          : "Agent pane restoration failed";
      throw new ControllerRequestError(
        "restoration-failed",
        message.length > 0 ? message : "Agent pane restoration failed",
      );
    }
  });
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

function currentControllerWrite(
  runtime: ControllerRuntime,
  purpose: string,
): FencedWrite {
  try {
    runtime.assertReadyForWork();
  } catch {
    throw new ControllerRequestError(
      "recovery-required",
      `Controller recovery reconciliation is required before ${purpose}`,
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
      `${purpose} requires a current controller fence`,
    );
  }
  return write;
}

function currentResumeWrite(runtime: ControllerRuntime): FencedWrite {
  return currentControllerWrite(runtime, "resuming deferred orchestration");
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

type ParentControlAction =
  | "approve"
  | "reject"
  | "steer"
  | "pause"
  | "resume"
  | "focus"
  | "close"
  | "restart"
  | "dismiss";

interface ParentControlPayload {
  readonly action: ParentControlAction;
  readonly agentId?: string;
  readonly message?: string;
}

function parseParentControlPayload(payload: JsonValue): ParentControlPayload {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Parent control payload is invalid",
    );
  }
  const record = payload as Readonly<Record<string, JsonValue>>;
  if (
    Object.keys(record).some(
      (key) => !["action", "agentId", "message"].includes(key),
    )
  ) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Parent control payload contains unknown fields",
    );
  }
  const action = record.action;
  const allowed = new Set([
    "approve",
    "reject",
    "steer",
    "pause",
    "resume",
    "focus",
    "close",
    "restart",
    "dismiss",
  ]);
  if (typeof action !== "string" || !allowed.has(action)) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Parent control action is invalid",
    );
  }
  const agentId = record.agentId;
  const message = record.message;
  if (
    agentId !== undefined &&
    (typeof agentId !== "string" ||
      agentId.trim().length === 0 ||
      agentId.length > 128)
  ) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Parent control agentId is invalid",
    );
  }
  if (
    message !== undefined &&
    (typeof message !== "string" ||
      message.trim().length === 0 ||
      message.length > 8192)
  ) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Parent control message is invalid",
    );
  }
  if (action === "steer" && message === undefined) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Steer requires a message",
    );
  }
  if (action === "focus" && agentId === undefined) {
    throw new ControllerRequestError(
      "invalid-payload",
      "Focus requires an agentId",
    );
  }
  return Object.freeze({
    action: action as ParentControlAction,
    ...(agentId === undefined ? {} : { agentId }),
    ...(message === undefined ? {} : { message }),
  });
}

function parentControlEvent(
  action: ParentControlAction,
  entityType: ControllerEventInput["entityType"],
  entityId: string,
  payload: JsonValue,
  occurredAt: number,
): ControllerEventInput {
  return {
    eventId: randomUUID(),
    type: `parent-${action}`,
    entityType,
    entityId,
    payload,
    occurredAt,
  };
}

function blockRunAfterOrchestrationFailure(
  request: {
    readonly requestId: string;
    readonly idempotencyKey: string | null;
  },
  runtime: ControllerRuntime,
  runId: string,
  error: unknown,
): void {
  if (
    !(error instanceof ControllerRequestError) ||
    error.code !== "orchestration-failed"
  ) {
    return;
  }
  const status = runtime.repository.loadSnapshot(runId)?.run.status;
  if (status !== "ready" && status !== "active") return;
  executeParentControl(
    {
      requestId: `${request.requestId}:orchestration-failure`,
      idempotencyKey:
        request.idempotencyKey === null
          ? null
          : `${request.idempotencyKey}:orchestration-failure`,
      payload: {
        action: "pause",
        message: `orchestration failure: ${error.message}`,
      },
    },
    runtime,
    runId,
  );
}

function executeParentControl(
  request: {
    readonly requestId: string;
    readonly idempotencyKey: string | null;
    readonly payload: JsonValue;
  },
  runtime: ControllerRuntime,
  runId: string,
): JsonValue {
  const control = parseParentControlPayload(request.payload);
  const snapshot = runtime.repository.loadSnapshot(runId);
  if (snapshot === null) {
    throw new ControllerRequestError(
      "unknown-run",
      "Run has not been initialized",
    );
  }
  const now = Date.now();
  let run = snapshot.run;
  let stories = snapshot.stories;
  let agents = snapshot.agents;
  const events: ControllerEventInput[] = [];
  const targetAgent =
    control.agentId === undefined
      ? undefined
      : snapshot.agents.find((agent) => agent.id === control.agentId);
  if (control.agentId !== undefined && targetAgent === undefined) {
    throw new ControllerRequestError(
      "unknown-agent",
      "Parent control target agent is not registered",
    );
  }

  switch (control.action) {
    case "approve":
      if (run.status === "awaiting-approval") {
        run = transitionRun(run, { type: "plan-approved", at: now });
        events.push(
          parentControlEvent(
            "approve",
            "run",
            runId,
            { status: run.status },
            now,
          ),
        );
      } else if (run.status !== "ready") {
        throw new ControllerRequestError(
          "invalid-state",
          `Cannot approve a run in ${run.status} state`,
        );
      }
      stories = stories.map((story) => {
        if (story.status !== "awaiting-approval") return story;
        const approved = transitionStory(story, {
          type: "story-plan-approved",
          at: now,
        });
        events.push(
          parentControlEvent(
            "approve",
            "story",
            story.id,
            { status: approved.status },
            now,
          ),
        );
        return approved;
      });
      break;
    case "reject":
      if (run.status === "awaiting-approval") {
        run = transitionRun(run, { type: "plan-revision-requested", at: now });
        events.push(
          parentControlEvent(
            "reject",
            "run",
            runId,
            { status: run.status },
            now,
          ),
        );
      } else if (run.status !== "planning") {
        throw new ControllerRequestError(
          "invalid-state",
          `Cannot reject a run in ${run.status} state`,
        );
      }
      stories = stories.map((story) => {
        if (story.status !== "awaiting-approval") return story;
        const revised = transitionStory(story, {
          type: "story-plan-revision-requested",
          at: now,
        });
        events.push(
          parentControlEvent(
            "reject",
            "story",
            story.id,
            { status: revised.status },
            now,
          ),
        );
        return revised;
      });
      break;
    case "pause":
      if (run.status === "blocked") break;
      if (run.status !== "ready" && run.status !== "active") {
        throw new ControllerRequestError(
          "invalid-state",
          `Cannot pause a run in ${run.status} state`,
        );
      }
      run = transitionRun(run, {
        type: "run-blocked",
        at: now,
        reason: `parent pause: ${control.message?.trim() ?? "paused by parent"}`,
      });
      events.push(
        parentControlEvent(
          "pause",
          "run",
          runId,
          { reason: run.blockedReason },
          now,
        ),
      );
      break;
    case "resume":
      if (run.status === "blocked") {
        run = transitionRun(run, { type: "run-resumed", at: now });
        events.push(
          parentControlEvent(
            "resume",
            "run",
            runId,
            { status: run.status },
            now,
          ),
        );
      } else if (run.status !== "ready" && run.status !== "active") {
        throw new ControllerRequestError(
          "invalid-state",
          `Cannot resume a run in ${run.status} state`,
        );
      }
      break;
    case "restart": {
      if (targetAgent === undefined || control.message !== undefined) {
        throw new ControllerRequestError(
          "invalid-payload",
          "Restart requires an agentId and no message",
        );
      }
      if (
        ["completed", "failed", "closed", "disconnected"].includes(
          targetAgent.status,
        )
      ) {
        throw new ControllerRequestError(
          "invalid-state",
          `Cannot restart agent in ${targetAgent.status} state`,
        );
      }
      const disconnected = transitionAgent(targetAgent, {
        type: "pane-lost",
        at: now,
      });
      agents = agents.map((agent) =>
        agent.id === disconnected.id ? disconnected : agent,
      );
      events.push(
        parentControlEvent(
          "restart",
          "agent",
          targetAgent.id,
          { paneId: targetAgent.paneId },
          now,
        ),
      );
      break;
    }
    case "dismiss": {
      if (targetAgent !== undefined || control.message !== undefined) {
        throw new ControllerRequestError(
          "invalid-payload",
          "Dismiss applies only to the complete management run",
        );
      }
      const readiness = assessManagementQuitReadiness(snapshot);
      if (!readiness.canQuit) {
        throw new ControllerRequestError(
          "run-not-quiescent",
          `Management quit is blocked by ${readiness.blockers
            .map(
              (blocker) =>
                `${blocker.entityType}:${blocker.entityId} (${blocker.status})`,
            )
            .join(", ")}`.slice(0, 512),
        );
      }
      if (!["completed", "cancelled"].includes(run.status)) {
        run = transitionRun(run, {
          type: "run-cancelled",
          at: now,
          reason: "management dismissed after all agent work completed",
        });
        events.push(
          parentControlEvent(
            "dismiss",
            "run",
            runId,
            { status: run.status },
            now,
          ),
        );
      }
      break;
    }
    case "close":
      if (targetAgent !== undefined) {
        events.push(
          parentControlEvent(
            "close",
            "agent",
            targetAgent.id,
            { paneId: targetAgent.paneId },
            now,
          ),
        );
        break;
      }
      if (!["completed", "failed", "cancelled"].includes(run.status)) {
        run = transitionRun(run, {
          type: "run-cancelled",
          at: now,
          reason: `parent close: ${control.message?.trim() ?? "closed by parent"}`,
        });
        events.push(
          parentControlEvent(
            "close",
            "run",
            runId,
            { status: run.status },
            now,
          ),
        );
      }
      break;
    case "steer":
    case "focus":
      if (targetAgent === undefined) {
        throw new ControllerRequestError(
          "invalid-payload",
          `${control.action} requires an agentId`,
        );
      }
      events.push(
        parentControlEvent(
          control.action,
          "agent",
          targetAgent.id,
          {
            ...(control.message === undefined
              ? {}
              : { message: control.message }),
          },
          now,
        ),
      );
      break;
  }

  if (events.length > 0) {
    const result = runtime.repository.commitSnapshot({
      write: runtime.currentWrite(),
      runId,
      expectedRevision: snapshot.revision,
      idempotencyKey: request.idempotencyKey ?? request.requestId,
      request: request.payload,
      run,
      stories,
      agents,
      events,
    });
    return toJsonValue({
      accepted: true,
      action: control.action,
      revision: result.revision,
      runStatus: run.status,
      agentId: targetAgent?.id ?? null,
      paneId: targetAgent?.paneId ?? null,
    });
  }
  return toJsonValue({
    accepted: true,
    action: control.action,
    revision: snapshot.revision,
    runStatus: run.status,
    agentId: targetAgent?.id ?? null,
    paneId: targetAgent?.paneId ?? null,
  });
}

export async function runControllerProcess(
  configuration: ControllerProcessConfiguration,
  dependencies: ControllerProcessDependencies = {},
): Promise<number> {
  const requirePersistedLaunchComposition =
    configuration.requireLaunchComposition === true ||
    dependencies.requirePersistedLaunchComposition === true;
  if (
    requirePersistedLaunchComposition &&
    dependencies.launchComposition === undefined
  ) {
    throw new ControllerRuntimeError(
      "Restart requires exact persisted launch composition evidence",
    );
  }
  const launchComposition = dependencies.launchComposition;
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
    ...(requirePersistedLaunchComposition && launchComposition !== undefined
      ? {
          validateStartup(context) {
            verifyPersistedLaunchComposition(
              context.repository,
              context.authToken,
              launchComposition,
            );
          },
        }
      : {}),
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
          let message: AgentMessage;
          try {
            message = decodeAuthenticatedAgentMessage(
              request.payload,
              configuration.runId,
              agent.id,
            );
          } catch (error) {
            const code =
              error instanceof InvalidAgentMessageRouteError &&
              error.message.includes("identity does not match")
                ? "identity-mismatch"
                : "invalid-message";
            throw new ControllerRequestError(
              code,
              error instanceof Error
                ? error.message.slice(0, 512)
                : "Child agent message is invalid",
            );
          }
          return executeCommittedAgentMessage(
            message,
            request.requestId,
            runtime,
            orchestrationExecutor,
          ).catch((error: unknown) => {
            if (error instanceof ControllerRequestError) throw error;
            throw new ControllerRequestError(
              error instanceof AgentMessageControllerError
                ? "invalid-state"
                : "lifecycle-failed",
              error instanceof Error
                ? error.message.slice(0, 512)
                : "Child lifecycle handling failed",
            );
          });
        }
        throw new ControllerRequestError(
          "forbidden",
          "Child clients may only use child.hello and agent.message",
        );
      }
      if (request.clientKind === "management") {
        const allowedRead =
          request.action === "snapshot.get" ||
          request.action === "events.read" ||
          request.action === "orchestration.plan" ||
          request.action === "orchestration.execute";
        if (request.action === "parent.control") {
          const control = parseParentControlPayload(request.payload);
          if (
            control.action !== "approve" &&
            control.action !== "reject" &&
            control.action !== "pause" &&
            control.action !== "resume" &&
            control.action !== "restart" &&
            control.action !== "dismiss"
          ) {
            throw new ControllerRequestError(
              "forbidden",
              "Management controls are limited to approve, reject, pause, resume, restart, and dismiss",
            );
          }
        } else if (!allowedRead) {
          throw new ControllerRequestError(
            "forbidden",
            "Management clients may only read state or control workflow approval and execution",
          );
        }
      }
      switch (request.action) {
        case "parent.control":
          return executeParentControl(request, runtime, configuration.runId);
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
        case "controller.launch-composition.bind": {
          return bindLaunchComposition(
            request.clientKind,
            request.payload,
            runtime,
            dependencies.launchComposition,
          );
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
        case "orchestration.execute":
          return executeInjectedOrchestration(
            request.clientKind,
            request.payload,
            runtime.currentWrite(),
            orchestrationExecutor,
          ).catch((error: unknown) => {
            if (request.clientKind === "management") {
              blockRunAfterOrchestrationFailure(
                request,
                runtime,
                configuration.runId,
                error,
              );
            }
            throw error;
          });
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
              reviewerClosed:
                story.reviewerAgentId !== null &&
                snapshot.agents.some(
                  (agent) =>
                    agent.id === story.reviewerAgentId &&
                    agent.status === "closed",
                ),
              workspaceCleaned: story.workspaceCleaned === true,
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
  const launchComposition = createControllerLaunchComposition(
    configuration.runId,
    process.env,
    fileURLToPath(new URL("../..", import.meta.url)),
    {
      ...(configuration.leaseTtlMs === undefined
        ? {}
        : { leaseTtlMs: configuration.leaseTtlMs }),
      ...(configuration.renewIntervalMs === undefined
        ? {}
        : { renewIntervalMs: configuration.renewIntervalMs }),
    },
  );
  const productionProvider = launchComposition.liveOrchestration
    ? createProductionOrchestrationProviderFromComposition(launchComposition)
    : undefined;
  const orchestrationFactory = resolveConfiguredOrchestrationProvider(
    process.env,
    productionProvider,
  );
  process.exitCode = await runControllerProcess(configuration, {
    ...(orchestrationFactory === undefined ? {} : { orchestrationFactory }),
    launchComposition,
    ...(configuration.requireLaunchComposition === true
      ? { requirePersistedLaunchComposition: true }
      : {}),
  });
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
