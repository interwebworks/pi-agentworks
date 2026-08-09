import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import type * as BackgroundWorkApi from "pi-subagents/background-work";
import {
  AGENTWORKS_BACKGROUND_WORK_ENTRY,
  AGENTWORKS_BACKGROUND_WORK_PROVIDER,
  installAgentworksBackgroundWork,
} from "../src/extension/background-work.ts";
import { installParentExtension } from "../src/extension/index.ts";
import type { ParentManagementGateway } from "../src/extension/parent-command.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });

async function publicModule(
  specifier: string,
): Promise<Record<string, unknown>> {
  return jiti.import<Record<string, unknown>>(specifier);
}

function fakeExtensionApi(initialEntries: readonly unknown[] = []) {
  type Handler = (event: unknown, context: unknown) => unknown;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    { handler: (args: string, context: unknown) => Promise<void> }
  >();
  const tools: string[] = [];
  const entries = [...initialEntries];
  const api = {
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    registerCommand(
      name: string,
      command: { handler: (args: string, context: unknown) => Promise<void> },
    ) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, commands, tools, entries };
}

function sessionContext(
  sessionId: string,
  entries: readonly unknown[],
): Pick<ExtensionContext, "sessionManager"> {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
  } as unknown as Pick<ExtensionContext, "sessionManager">;
}

async function invoke(
  handlers: ReadonlyMap<string, readonly ((...args: unknown[]) => unknown)[]>,
  name: string,
  context: unknown,
): Promise<void> {
  for (const handler of handlers.get(name) ?? []) {
    await handler({}, context);
  }
}

test("pi-subagents 0.38.0 stable public compatibility exports are present", async () => {
  const manifest = JSON.parse(
    readFileSync(
      join(packageRoot, "node_modules/pi-subagents/package.json"),
      "utf8",
    ),
  ) as { version?: string; exports?: Record<string, string> };
  assert.equal(manifest.version, "0.38.0");
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), [
    ".",
    "./background-work",
    "./capability-ceiling",
    "./delegation",
    "./preflight",
  ]);

  const background = (await publicModule(
    "pi-subagents/background-work",
  )) as unknown as typeof BackgroundWorkApi;
  assert.equal(typeof background.registerBackgroundWorkProvider, "function");
  assert.equal(typeof background.snapshotBackgroundWork, "function");

  const ceiling = await publicModule("pi-subagents/capability-ceiling");
  assert.equal(typeof ceiling.intersectSubagentCapabilityCeilings, "function");
  assert.equal(typeof ceiling.registerSubagentCapabilityCeiling, "function");

  const preflight = await publicModule("pi-subagents/preflight");
  assert.equal(typeof preflight.resolveSubagentLaunchContract, "function");
});

test("background provider is session-bound, retains probe errors, and survives stale reload disposal", async () => {
  const background = (await publicModule(
    "pi-subagents/background-work",
  )) as unknown as typeof BackgroundWorkApi;
  const first = fakeExtensionApi();
  const firstBinding = installAgentworksBackgroundWork(first.api, {
    isRunActive: () => true,
    registerProvider: background.registerBackgroundWorkProvider,
  });
  const firstContext = sessionContext("session-a", first.entries);
  await invoke(first.handlers, "session_start", firstContext);
  firstBinding.recordLaunchedRun("run-1", firstContext);

  assert.deepEqual(background.snapshotBackgroundWork("session-a").items, [
    {
      provider: AGENTWORKS_BACKGROUND_WORK_PROVIDER,
      id: "run-1",
      sessionId: "session-a",
    },
  ]);
  assert.deepEqual(background.snapshotBackgroundWork("session-b").items, []);
  assert.deepEqual(first.entries, [
    {
      type: "custom",
      customType: AGENTWORKS_BACKGROUND_WORK_ENTRY,
      data: { version: 1, runId: "run-1", sessionId: "session-a" },
    },
  ]);

  const replacement = fakeExtensionApi(first.entries);
  installAgentworksBackgroundWork(replacement.api, {
    isRunActive: () => {
      throw new Error("database schema read failed");
    },
    registerProvider: background.registerBackgroundWorkProvider,
  });
  const replacementContext = sessionContext("session-a", replacement.entries);
  await invoke(replacement.handlers, "session_start", replacementContext);
  await invoke(first.handlers, "session_shutdown", firstContext);

  assert.deepEqual(background.snapshotBackgroundWork("session-a").items, [
    {
      provider: AGENTWORKS_BACKGROUND_WORK_PROVIDER,
      id: "run-1",
      sessionId: "session-a",
    },
  ]);

  await invoke(replacement.handlers, "session_shutdown", replacementContext);
  assert.equal(
    background
      .snapshotBackgroundWork("session-a")
      .providers.includes(AGENTWORKS_BACKGROUND_WORK_PROVIDER),
    false,
  );
});

test("disabled background registration leaves Agentworks as the only execution path", async () => {
  const fake = fakeExtensionApi();
  const requests: unknown[] = [];
  const gateway: ParentManagementGateway = {
    execute(request) {
      requests.push(request);
      return Promise.resolve({
        text: "launched safely",
        launchedRunId: "run-safe",
      });
    },
  };
  installParentExtension(fake.api, gateway, {
    isRunActive: () => true,
    registerProvider: () => () => undefined,
  });
  const context = {
    ...sessionContext("session-safe", fake.entries),
    ui: {
      notify() {
        return undefined;
      },
      setStatus() {
        return undefined;
      },
      setWidget() {
        return undefined;
      },
    },
  };
  await invoke(fake.handlers, "session_start", context);
  await fake.commands
    .get("agentworks")
    ?.handler("HIGH keep authority", context);

  assert.deepEqual(requests, [
    { action: "launch", mode: "HIGH", task: "keep authority" },
  ]);
  assert.deepEqual(fake.tools, ["agentworks"]);

  const source = readFileSync(
    join(packageRoot, "src/extension/background-work.ts"),
    "utf8",
  );
  assert.match(source, /pi-subagents\/background-work/u);
  assert.doesNotMatch(source, /pi-subagents\/src\//u);
  assert.doesNotMatch(source, /pi-subagents\/delegation/u);
});
