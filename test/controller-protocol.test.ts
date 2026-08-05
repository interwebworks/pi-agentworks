import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import test from "node:test";
import {
  CONTROLLER_PROTOCOL_VERSION,
  ControllerFrameDecoder,
  ControllerFrameError,
  encodeControllerFrame,
  InvalidControllerProtocolMessageError,
  parseControllerRequest,
  parseControllerResponse,
  type ControllerRequest,
  type ControllerResponse,
} from "../src/application/protocol/controller-protocol.ts";
import {
  ControllerRemoteError,
  ControllerRequestError,
  ControllerTransportError,
  deriveChildAuthToken,
  UnixControllerClient,
  UnixControllerServer,
} from "../src/infrastructure/controller/unix-controller-transport.ts";

const AUTH_TOKEN =
  "agentworks-test-token-0123456789-abcdefghijklmnopqrstuvwxyz";

function request(
  overrides: Partial<ControllerRequest> = {},
): ControllerRequest {
  return {
    protocolVersion: CONTROLLER_PROTOCOL_VERSION,
    kind: "request",
    requestId: "request-1",
    runId: "run-1",
    clientId: "client-1",
    clientKind: "parent",
    agentId: null,
    sequence: 1,
    authToken: AUTH_TOKEN,
    action: "snapshot.get",
    expectedRevision: null,
    idempotencyKey: null,
    payload: {},
    ...overrides,
  };
}

function createServerFixture(
  options: {
    readonly maxFrameBytes?: number;
    readonly maxQueuedFrames?: number;
  } = {},
): {
  readonly directory: string;
  readonly socketPath: string;
  readonly handled: ControllerRequest[];
  readonly server: UnixControllerServer;
} {
  const directory = mkdtempSync(join(tmpdir(), "agentworks-protocol-"));
  const socketPath = join(directory, "runtime", "controller.sock");
  const handled: ControllerRequest[] = [];
  const server = new UnixControllerServer({
    socketPath,
    runId: "run-1",
    authToken: AUTH_TOKEN,
    ...(options.maxFrameBytes === undefined
      ? {}
      : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.maxQueuedFrames === undefined
      ? {}
      : { maxQueuedFrames: options.maxQueuedFrames }),
    authorizeIdentity(message) {
      return message.clientKind !== "child" || message.agentId === "agent-1";
    },
    handleRequest(message) {
      handled.push(message);
      if (message.action === "test.failure") {
        throw new ControllerRequestError("test-failure", "Expected failure");
      }
      if (message.action === "test.internal") {
        throw new Error("secret implementation detail");
      }
      return {
        action: message.action,
        sequence: message.sequence,
        agentId: message.agentId,
      };
    },
  });
  return { directory, socketPath, handled, server };
}

