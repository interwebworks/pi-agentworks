import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../application/ports/controller-repository.ts";
import {
  heartbeat,
  operationCompleted,
  operationProgress,
  operationStarted,
  sessionShutdown,
  sessionStarted,
  type AgentMessage,
} from "../domain/agent-communication.ts";
import { encodeAgentMessage } from "../domain/agent-message-codec.ts";
import {
  UnixControllerClient,
  type ControllerClientRequest,
} from "../infrastructure/controller/unix-controller-transport.ts";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CHILD_AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface ChildModeEnvironment {
  readonly AGENTWORKS_CHILD_MODE?: string;
  readonly AGENTWORKS_AGENT_ID?: string;
  readonly AGENTWORKS_CONTROLLER_SOCKET?: string;
  readonly AGENTWORKS_CONTROLLER_TOKEN_FILE?: string;
  readonly AGENTWORKS_RUN_ID?: string;
}

export interface ChildModeConfiguration {
  readonly runId: string;
  readonly agentId: string;
  readonly controllerSocketPath: string;
  readonly controllerAuthToken: string;
}

interface ChildControllerClient {
  connect(): Promise<void>;
  request(input: ControllerClientRequest): Promise<JsonValue>;
  close(): void;
}

type ChildControllerClientFactory = (
  configuration: ChildModeConfiguration,
) => ChildControllerClient;

export class ChildBridgeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildBridgeConfigurationError";
  }
}

export class ChildBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildBridgeUnavailableError";
  }
}

function requiredIdentifier(value: string | undefined, label: string): string {
  if (value === undefined || !IDENTIFIER_PATTERN.test(value)) {
    throw new ChildBridgeConfigurationError(`${label} is missing or invalid`);
  }
  return value;
}

function assertPrivateOwned(status: Stats, label: string): void {
  if (status.uid !== process.getuid?.()) {
    throw new ChildBridgeConfigurationError(
      `${label} must be owned by the child process user`,
    );
  }
  if ((status.mode & 0o077) !== 0) {
    throw new ChildBridgeConfigurationError(
      `${label} must not allow group or world access`,
    );
  }
}

