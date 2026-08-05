import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import type { JsonValue } from "../src/application/ports/controller-repository.ts";
import {
  ControllerRuntime,
  ControllerRuntimeError,
  discoverControllerRuntime,
  resolveControllerRuntimePaths,
} from "../src/infrastructure/controller/controller-runtime.ts";
import { ControllerLeaseHeldError } from "../src/infrastructure/controller/sqlite-controller-repository.ts";
import { UnixControllerClient } from "../src/infrastructure/controller/unix-controller-transport.ts";

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "agentworks-runtime-"));
}

function runtime(
  runtimeRoot: string,
  options: {
    readonly ownerId?: string;
    readonly clock?: () => number;
  } = {},
): ControllerRuntime {
  return new ControllerRuntime({
    runtimeRoot,
    runId: "run-1",
    ownerId: options.ownerId ?? "controller-a",
    leaseTtlMs: 10_000,
    renewIntervalMs: 1_000,
    autoRenew: false,
    clock: options.clock ?? (() => 1_000),
    authorizeIdentity(request) {
      return request.clientKind === "parent" && request.agentId === null;
    },
    handleRequest(request): JsonValue {
      return {
        action: request.action,
        sequence: request.sequence,
      };
    },
  });
}

async function createKilledSocket(socketPath: string): Promise<void> {
  mkdirSync(join(socketPath, ".."), { recursive: true, mode: 0o700 });
  const source = `
    const net = require("node:net");
    const server = net.createServer(() => {});
    server.listen(process.argv[1], () => process.stdout.write("READY\\n"));
  `;
  const child = spawn(process.execPath, ["-e", source, socketPath], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    child.once("error", rejectReady);
    child.stdout.once("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) resolveReady();
      else rejectReady(new Error("stale socket helper did not become ready"));
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) =>
    child.once("exit", () => resolveExit()),
  );
  assert.equal(lstatSync(socketPath).isSocket(), true);
}

