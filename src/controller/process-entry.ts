import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ControllerEventCursor,
  JsonValue,
} from "../application/ports/controller-repository.ts";
import {
  ControllerRuntime,
  ControllerRuntimeError,
} from "../infrastructure/controller/controller-runtime.ts";
import { ControllerRequestError } from "../infrastructure/controller/unix-controller-transport.ts";

interface ControllerProcessConfiguration {
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

export async function runControllerProcess(
  configuration: ControllerProcessConfiguration,
): Promise<number> {
  let stopping = false;
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
      if (request.agentId === null || request.clientId !== request.agentId)
        return false;
      const snapshot = runtime.repository.loadSnapshot(configuration.runId);
      return (
        snapshot?.agents.some((agent) => agent.id === request.agentId) ?? false
      );
    },
    handleRequest(request) {
      if (request.clientKind === "child") {
        throw new ControllerRequestError(
          "forbidden",
          "Child clients cannot use controller administration actions",
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
  process.exitCode = await runControllerProcess(configuration);
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
