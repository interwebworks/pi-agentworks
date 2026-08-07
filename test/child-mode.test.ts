import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentworks from "../src/extension/index.ts";
import { decodeAgentMessage } from "../src/domain/agent-message-codec.ts";
import {
  ChildBridgeConfigurationError,
  ChildBridgeUnavailableError,
  installChildBridge,
  resolveChildModeConfiguration,
  type ChildModeConfiguration,
} from "../src/extension/child-mode.ts";
import {
  deriveChildAuthToken,
  UnixControllerServer,
} from "../src/infrastructure/controller/unix-controller-transport.ts";

type FakeHandler = (...arguments_: unknown[]) => unknown;

function fakeExtensionApi() {
  const handlers = new Map<string, FakeHandler[]>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const api = {
    on(name: string, handler: FakeHandler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerCommand(name: string, options: unknown) {
      commands.set(name, options);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, commands, tools };
}

async function invoke(
  handlers: ReadonlyMap<string, readonly FakeHandler[]>,
  name: string,
  context: { shutdown(): void } = { shutdown: () => undefined },
): Promise<unknown> {
  let result: unknown;
  for (const handler of handlers.get(name) ?? []) {
    result = await handler({}, context);
  }
  return result;
}

async function invokeEvent(
  handlers: ReadonlyMap<string, readonly FakeHandler[]>,
  name: string,
  event: unknown,
): Promise<void> {
  for (const handler of handlers.get(name) ?? []) {
    await handler(event, {});
  }
}

async function socketFixture(): Promise<{
  readonly root: string;
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly token: string;
  readonly server: Server;
}> {
  const root = mkdtempSync(join(tmpdir(), "agentworks-child-mode-"));
  const socketPath = join(root, "controller.sock");
  const tokenPath = join(root, "child.token");
  const token = "A".repeat(43);
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  chmodSync(socketPath, 0o600);
  return { root, socketPath, tokenPath, token, server };
}

async function closeSocketFixture(
  fixture: Awaited<ReturnType<typeof socketFixture>>,
): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    fixture.server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
  rmSync(fixture.root, { recursive: true, force: true });
}

test("ordinary Pi sessions register the parent surface and session-scoped background visibility", () => {
  assert.equal(resolveChildModeConfiguration({}), null);
  assert.equal(
    resolveChildModeConfiguration({ AGENTWORKS_CHILD_MODE: "0" }),
    null,
  );

  const previous = process.env.AGENTWORKS_CHILD_MODE;
  delete process.env.AGENTWORKS_CHILD_MODE;
  try {
    const fake = fakeExtensionApi();
    agentworks(fake.api);
    assert.deepEqual(
      [...fake.handlers.keys()],
      ["session_start", "session_shutdown"],
    );
    assert.deepEqual([...fake.commands.keys()], ["agentworks"]);
    assert.deepEqual([...fake.tools.keys()], ["agentworks"]);
  } finally {
    if (previous === undefined) delete process.env.AGENTWORKS_CHILD_MODE;
    else process.env.AGENTWORKS_CHILD_MODE = previous;
  }
});

test("invalid exact child mode installs a fail-closed guard instead of remaining inert", async () => {
  const previous = {
    mode: process.env.AGENTWORKS_CHILD_MODE,
    runId: process.env.AGENTWORKS_RUN_ID,
  };
  process.env.AGENTWORKS_CHILD_MODE = "1";
  delete process.env.AGENTWORKS_RUN_ID;
  try {
    const fake = fakeExtensionApi();
    agentworks(fake.api);
    assert.deepEqual(
      [...fake.handlers.keys()],
      ["session_start", "before_agent_start", "tool_call"],
    );
    let shutdowns = 0;
    await invoke(fake.handlers, "session_start", {
      shutdown() {
        shutdowns += 1;
      },
    });
    assert.equal(shutdowns, 1);
    assert.deepEqual(await invoke(fake.handlers, "tool_call"), {
      block: true,
      reason:
        "Agentworks blocked tools because child authentication is unavailable",
    });
  } finally {
    if (previous.mode === undefined) delete process.env.AGENTWORKS_CHILD_MODE;
    else process.env.AGENTWORKS_CHILD_MODE = previous.mode;
    if (previous.runId === undefined) delete process.env.AGENTWORKS_RUN_ID;
    else process.env.AGENTWORKS_RUN_ID = previous.runId;
  }
});

test("exact child mode requires a private capability and real controller socket", async () => {
  const fixture = await socketFixture();
  try {
    const configuration = resolveChildModeConfiguration({
      AGENTWORKS_CHILD_MODE: "1",
      AGENTWORKS_RUN_ID: "run-1",
      AGENTWORKS_AGENT_ID: "agent-1",
      AGENTWORKS_CONTROLLER_SOCKET: fixture.socketPath,
      AGENTWORKS_CONTROLLER_TOKEN_FILE: fixture.tokenPath,
    });
    assert.deepEqual(configuration, {
      runId: "run-1",
      agentId: "agent-1",
      controllerSocketPath: fixture.socketPath,
      controllerAuthToken: fixture.token,
    });

    chmodSync(fixture.tokenPath, 0o640);
    assert.throws(
      () =>
        resolveChildModeConfiguration({
          AGENTWORKS_CHILD_MODE: "1",
          AGENTWORKS_RUN_ID: "run-1",
          AGENTWORKS_AGENT_ID: "agent-1",
          AGENTWORKS_CONTROLLER_SOCKET: fixture.socketPath,
          AGENTWORKS_CONTROLLER_TOKEN_FILE: fixture.tokenPath,
        }),
      ChildBridgeConfigurationError,
    );
  } finally {
    await closeSocketFixture(fixture);
  }
});

test("child bridge authenticates before any model turn and closes on shutdown", async () => {
  const fake = fakeExtensionApi();
  const configuration: ChildModeConfiguration = {
    runId: "run-1",
    agentId: "agent-1",
    controllerSocketPath: "/runtime/controller.sock",
    controllerAuthToken: "A".repeat(43),
  };
  const actions: string[] = [];
  let closes = 0;
  installChildBridge(fake.api, configuration, () => ({
    connect() {
      actions.push("connect");
      return Promise.resolve();
    },
    request(input) {
      actions.push(input.action);
      return Promise.resolve({
        runId: "run-1",
        agentId: "agent-1",
        revision: 7,
        status: "launching",
      });
    },
    close() {
      closes += 1;
    },
  }));

  assert.deepEqual(
    [...fake.handlers.keys()],
    [
      "session_start",
      "before_agent_start",
      "agent_start",
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "agent_settled",
      "tool_call",
      "session_shutdown",
    ],
  );
  await assert.rejects(
    invoke(fake.handlers, "before_agent_start"),
    ChildBridgeUnavailableError,
  );
  await invoke(fake.handlers, "session_start");
  await invoke(fake.handlers, "before_agent_start");
  assert.equal(await invoke(fake.handlers, "tool_call"), undefined);
  await invokeEvent(fake.handlers, "agent_start", {});
  await invokeEvent(fake.handlers, "turn_start", {
    timestamp: Date.now(),
  });
  await invokeEvent(fake.handlers, "tool_execution_start", {
    toolName: "bash",
  });
  await invokeEvent(fake.handlers, "agent_settled", {});
  assert.deepEqual(actions, [
    "connect",
    "child.hello",
    "agent.message",
    "agent.message",
    "agent.message",
    "agent.message",
    "agent.message",
  ]);
  await invoke(fake.handlers, "session_shutdown");
  assert.equal(actions.at(-1), "agent.message");
  assert.equal(closes, 1);
  await assert.rejects(
    invoke(fake.handlers, "before_agent_start"),
    ChildBridgeUnavailableError,
  );
});

test("child bridge re-authenticates after the controller closes an idle connection", async () => {
  const fake = fakeExtensionApi();
  const actions: string[] = [];
  let clientNumber = 0;
  installChildBridge(
    fake.api,
    {
      runId: "run-1",
      agentId: "agent-1",
      controllerSocketPath: "/runtime/controller.sock",
      controllerAuthToken: "A".repeat(43),
    },
    () => {
      clientNumber += 1;
      const currentClient = clientNumber;
      let messageCount = 0;
      return {
        connect() {
          actions.push(`connect:${String(currentClient)}`);
          return Promise.resolve();
        },
        request(input) {
          actions.push(`${input.action}:${String(currentClient)}`);
          if (input.action === "agent.message") {
            messageCount += 1;
            if (currentClient === 1 && messageCount === 3) {
              return Promise.reject(new Error("idle socket closed"));
            }
          }
          return Promise.resolve({
            runId: "run-1",
            agentId: "agent-1",
            revision: 7,
            status: "working",
          });
        },
        close: () => undefined,
      };
    },
  );

  await invoke(fake.handlers, "session_start");
  await invokeEvent(fake.handlers, "agent_start", {});
  await invokeEvent(fake.handlers, "tool_execution_start", {
    toolName: "edit",
  });

  assert.equal(clientNumber, 2);
  assert.equal(await invoke(fake.handlers, "tool_call"), undefined);
  assert.deepEqual(actions.slice(-4), [
    "agent.message:1",
    "connect:2",
    "child.hello:2",
    "agent.message:2",
  ]);
});

test("child operation errors emit blocker and failed-result messages", async () => {
  const fake = fakeExtensionApi();
  const messages: ReturnType<typeof decodeAgentMessage>[] = [];
  installChildBridge(
    fake.api,
    {
      runId: "run-1",
      agentId: "agent-1",
      controllerSocketPath: "/runtime/controller.sock",
      controllerAuthToken: "A".repeat(43),
    },
    () => ({
      connect: () => Promise.resolve(),
      request(input) {
        if (input.action === "agent.message") {
          messages.push(decodeAgentMessage(JSON.stringify(input.payload)));
        }
        return Promise.resolve({
          runId: "run-1",
          agentId: "agent-1",
          revision: 7,
          status: "launching",
        });
      },
      close: () => undefined,
    }),
  );

  await invoke(fake.handlers, "session_start");
  await invokeEvent(fake.handlers, "agent_start", {});
  await invokeEvent(fake.handlers, "tool_execution_end", {
    toolName: "bash",
    isError: true,
  });
  await invokeEvent(fake.handlers, "agent_settled", {});

  assert.deepEqual(
    messages.map((message) => message.type),
    [
      "session-started",
      "operation-started",
      "agent-blocked",
      "operation-completed",
    ],
  );
  const completed = messages.find(
    (message) => message.type === "operation-completed",
  );
  assert.ok(completed);
  assert.equal(completed.success, false);
});

test("default bridge performs a real per-agent authenticated socket hello", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-child-hello-"));
  const socketPath = join(root, "controller.sock");
  const controllerToken = "controller-secret-".repeat(4);
  const childToken = deriveChildAuthToken(controllerToken, "run-1", "agent-1");
  const handled: string[] = [];
  const server = new UnixControllerServer({
    socketPath,
    runId: "run-1",
    authToken: controllerToken,
    authorizeIdentity(request) {
      return request.agentId === "agent-1";
    },
    handleRequest(request) {
      handled.push(request.action);
      return {
        runId: "run-1",
        agentId: "agent-1",
        revision: 9,
        status: "launching",
      };
    },
  });
  try {
    await server.listen();
    const fake = fakeExtensionApi();
    installChildBridge(fake.api, {
      runId: "run-1",
      agentId: "agent-1",
      controllerSocketPath: socketPath,
      controllerAuthToken: childToken,
    });
    await invoke(fake.handlers, "session_start");
    await invoke(fake.handlers, "before_agent_start");
    assert.deepEqual(handled, ["child.hello", "agent.message"]);
    await invoke(fake.handlers, "session_shutdown");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid controller identity evidence keeps child turns blocked", async () => {
  const fake = fakeExtensionApi();
  const configuration: ChildModeConfiguration = {
    runId: "run-1",
    agentId: "agent-1",
    controllerSocketPath: "/runtime/controller.sock",
    controllerAuthToken: "A".repeat(43),
  };
  let closed = false;
  installChildBridge(fake.api, configuration, () => ({
    connect: () => Promise.resolve(),
    request: () =>
      Promise.resolve({
        runId: "other-run",
        agentId: "agent-1",
        revision: 7,
        status: "launching",
      }),
    close() {
      closed = true;
    },
  }));

  let shutdowns = 0;
  await assert.rejects(
    invoke(fake.handlers, "session_start", {
      shutdown() {
        shutdowns += 1;
      },
    }),
    /invalid child identity evidence/u,
  );
  assert.equal(shutdowns, 1);
  assert.equal(closed, true);
  await assert.rejects(
    invoke(fake.handlers, "before_agent_start"),
    ChildBridgeUnavailableError,
  );
});
