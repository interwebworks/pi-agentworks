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
  const requests: AgentworksToolInput[] = [];
  const gateway: ParentManagementGateway = {
    execute(input) {
      requests.push(input);
      return Promise.resolve({ text: `handled ${input.action}` });
    },
  };
  const api = {
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
  await commands.get("agentworks")?.handler("NORMAL ship it", {
    ui: { notify: (message: string) => notices.push(message) },
  });
  await commands.get("agentworks")?.handler("status run-1", {
    ui: { notify: (message: string) => notices.push(message) },
  });
  const result = await tools.get("agentworks")?.execute("call-1", {
    action: "status",
    runId: "run-1",
  });

  assert.deepEqual(requests, [
    { action: "launch", mode: "NORMAL", task: "ship it" },
    { action: "status", runId: "run-1" },
    { action: "status", runId: "run-1" },
  ]);
  assert.deepEqual(notices, ["handled launch", "handled status"]);
  assert.deepEqual(result?.content, [{ type: "text", text: "handled status" }]);
});
