import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installParentExtension } from "../src/extension/index.ts";
import type {
  AgentworksToolInput,
  ParentManagementGateway,
} from "../src/extension/parent-command.ts";

test("parent extension delegates launch commands and tool actions to its gateway", async () => {
  const commands = new Map<
    string,
    { handler: (args: string, context: unknown) => Promise<void> }
  >();
  const tools = new Map<
    string,
    {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ content: readonly { type: "text"; text: string }[] }>;
    }
  >();
  const notices: string[] = [];
  const statuses: string[] = [];
  const widgets: string[][] = [];
  const requests: AgentworksToolInput[] = [];
  const gateway: ParentManagementGateway = {
    execute(input) {
      requests.push(input);
      return Promise.resolve({ text: `handled ${input.action}` });
    },
  };
  const api = {
    on() {
      return undefined;
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, context: unknown) => Promise<void> },
    ) {
      commands.set(name, options);
    },
    registerTool(tool: {
      name: string;
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ content: readonly { type: "text"; text: string }[] }>;
    }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;

  installParentExtension(api, gateway);
  const ui = {
    notify: (message: string) => notices.push(message),
    setStatus: (_key: string, text: string | undefined) => {
      if (text !== undefined) statuses.push(text);
    },
    setWidget: (_key: string, content: string[] | undefined) => {
      if (content !== undefined) widgets.push(content);
    },
  };
  const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
  const previousTab = process.env.HERDR_TAB_ID;
  const previousPane = process.env.HERDR_PANE_ID;
  process.env.HERDR_WORKSPACE_ID = "w1P";
  process.env.HERDR_TAB_ID = "w1P:t2";
  process.env.HERDR_PANE_ID = "w1P:p1";
  await commands.get("agentworks")?.handler("NORMAL ship it", {
    ui,
    model: {
      provider: "local-sglang",
      id: "Qwen/Qwen3.5-2B",
      baseUrl: "http://127.0.0.1:30000/v1",
    },
    thinkingLevel: "off",
  });
  if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
  else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
  if (previousTab === undefined) delete process.env.HERDR_TAB_ID;
  else process.env.HERDR_TAB_ID = previousTab;
  if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = previousPane;
  await commands.get("agentworks")?.handler("status run-1", { ui });
  const result = await tools.get("agentworks")?.execute("call-1", {
    action: "status",
    runId: "run-1",
  });

  assert.deepEqual(requests, [
    {
      action: "launch",
      mode: "NORMAL",
      task: "ship it",
      runtime: {
        workspaceId: "w1P",
        origin: { tabId: "w1P:t2", paneId: "w1P:p1" },
        provider: "local-sglang",
        model: "Qwen/Qwen3.5-2B",
        thinking: "off",
        allowHostNetwork: true,
      },
    },
    { action: "status", runId: "run-1" },
    { action: "status", runId: "run-1" },
  ]);
  assert.deepEqual(notices, ["handled launch", "handled status"]);
  assert.deepEqual(statuses, [
    "Agentworks • handled launch",
    "Agentworks • handled status",
  ]);
  assert.deepEqual(widgets, [["handled launch"], ["handled status"]]);
  assert.deepEqual(result?.content, [{ type: "text", text: "handled status" }]);
});
