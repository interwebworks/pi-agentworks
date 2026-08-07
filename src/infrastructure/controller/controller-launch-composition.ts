import { createHmac, timingSafeEqual, type BinaryLike } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type { ParentLaunchRuntime } from "../../application/ports/parent-management.ts";
import type { JsonValue } from "../../application/ports/controller-repository.ts";
import {
  DEFAULT_CONTROLLER_LEASE_TTL_MS,
  DEFAULT_CONTROLLER_RENEW_INTERVAL_MS,
} from "./controller-runtime.ts";

export const CONTROLLER_LAUNCH_COMPOSITION_SCHEMA_VERSION = 1 as const;
const AUTHENTICATION_CONTEXT =
  "pi-agentworks/controller-launch-composition/v1\0";
const AUTHENTICATION_TAG_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ControllerLaunchThinking = ParentLaunchRuntime["thinking"];

/**
 * Immutable, credential-free evidence required to reconstruct the controller's
 * original production composition after its parent process has disappeared.
 */
export interface ControllerLaunchComposition {
  readonly schemaVersion: typeof CONTROLLER_LAUNCH_COMPOSITION_SCHEMA_VERSION;
  readonly runId: string;
  readonly liveOrchestration: boolean;
  readonly leaseTtlMs: number;
  readonly renewIntervalMs: number;
  readonly workspaceId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking: ControllerLaunchThinking | null;
  readonly allowHostNetwork: boolean | null;
  readonly herdrPath: string | null;
  readonly piCliPath: string | null;
  readonly piPackagePath: string | null;
  readonly agentworksPackagePath: string;
  readonly controllerEntryPath: string;
  readonly childBridgePath: string;
  readonly nodePath: string;
  readonly homePath: string;
}

export interface AuthenticatedControllerLaunchComposition {
  readonly composition: ControllerLaunchComposition;
  readonly serialized: string;
  readonly authenticationTag: string;
}

export interface ControllerLaunchCompositionEnvironment {
  readonly AGENTWORKS_ENABLE_LIVE_ORCHESTRATION?: string;
  readonly AGENTWORKS_WORKSPACE_ID?: string;
  readonly HERDR_WORKSPACE_ID?: string;
  readonly AGENTWORKS_HERDR_PATH?: string;
  readonly AGENTWORKS_PI_CLI_PATH?: string;
  readonly AGENTWORKS_PI_PACKAGE_PATH?: string;
  readonly PI_PROVIDER?: string;
  readonly PI_MODEL?: string;
  readonly PI_REASONING_LEVEL?: string;
  readonly AGENTWORKS_ALLOW_HOST_NETWORK?: string;
  readonly HOME?: string;
}