async function rawRequest(
  socketPath: string,
  message: ControllerRequest,
  splitAt?: number,
): Promise<ControllerResponse> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });

  const response = new Promise<ControllerResponse>(
    (resolveResponse, rejectResponse) => {
      const decoder = new ControllerFrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        try {
          const values = decoder.push(chunk);
          const value = values[0];
          if (value !== undefined)
            resolveResponse(parseControllerResponse(value));
        } catch (error) {
          rejectResponse(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      socket.once("error", rejectResponse);
      socket.once("close", () => {
        // A response may intentionally close the connection after it is written.
      });
    },
  );

  const frame = encodeControllerFrame(message);
  if (splitAt === undefined) {
    socket.write(frame);
  } else {
    socket.write(frame.subarray(0, splitAt));
    socket.write(frame.subarray(splitAt));
  }
  const value = await response;
  socket.destroy();
  return value;
}

test("request parsing rejects unknown versions, fields, identities, and deep payloads", () => {
  assert.throws(
    () => parseControllerRequest({ ...request(), protocolVersion: 2 }),
    InvalidControllerProtocolMessageError,
  );
  assert.throws(
    () => parseControllerRequest({ ...request(), unexpected: true }),
    InvalidControllerProtocolMessageError,
  );
  assert.throws(
    () =>
      parseControllerRequest({
        ...request(),
        clientKind: "child",
        agentId: null,
      }),
    /child clients require an agentId/u,
  );
  assert.throws(
    () =>
      parseControllerRequest({
        ...request(),
        clientKind: "child",
        clientId: "not-a-uuid",
        agentId: "agent-1",
      }),
    /unique UUID connection identity/u,
  );
  assert.throws(
    () => parseControllerRequest({ ...request(), agentId: "agent-1" }),
    /parent and management clients cannot claim an agentId/u,
  );

  let payload: unknown = "leaf";
  for (let index = 0; index < 34; index += 1) payload = { child: payload };
  assert.throws(
    () => parseControllerRequest({ ...request(), payload }),
    /exceeds depth/u,
  );
});

test("length-prefixed framing handles fragmentation and multiple frames", () => {
  const decoder = new ControllerFrameDecoder(1_024, 4);
  const first = encodeControllerFrame({ value: 1 }, 1_024);
  const second = encodeControllerFrame({ value: 2 }, 1_024);

  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.equal(decoder.bufferedBytes, 3);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    { value: 1 },
    { value: 2 },
  ]);
  assert.equal(decoder.bufferedBytes, 0);
});

test("framing rejects oversized, invalid, and over-queued input", () => {
  assert.throws(
    () => encodeControllerFrame({ payload: "x".repeat(100) }, 20),
    ControllerFrameError,
  );

  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(101, 0);
  assert.throws(
    () => new ControllerFrameDecoder(100).push(oversizedHeader),
    /Announced protocol frame length/u,
  );

  const invalidJson = Buffer.concat([
    Buffer.from([0, 0, 0, 1]),
    Buffer.from("{"),
  ]);
  assert.throws(
    () => new ControllerFrameDecoder(100).push(invalidJson),
    /invalid JSON/u,
  );

  const decoder = new ControllerFrameDecoder(100, 2);
  const frame = encodeControllerFrame({}, 100);
  assert.throws(
    () => decoder.push(Buffer.concat([frame, frame, frame])),
    /queued frame limit/u,
  );
});