test("runtime startup publishes private discovery metadata and serves clients", async () => {
  const root = createRoot();
  const controller = runtime(root);
  try {
    const descriptor = await controller.start();
    const paths = controller.paths;
    assert.equal(descriptor.runId, "run-1");
    assert.equal(descriptor.ownerId, "controller-a");
    assert.equal(descriptor.fencingToken, 1);
    assert.equal(lstatSync(paths.runtimeDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(paths.descriptorPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(paths.tokenPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(paths.socketPath).mode & 0o777, 0o600);

    const discovered = discoverControllerRuntime(root, "run-1");
    assert.ok(discovered);
    assert.deepEqual(discovered.descriptor, descriptor);
    assert.equal(discovered.authToken, controller.authToken);

    const client = new UnixControllerClient({
      socketPath: discovered.descriptor.socketPath,
      runId: "run-1",
      authToken: discovered.authToken,
      clientId: "parent-1",
      clientKind: "parent",
      agentId: null,
    });
    await client.connect();
    assert.deepEqual(
      await client.request({ action: "snapshot.get", payload: {} }),
      { action: "snapshot.get", sequence: 1 },
    );
    client.close();
  } finally {
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lease renewal atomically republishes expiration metadata", async () => {
  const root = createRoot();
  let now = 1_000;
  const controller = runtime(root, { clock: () => now });
  try {
    const started = await controller.start();
    assert.equal(started.leaseExpiresAt, 11_000);

    now = 5_000;
    const renewed = controller.renewLeaseNow();
    assert.equal(renewed.leaseExpiresAt, 15_000);
    assert.equal(renewed.fencingToken, started.fencingToken);

    const serialized = readFileSync(controller.paths.descriptorPath, "utf8");
    const persisted: unknown = JSON.parse(serialized);
    assert.ok(persisted !== null && typeof persisted === "object");
    assert.equal(
      (persisted as Readonly<Record<string, unknown>>).leaseExpiresAt,
      15_000,
    );
  } finally {
    now = 6_000;
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a competing controller cannot disturb the active runtime", async () => {
  const root = createRoot();
  const first = runtime(root, { ownerId: "controller-a" });
  const second = runtime(root, { ownerId: "controller-b" });
  try {
    await first.start();
    await assert.rejects(second.start(), ControllerLeaseHeldError);

    const discovered = discoverControllerRuntime(root, "run-1");
    assert.ok(discovered);
    assert.equal(discovered.descriptor.ownerId, "controller-a");
    assert.equal(existsSync(discovered.descriptor.socketPath), true);
  } finally {
    await second.shutdown();
    await first.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("graceful shutdown removes discovery and socket but preserves database and token", async () => {
  const root = createRoot();
  const first = runtime(root, { ownerId: "controller-a" });
  try {
    await first.start();
    const token = first.authToken;
    const paths = first.paths;
    await first.shutdown();

    assert.equal(existsSync(paths.descriptorPath), false);
    assert.equal(existsSync(paths.socketPath), false);
    assert.equal(existsSync(paths.databasePath), true);
    assert.equal(existsSync(paths.tokenPath), true);
    assert.equal(discoverControllerRuntime(root, "run-1"), null);

    const second = runtime(root, { ownerId: "controller-b" });
    try {
      const restarted = await second.start();
      assert.equal(restarted.fencingToken, 2);
      assert.equal(second.authToken, token);
    } finally {
      await second.shutdown();
    }
  } finally {
    await first.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup removes a dead controller socket left by SIGKILL", async () => {
  const root = createRoot();
  const paths = resolveControllerRuntimePaths(root, "run-1");
  await createKilledSocket(paths.socketPath);
  const controller = runtime(root);
  try {
    await controller.start();
    assert.equal(lstatSync(paths.socketPath).isSocket(), true);
    assert.ok(discoverControllerRuntime(root, "run-1"));
  } finally {
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe socket entries fail startup and release the acquired lease", async () => {
  const root = createRoot();
  const paths = resolveControllerRuntimePaths(root, "run-1");
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.socketPath, "not a socket", { mode: 0o600 });
  const failed = runtime(root, { ownerId: "controller-a" });
  try {
    await assert.rejects(failed.start(), /not a removable stale socket/u);
    unlinkSync(paths.socketPath);

    const replacement = runtime(root, { ownerId: "controller-b" });
    try {
      const descriptor = await replacement.start();
      assert.equal(descriptor.fencingToken, 2);
    } finally {
      await replacement.shutdown();
    }
  } finally {
    await failed.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery fails closed for missing tokens and tampered descriptors", async () => {
  const root = createRoot();
  const controller = runtime(root);
  try {
    await controller.start();
    unlinkSync(controller.paths.tokenPath);
    assert.throws(
      () => discoverControllerRuntime(root, "run-1"),
      /token file is missing/u,
    );

    writeFileSync(controller.paths.tokenPath, `${"x".repeat(43)}\n`, {
      mode: 0o600,
    });
    const descriptorValue: unknown = JSON.parse(
      readFileSync(controller.paths.descriptorPath, "utf8"),
    );
    assert.ok(descriptorValue !== null && typeof descriptorValue === "object");
    const descriptor = descriptorValue as Record<string, unknown>;
    descriptor.socketPath = "/tmp/attacker.sock";
    writeFileSync(
      controller.paths.descriptorPath,
      `${JSON.stringify(descriptor)}\n`,
      { mode: 0o600 },
    );
    chmodSync(controller.paths.descriptorPath, 0o600);
    assert.throws(
      () => discoverControllerRuntime(root, "run-1"),
      /paths do not match/u,
    );
  } finally {
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("run ids cannot escape the private runtime root", () => {
  assert.throws(
    () => resolveControllerRuntimePaths("/tmp/runtime", "../outside"),
    ControllerRuntimeError,
  );
});