function readControllerCapability(path: string): string {
  if (!isAbsolute(path)) {
    throw new ChildBridgeConfigurationError(
      "Controller capability path must be absolute",
    );
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      resolve(path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size < 43 || status.size > 44) {
      throw new ChildBridgeConfigurationError(
        "Controller capability must be a bounded regular file",
      );
    }
    assertPrivateOwned(status, "Controller capability");
    const content = readFileSync(descriptor, "utf8");
    const token = content.endsWith("\n") ? content.slice(0, -1) : content;
    if (!CHILD_AUTH_TOKEN_PATTERN.test(token)) {
      throw new ChildBridgeConfigurationError(
        "Controller capability content is invalid",
      );
    }
    return token;
  } catch (error) {
    if (error instanceof ChildBridgeConfigurationError) throw error;
    throw new ChildBridgeConfigurationError(
      `Controller capability is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function validateControllerSocket(path: string): string {
  if (!isAbsolute(path)) {
    throw new ChildBridgeConfigurationError(
      "Controller socket path must be absolute",
    );
  }
  const canonical = resolve(path);
  try {
    const status = lstatSync(canonical);
    if (status.isSymbolicLink() || !status.isSocket()) {
      throw new ChildBridgeConfigurationError(
        "Controller socket must be a real Unix socket",
      );
    }
    assertPrivateOwned(status, "Controller socket");
  } catch (error) {
    if (error instanceof ChildBridgeConfigurationError) throw error;
    throw new ChildBridgeConfigurationError(
      `Controller socket is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return canonical;
}

export function resolveChildModeConfiguration(
  environment: ChildModeEnvironment,
): ChildModeConfiguration | null {
  if (environment.AGENTWORKS_CHILD_MODE !== "1") return null;
  const runId = requiredIdentifier(environment.AGENTWORKS_RUN_ID, "Run id");
  const agentId = requiredIdentifier(
    environment.AGENTWORKS_AGENT_ID,
    "Agent id",
  );
  const controllerSocketPath = validateControllerSocket(
    environment.AGENTWORKS_CONTROLLER_SOCKET ?? "",
  );
  const tokenFile = environment.AGENTWORKS_CONTROLLER_TOKEN_FILE;
  if (tokenFile === undefined) {
    throw new ChildBridgeConfigurationError(
      "Controller capability path is missing",
    );
  }
  return Object.freeze({
    runId,
    agentId,
    controllerSocketPath,
    controllerAuthToken: readControllerCapability(tokenFile),
  });
}

function defaultClientFactory(
  configuration: ChildModeConfiguration,
): ChildControllerClient {
  return new UnixControllerClient({
    socketPath: configuration.controllerSocketPath,
    runId: configuration.runId,
    authToken: configuration.controllerAuthToken,
    clientId: randomUUID(),
    clientKind: "child",
    agentId: configuration.agentId,
  });
}

function assertHelloResponse(
  value: JsonValue,
  configuration: ChildModeConfiguration,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChildBridgeUnavailableError(
      "Controller returned invalid child identity evidence",
    );
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  if (
    Object.keys(record).length !== 4 ||
    record.runId !== configuration.runId ||
    record.agentId !== configuration.agentId ||
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    typeof record.status !== "string"
  ) {
    throw new ChildBridgeUnavailableError(
      "Controller returned invalid child identity evidence",
    );
  }
}

export function installChildLockdown(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => {
    context.shutdown();
  });
  pi.on("before_agent_start", (_event, context) => {
    context.shutdown();
  });
  pi.on("tool_call", () => ({
    block: true,
    reason:
      "Agentworks blocked tools because child authentication is unavailable",
  }));
}

export function installChildBridge(
  pi: ExtensionAPI,
  configuration: ChildModeConfiguration,
  clientFactory: ChildControllerClientFactory = defaultClientFactory,
): void {
  let client: ChildControllerClient | null = null;
  let authenticated = false;
  let sessionId: string | null = null;
  let operationStartedAt: number | null = null;

  const sendMessage = async (
    nextClient: ChildControllerClient,
    message: AgentMessage,
  ): Promise<void> => {
    const payload = JSON.parse(encodeAgentMessage(message)) as JsonValue;
    await nextClient.request({ action: "agent.message", payload });
  };

  const reportMessage = async (message: AgentMessage): Promise<void> => {
    const activeClient = client;
    if (!authenticated || activeClient === null) return;
    try {
      await sendMessage(activeClient, message);
    } catch {
      authenticated = false;
      client = null;
      activeClient.close();
    }
  };

  pi.on("session_start", async (_event, context) => {
    operationStartedAt = null;
    authenticated = false;
    sessionId = randomUUID();
    client?.close();
    const nextClient = clientFactory(configuration);
    client = nextClient;
    try {
      await nextClient.connect();
      const response = await nextClient.request({
        action: "child.hello",
        payload: {},
      });
      assertHelloResponse(response, configuration);
      const contextWithSession = context as unknown as {
        sessionManager?: { getSessionFile?: () => string };
      };
      let piSessionPath: string | null = null;
      if (
        contextWithSession.sessionManager !== undefined &&
        typeof contextWithSession.sessionManager.getSessionFile === "function"
      ) {
        piSessionPath = contextWithSession.sessionManager.getSessionFile();
      }
      await sendMessage(
        nextClient,
        sessionStarted(
          configuration.runId,
          configuration.agentId,
          sessionId,
          piSessionPath,
        ),
      );
      authenticated = true;
    } catch (error) {
      nextClient.close();
      if (client === nextClient) client = null;
      context.shutdown();
      throw new ChildBridgeUnavailableError(
        `Agentworks child authentication failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  pi.on("before_agent_start", (_event, context) => {
    if (!authenticated) {
      context.shutdown();
      throw new ChildBridgeUnavailableError(
        "Agentworks refused an unauthenticated child agent turn",
      );
    }
  });

  pi.on("agent_start", () => {
    operationStartedAt = Date.now();
    void reportMessage(
      operationStarted(configuration.runId, configuration.agentId),
    );
  });

  pi.on("turn_start", (event) => {
    const startedAt = operationStartedAt ?? event.timestamp;
    void reportMessage(
      heartbeat(
        configuration.runId,
        configuration.agentId,
        Math.max(0, event.timestamp - startedAt),
      ),
    );
  });

  pi.on("tool_execution_start", (event) => {
    void reportMessage(
      operationProgress(
        configuration.runId,
        configuration.agentId,
        `tool:${event.toolName}`,
      ),
    );
  });

  pi.on("agent_settled", () => {
    void reportMessage(
      operationCompleted(configuration.runId, configuration.agentId, true),
    );
    operationStartedAt = null;
  });

  pi.on("tool_call", () =>
    authenticated
      ? undefined
      : {
          block: true,
          reason:
            "Agentworks blocked tools because child authentication is unavailable",
        },
  );

  pi.on("session_shutdown", async () => {
    authenticated = false;
    operationStartedAt = null;
    const closingClient = client;
    const closingSessionId = sessionId;
    sessionId = null;
    client = null;
    if (closingClient !== null && closingSessionId !== null) {
      try {
        await sendMessage(
          closingClient,
          sessionShutdown(
            configuration.runId,
            configuration.agentId,
            closingSessionId,
          ),
        );
      } catch {
        // The controller may already be gone during shutdown.
      }
      closingClient.close();
    }
  });
}