test("server and client exchange authenticated bounded requests on a private socket", async () => {
  const fixture = createServerFixture();
  try {
    await fixture.server.listen();
    assert.equal(
      statSync(join(fixture.directory, "runtime")).mode & 0o777,
      0o700,
    );
    assert.equal(statSync(fixture.socketPath).mode & 0o777, 0o600);

    const client = new UnixControllerClient({
      socketPath: fixture.socketPath,
      runId: "run-1",
      authToken: AUTH_TOKEN,
      clientId: "parent-1",
      clientKind: "parent",
      agentId: null,
    });
    await client.connect();
    const response = await client.request({
      action: "snapshot.get",
      payload: { includeAgents: true },
    });
    assert.deepEqual(response, {
      action: "snapshot.get",
      sequence: 1,
      agentId: null,
    });
    assert.equal(fixture.handled.length, 1);
    assert.equal(fixture.handled[0]?.authToken, AUTH_TOKEN);
    client.close();
  } finally {
    await fixture.server.close();
    assert.equal(existsSync(fixture.socketPath), false);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("fragmented requests are authenticated and decoded before handling", async () => {
  const fixture = createServerFixture();
  try {
    await fixture.server.listen();
    const response = await rawRequest(fixture.socketPath, request(), 2);
    assert.equal(response.ok, true);
    assert.equal(fixture.handled.length, 1);
  } finally {
    await fixture.server.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("child capabilities bind unambiguous run and agent tuples", () => {
  assert.notEqual(
    deriveChildAuthToken(AUTH_TOKEN, "a\u0000b", "c"),
    deriveChildAuthToken(AUTH_TOKEN, "a", "b\u0000c"),
  );
  assert.notEqual(
    deriveChildAuthToken(AUTH_TOKEN, "run-1", "agent-1"),
    deriveChildAuthToken(AUTH_TOKEN, "run-1", "agent-2"),
  );
});

test("bad token, wrong run, and mismatched child identity fail closed", async () => {
  const fixture = createServerFixture();
  try {
    await fixture.server.listen();

    const badToken = await rawRequest(
      fixture.socketPath,
      request({ requestId: "bad-token", authToken: "x".repeat(64) }),
    );
    assert.equal(badToken.ok, false);
    assert.equal(badToken.error.code, "unauthorized");

    const wrongRun = await rawRequest(
      fixture.socketPath,
      request({ requestId: "wrong-run", runId: "run-2", sequence: 2 }),
    );
    assert.equal(wrongRun.ok, false);
    assert.equal(wrongRun.error.code, "unauthorized");

    const validChildToken = deriveChildAuthToken(
      AUTH_TOKEN,
      "run-1",
      "agent-1",
    );
    const validChild = await rawRequest(
      fixture.socketPath,
      request({
        requestId: "valid-child",
        clientId: "12345678-1234-4123-8123-123456789abc",
        clientKind: "child",
        agentId: "agent-1",
        authToken: validChildToken,
      }),
    );
    assert.equal(validChild.ok, true);

    const wrongAgent = await rawRequest(
      fixture.socketPath,
      request({
        requestId: "wrong-agent",
        clientId: "87654321-4321-4321-8321-cba987654321",
        clientKind: "child",
        agentId: "agent-2",
        authToken: validChildToken,
      }),
    );
    assert.equal(wrongAgent.ok, false);
    assert.equal(wrongAgent.error.code, "unauthorized");
    assert.equal(fixture.handled.length, 1);
  } finally {
    await fixture.server.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("duplicate client sequences are rejected before application handling", async () => {
  const fixture = createServerFixture();
  try {
    await fixture.server.listen();
    const first = await rawRequest(
      fixture.socketPath,
      request({ sequence: 5 }),
    );
    assert.equal(first.ok, true);

    const duplicate = await rawRequest(
      fixture.socketPath,
      request({ requestId: "request-duplicate", sequence: 5 }),
    );
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, "invalid-sequence");
    assert.equal(fixture.handled.length, 1);
  } finally {
    await fixture.server.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("request errors are typed while unexpected errors do not leak details", async () => {
  const fixture = createServerFixture();
  try {
    await fixture.server.listen();
    const client = new UnixControllerClient({
      socketPath: fixture.socketPath,
      runId: "run-1",
      authToken: AUTH_TOKEN,
      clientId: "parent-errors",
      clientKind: "parent",
      agentId: null,
    });
    await client.connect();
    await assert.rejects(
      client.request({ action: "test.failure", payload: {} }),
      (error: unknown) =>
        error instanceof ControllerRemoteError &&
        error.code === "test-failure" &&
        error.message === "Expected failure",
    );
    await assert.rejects(
      client.request({ action: "test.internal", payload: {} }),
      (error: unknown) =>
        error instanceof ControllerRemoteError &&
        error.code === "internal-error" &&
        error.message === "Controller request failed" &&
        !error.message.includes("secret"),
    );
    client.close();
  } finally {
    await fixture.server.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("listen refuses to replace an existing filesystem entry", async () => {
  const fixture = createServerFixture();
  try {
    const runtimeDirectory = join(fixture.directory, "runtime");
    mkdirSync(runtimeDirectory, { mode: 0o700 });
    writeFileSync(fixture.socketPath, "owned by another process", {
      mode: 0o600,
      flag: "wx",
    });
    await assert.rejects(fixture.server.listen(), ControllerTransportError);
    assert.equal(existsSync(fixture.socketPath), true);
  } finally {
    await fixture.server.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