export class ControllerLaunchCompositionError extends Error {
  constructor(message: string) {
    super(`Controller launch composition failed: ${message}`);
    this.name = "ControllerLaunchCompositionError";
  }
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    throw new ControllerLaunchCompositionError(`${label} is required`);
  }
  return normalized;
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new ControllerLaunchCompositionError(`${label} is invalid`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ControllerLaunchCompositionError(
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function canonicalPath(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw new ControllerLaunchCompositionError(`${label} must be absolute`);
  }
  try {
    return realpathSync(resolve(value));
  } catch (error) {
    throw new ControllerLaunchCompositionError(
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveExecutable(value: string, label: string): string {
  const candidate = value.trim();
  if (candidate.length === 0) {
    throw new ControllerLaunchCompositionError(`${label} is empty`);
  }
  if (candidate.includes("/")) {
    return canonicalPath(resolve(candidate), label);
  }
  try {
    const path = execFileSync("which", [candidate], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (path.length === 0) throw new Error("which returned no path");
    return canonicalPath(path, label);
  } catch (error) {
    throw new ControllerLaunchCompositionError(
      `${label} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function packageRootFromExecutable(path: string): string {
  let current = resolve(path, "..");
  for (;;) {
    if (existsSync(join(current, "package.json"))) return realpathSync(current);
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  throw new ControllerLaunchCompositionError(
    `Pi package root cannot be found for ${path}`,
  );
}

function parseThinking(value: string | undefined): ControllerLaunchThinking {
  const selected = value ?? "high";
  if (!THINKING_LEVELS.has(selected)) {
    throw new ControllerLaunchCompositionError(
      `PI_REASONING_LEVEL is invalid: ${selected}`,
    );
  }
  return selected as ControllerLaunchThinking;
}

function parseHostNetwork(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value !== "1") {
    throw new ControllerLaunchCompositionError(
      "AGENTWORKS_ALLOW_HOST_NETWORK must be exactly 0 or 1",
    );
  }
  return true;
}

function canonicalObject(
  composition: ControllerLaunchComposition,
): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    schemaVersion: composition.schemaVersion,
    runId: composition.runId,
    liveOrchestration: composition.liveOrchestration,
    leaseTtlMs: composition.leaseTtlMs,
    renewIntervalMs: composition.renewIntervalMs,
    workspaceId: composition.workspaceId,
    provider: composition.provider,
    model: composition.model,
    thinking: composition.thinking,
    allowHostNetwork: composition.allowHostNetwork,
    herdrPath: composition.herdrPath,
    piCliPath: composition.piCliPath,
    piPackagePath: composition.piPackagePath,
    agentworksPackagePath: composition.agentworksPackagePath,
    controllerEntryPath: composition.controllerEntryPath,
    childBridgePath: composition.childBridgePath,
    nodePath: composition.nodePath,
    homePath: composition.homePath,
  });
}

export function serializeControllerLaunchComposition(
  composition: ControllerLaunchComposition,
): string {
  assertControllerLaunchComposition(composition);
  return JSON.stringify(canonicalObject(composition));
}

function hmac(key: BinaryLike, serialized: string): string {
  return createHmac("sha256", key)
    .update(AUTHENTICATION_CONTEXT)
    .update(serialized)
    .digest("hex");
}

export function authenticateControllerLaunchComposition(
  composition: ControllerLaunchComposition,
  authToken: string,
): AuthenticatedControllerLaunchComposition {
  const token = required(authToken, "controller authentication token");
  const serialized = serializeControllerLaunchComposition(composition);
  return Object.freeze({
    composition,
    serialized,
    authenticationTag: hmac(token, serialized),
  });
}

function parseSerializedComposition(
  serialized: string,
): ControllerLaunchComposition {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new ControllerLaunchCompositionError(
      "persisted composition contains invalid JSON",
    );
  }
  assertControllerLaunchComposition(value);
  const composition = Object.freeze(value);
  if (serializeControllerLaunchComposition(composition) !== serialized) {
    throw new ControllerLaunchCompositionError(
      "persisted composition is not canonically serialized",
    );
  }
  return composition;
}

export function verifyControllerLaunchComposition(
  serialized: string,
  authenticationTag: string,
  authToken: string,
): ControllerLaunchComposition {
  if (!AUTHENTICATION_TAG_PATTERN.test(authenticationTag)) {
    throw new ControllerLaunchCompositionError(
      "persisted composition authentication tag is invalid",
    );
  }
  const token = required(authToken, "controller authentication token");
  const expected = Buffer.from(hmac(token, serialized), "hex");
  const actual = Buffer.from(authenticationTag, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ControllerLaunchCompositionError(
      "persisted composition authentication failed",
    );
  }
  return parseSerializedComposition(serialized);
}

export function assertControllerLaunchComposition(
  value: unknown,
): asserts value is ControllerLaunchComposition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ControllerLaunchCompositionError("composition must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const expectedKeys = Object.keys(
    canonicalObject({
      schemaVersion: CONTROLLER_LAUNCH_COMPOSITION_SCHEMA_VERSION,
      runId: "run",
      liveOrchestration: false,
      leaseTtlMs: 1,
      renewIntervalMs: 1,
      workspaceId: null,
      provider: null,
      model: null,
      thinking: null,
      allowHostNetwork: null,
      herdrPath: null,
      piCliPath: null,
      piPackagePath: null,
      agentworksPackagePath: "/agentworks",
      controllerEntryPath: "/agentworks/controller",
      childBridgePath: "/agentworks/child",
      nodePath: "/node",
      homePath: "/home",
    }),
  );
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new ControllerLaunchCompositionError(
      "composition fields are incomplete or unexpected",
    );
  }
  if (record.schemaVersion !== CONTROLLER_LAUNCH_COMPOSITION_SCHEMA_VERSION) {
    throw new ControllerLaunchCompositionError(
      "composition schema version is unsupported",
    );
  }
  if (typeof record.runId !== "string") {
    throw new ControllerLaunchCompositionError("run id is invalid");
  }
  safeId(record.runId, "run id");
  if (typeof record.liveOrchestration !== "boolean") {
    throw new ControllerLaunchCompositionError(
      "live orchestration marker is invalid",
    );
  }
  if (
    typeof record.leaseTtlMs !== "number" ||
    typeof record.renewIntervalMs !== "number"
  ) {
    throw new ControllerLaunchCompositionError("lease policy is invalid");
  }
  positiveSafeInteger(record.leaseTtlMs, "lease ttl");
  positiveSafeInteger(record.renewIntervalMs, "renew interval");
  if (record.renewIntervalMs >= record.leaseTtlMs) {
    throw new ControllerLaunchCompositionError(
      "renew interval must be shorter than lease ttl",
    );
  }
  for (const [key, label] of [
    ["agentworksPackagePath", "Agentworks package path"],
    ["controllerEntryPath", "controller entry path"],
    ["childBridgePath", "child bridge path"],
    ["nodePath", "Node path"],
    ["homePath", "home path"],
  ] as const) {
    const path = record[key];
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4_096) {
      throw new ControllerLaunchCompositionError(`${label} is invalid`);
    }
  }
  const nullableFields = [
    "workspaceId",
    "provider",
    "model",
    "thinking",
    "allowHostNetwork",
    "herdrPath",
    "piCliPath",
    "piPackagePath",
  ] as const;
  if (!record.liveOrchestration) {
    if (nullableFields.some((field) => record[field] !== null)) {
      throw new ControllerLaunchCompositionError(
        "dormant composition contains live orchestration fields",
      );
    }
    return;
  }
  if (
    typeof record.workspaceId !== "string" ||
    typeof record.provider !== "string" ||
    typeof record.model !== "string" ||
    typeof record.thinking !== "string" ||
    typeof record.allowHostNetwork !== "boolean" ||
    typeof record.herdrPath !== "string" ||
    typeof record.piCliPath !== "string" ||
    typeof record.piPackagePath !== "string"
  ) {
    throw new ControllerLaunchCompositionError(
      "live composition fields are incomplete",
    );
  }
  safeId(record.workspaceId, "workspace id");
  safeId(record.provider, "provider");
  safeId(record.model, "model");
  if (!THINKING_LEVELS.has(record.thinking)) {
    throw new ControllerLaunchCompositionError("thinking level is invalid");
  }
  for (const [path, label] of [
    [record.herdrPath, "Herdr path"],
    [record.piCliPath, "Pi CLI path"],
    [record.piPackagePath, "Pi package path"],
  ] as const) {
    if (!isAbsolute(path) || path.length > 4_096) {
      throw new ControllerLaunchCompositionError(`${label} is invalid`);
    }
  }
}

export function createControllerLaunchComposition(
  runId: string,
  environment: ControllerLaunchCompositionEnvironment,
  packageRoot: string,
  leasePolicy: {
    readonly leaseTtlMs?: number;
    readonly renewIntervalMs?: number;
  } = {},
): ControllerLaunchComposition {
  const normalizedRunId = safeId(runId, "run id");
  const leaseTtlMs = positiveSafeInteger(
    leasePolicy.leaseTtlMs ?? DEFAULT_CONTROLLER_LEASE_TTL_MS,
    "lease ttl",
  );
  const renewIntervalMs = positiveSafeInteger(
    leasePolicy.renewIntervalMs ?? DEFAULT_CONTROLLER_RENEW_INTERVAL_MS,
    "renew interval",
  );
  if (renewIntervalMs >= leaseTtlMs) {
    throw new ControllerLaunchCompositionError(
      "renew interval must be shorter than lease ttl",
    );
  }
  const agentworksPackagePath = canonicalPath(
    resolve(packageRoot),
    "Agentworks package path",
  );
  const shared = {
    schemaVersion: CONTROLLER_LAUNCH_COMPOSITION_SCHEMA_VERSION,
    runId: normalizedRunId,
    leaseTtlMs,
    renewIntervalMs,
    agentworksPackagePath,
    controllerEntryPath: canonicalPath(
      join(agentworksPackagePath, "src", "controller", "process-entry.ts"),
      "controller entry path",
    ),
    childBridgePath: canonicalPath(
      join(agentworksPackagePath, "src", "extension", "child-mode.ts"),
      "child bridge path",
    ),
    nodePath: canonicalPath(process.execPath, "Node path"),
    homePath: canonicalPath(
      environment.HOME ?? homedir(),
      "controller home path",
    ),
  } as const;
  const marker = environment.AGENTWORKS_ENABLE_LIVE_ORCHESTRATION;
  if (marker === undefined) {
    return Object.freeze({
      ...shared,
      liveOrchestration: false,
      workspaceId: null,
      provider: null,
      model: null,
      thinking: null,
      allowHostNetwork: null,
      herdrPath: null,
      piCliPath: null,
      piPackagePath: null,
    });
  }
  if (marker !== "1") {
    throw new ControllerLaunchCompositionError(
      "AGENTWORKS_ENABLE_LIVE_ORCHESTRATION must be exactly 1",
    );
  }
  const piCliPath = resolveExecutable(
    environment.AGENTWORKS_PI_CLI_PATH ?? "pi",
    "Pi CLI path",
  );
  return Object.freeze({
    ...shared,
    liveOrchestration: true,
    workspaceId: safeId(
      required(
        environment.AGENTWORKS_WORKSPACE_ID ?? environment.HERDR_WORKSPACE_ID,
        "Herdr workspace id",
      ),
      "workspace id",
    ),
    provider: safeId(required(environment.PI_PROVIDER, "provider"), "provider"),
    model: safeId(required(environment.PI_MODEL, "model"), "model"),
    thinking: parseThinking(environment.PI_REASONING_LEVEL),
    allowHostNetwork: parseHostNetwork(
      environment.AGENTWORKS_ALLOW_HOST_NETWORK,
    ),
    herdrPath: resolveExecutable(
      environment.AGENTWORKS_HERDR_PATH ?? "herdr",
      "Herdr path",
    ),
    piCliPath,
    piPackagePath:
      environment.AGENTWORKS_PI_PACKAGE_PATH === undefined
        ? packageRootFromExecutable(piCliPath)
        : canonicalPath(
            resolve(environment.AGENTWORKS_PI_PACKAGE_PATH),
            "Pi package path",
          ),
  });
}

export function environmentFromControllerLaunchComposition(
  composition: ControllerLaunchComposition,
): Readonly<Record<string, string>> {
  assertControllerLaunchComposition(composition);
  const base = {
    HOME: composition.homePath,
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  if (!composition.liveOrchestration) return Object.freeze(base);
  return Object.freeze({
    ...base,
    AGENTWORKS_ENABLE_LIVE_ORCHESTRATION: "1",
    AGENTWORKS_WORKSPACE_ID: composition.workspaceId ?? "",
    AGENTWORKS_HERDR_PATH: composition.herdrPath ?? "",
    AGENTWORKS_PI_CLI_PATH: composition.piCliPath ?? "",
    AGENTWORKS_PI_PACKAGE_PATH: composition.piPackagePath ?? "",
    PI_PROVIDER: composition.provider ?? "",
    PI_MODEL: composition.model ?? "",
    PI_REASONING_LEVEL: composition.thinking ?? "",
    AGENTWORKS_ALLOW_HOST_NETWORK:
      composition.allowHostNetwork === true ? "1" : "0",
  });
}

export function assertCallerRuntimeMatchesComposition(
  runtime: ParentLaunchRuntime | undefined,
  composition: ControllerLaunchComposition,
): void {
  if (runtime === undefined || !composition.liveOrchestration) return;
  const drift: string[] = [];
  if (runtime.workspaceId !== composition.workspaceId) drift.push("workspace");
  if (runtime.provider !== composition.provider) drift.push("provider");
  if (runtime.model !== composition.model) drift.push("model");
  if (runtime.thinking !== composition.thinking) drift.push("thinking");
  if (runtime.allowHostNetwork !== composition.allowHostNetwork) {
    drift.push("network policy");
  }
  if (drift.length > 0) {
    throw new ControllerLaunchCompositionError(
      `status caller drifted from immutable ${drift.join(", ")} evidence`,
    );
  }
}

export function sameControllerLaunchComposition(
  left: ControllerLaunchComposition,
  right: ControllerLaunchComposition,
): boolean {
  return (
    serializeControllerLaunchComposition(left) ===
    serializeControllerLaunchComposition(right)
  );
}
