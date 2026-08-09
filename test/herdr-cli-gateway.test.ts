import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HerdrCliCommandError,
  HerdrCliGateway,
  InvalidHerdrResponseError,
  NodeHerdrCommandExecutor,
  type HerdrCommandExecutor,
  type HerdrCommandResult,
} from "../src/infrastructure/herdr/herdr-cli-gateway.ts";

const TAB = {
  tab_id: "w1P:t2",
  workspace_id: "w1P",
  number: 2,
  label: "Pi Agents",
  focused: false,
  pane_count: 1,
  agent_status: "working",
};
const PANE = {
  pane_id: "w1P:p4",
  terminal_id: "term_123",
  workspace_id: "w1P",
  tab_id: "w1P:t2",
  focused: true,
  agent_status: "working",
  revision: 42,
  agent: "pi",
  agent_session: {
    source: "herdr:pi",
    agent: "pi",
    kind: "path",
    value: "/sessions/child.jsonl",
  },
  cwd: "/worktrees/story",
  foreground_cwd: "/worktrees/story",
  label: "Builder",
  state_labels: { working: "BUILD" },
  tokens: { run: "run-1" },
};
const LAYOUT = {
  workspace_id: "w1P",
  tab_id: "w1P:t2",
  zoomed: false,
  area: { x: 0, y: 0, width: 200, height: 80 },
  focused_pane_id: "w1P:p4",
  panes: [
    {
      pane_id: "w1P:p4",
      focused: true,
      rect: { x: 0, y: 0, width: 200, height: 80 },
    },
  ],
  splits: [],
};

class FakeExecutor implements HerdrCommandExecutor {
  readonly calls: {
    executablePath: string;
    arguments_: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
  }[] = [];
  readonly #results: HerdrCommandResult[];

  constructor(results: readonly unknown[]) {
    this.#results = results.map((result) => ({
      stdout: typeof result === "string" ? result : JSON.stringify(result),
      stderr: "",
    }));
  }

  execute(
    executablePath: string,
    arguments_: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<HerdrCommandResult> {
    this.calls.push({
      executablePath,
      arguments_: [...arguments_],
      timeoutMs,
      maxOutputBytes,
    });
    const result = this.#results.shift();
    if (result === undefined) throw new Error("No fake Herdr response queued");
    return Promise.resolve(result);
  }
}

function capabilityResponses(protocol = 19): readonly unknown[] {
  return ["herdr 0.8.0\n", { protocol, schema_version: 1 }];
}

function gateway(executor: FakeExecutor): HerdrCliGateway {
  return new HerdrCliGateway({
    herdrPath: "/trusted/herdr",
    timeoutMs: 1_234,
    maxOutputBytes: 987_654,
    executor,
  });
}

test("protocol-pinned reads map bounded Herdr responses into domain evidence", async () => {
  const executor = new FakeExecutor([
    ...capabilityResponses(),
    { id: "cli:tab:list", result: { type: "tab_list", tabs: [TAB] } },
    { id: "cli:pane:list", result: { type: "pane_list", panes: [PANE] } },
    { id: "cli:pane:get", result: { type: "pane_info", pane: PANE } },
    {
      id: "cli:pane:layout",
      result: {
        type: "pane_layout",
        layout: LAYOUT,
      },
    },
    {
      id: "cli:pane:process-info",
      result: {
        type: "pane_process_info",
        process_info: {
          pane_id: "w1P:p4",
          shell_pid: 100,
          foreground_process_group_id: 101,
          tty: "/dev/pts/1",
          foreground_processes: [
            {
              pid: 101,
              name: "bwrap",
              argv: ["/usr/bin/bwrap", "--unshare-user"],
              argv0: "/usr/bin/bwrap",
              cmdline: "/usr/bin/bwrap --unshare-user",
              cwd: "/worktrees/story",
            },
          ],
        },
      },
    },
  ]);
  const client = gateway(executor);

  assert.deepEqual(await client.assertCompatible(), {
    protocolVersion: 19,
    schemaVersion: 1,
    cliVersion: "0.8.0",
  });
  assert.equal((await client.listTabs("w1P"))[0]?.tabId, "w1P:t2");
  assert.equal((await client.listPanes("w1P"))[0]?.tokens.run, "run-1");
  assert.equal((await client.getPane("w1P:p4")).agentSession?.kind, "path");
  assert.equal((await client.getPaneLayout("w1P:p4")).area.width, 200);
  assert.equal(
    (await client.getPaneProcessInfo("w1P:p4")).foregroundProcesses[0]?.name,
    "bwrap",
  );

  assert.deepEqual(executor.calls[0]?.arguments_, ["--version"]);
  assert.deepEqual(executor.calls[1]?.arguments_, ["api", "schema", "--json"]);
  assert.deepEqual(executor.calls[2]?.arguments_, [
    "tab",
    "list",
    "--workspace",
    "w1P",
  ]);
  assert.equal(
    executor.calls.every((call) => call.executablePath === "/trusted/herdr"),
    true,
  );
  assert.equal(
    executor.calls.every((call) => call.timeoutMs === 1_234),
    true,
  );
  assert.equal(
    executor.calls.every((call) => call.maxOutputBytes === 987_654),
    true,
  );
});

test("typed mutations build exact argv and quote terminal commands as inert shell words", async () => {
  const ok = { id: "cli:ok", result: { type: "ok" } };
  const executor = new FakeExecutor([
    ...capabilityResponses(),
    {
      id: "cli:tab:create",
      result: { type: "tab_created", tab: TAB, root_pane: PANE },
    },
    {
      id: "cli:pane:split",
      result: { type: "pane_info", pane: { ...PANE, pane_id: "w1P:p5" } },
    },
    { id: "cli:tab:rename", result: { type: "tab_info", tab: TAB } },
    {
      id: "cli:pane:rename",
      result: { type: "pane_info", pane: { ...PANE, pane_id: "w1P:p5" } },
    },
    "",
    "",
    "",
    "",
    "",
    "",
    { id: "cli:tab:focus", result: { type: "tab_info", tab: TAB } },
    {
      id: "cli:pane:focus",
      result: {
        type: "pane_focus_direction",
        focus: {
          changed: true,
          source_pane_id: "w1P:p5",
          focused_pane_id: "w1P:p4",
          layout: LAYOUT,
        },
      },
    },
    {
      id: "cli:notification:show",
      result: { type: "notification_show", shown: true, reason: "shown" },
    },
    ok,
    ok,
  ]);
  const client = gateway(executor);

  const created = await client.createTab({
    workspaceId: "w1P",
    cwd: "/worktrees/integration",
    label: "Pi Agents",
    environment: { Z_TAG: "last", A_TAG: "first" },
  });
  assert.equal(created.rootPane.paneId, "w1P:p4");
  assert.equal(
    (
      await client.splitPane({
        paneId: "w1P:p4",
        direction: "right",
        ratio: 0.5,
        cwd: "/worktrees/story",
        environment: { AGENTWORKS_RUN_ID: "run-1" },
      })
    ).paneId,
    "w1P:p5",
  );
  await client.renameTab("w1P:t2", "Pi Agents");
  await client.renamePane("w1P:p5", "Builder 01");
  await client.runCommand("w1P:p5", [
    "/usr/bin/bwrap",
    "space value",
    "$(touch /tmp/injected)",
    "quote'value",
  ]);
  await client.sendText("w1P:p5", ".");
  await client.reportAgent({
    paneId: "w1P:p5",
    source: "agentworks:controller",
    agent: "Builder 01",
    state: "working",
    message: "Implement story",
    sequence: 7,
    sessionPath: "/sessions/story.jsonl",
  });
  await client.reportAgentSession({
    paneId: "w1P:p5",
    source: "agentworks:controller",
    agent: "Builder 01",
    sequence: 8,
    sessionId: "session-1",
    sessionStartSource: "agentworks",
  });
  await client.reportPaneMetadata({
    paneId: "w1P:p5",
    source: "agentworks:controller",
    sequence: 9,
    title: "Builder · story-1",
    tokens: { run: "run-1", story: "story-1" },
    ttlMs: 10_000,
  });
  await client.releaseAgent(
    "w1P:p5",
    "agentworks:controller",
    "Builder 01",
    10,
  );
  await client.focusTab("w1P:t2");
  assert.equal(
    (await client.focusPaneNeighbor("w1P:p5", "left")).focusedPaneId,
    "w1P:p4",
  );
  assert.deepEqual(
    await client.showNotification({
      title: "Review requested",
      body: "Story 1 needs attention",
      position: "bottom-right",
      sound: "request",
    }),
    { shown: true, reason: "shown" },
  );
  await client.closePane("w1P:p5");
  await client.closeTab("w1P:t2");

  assert.deepEqual(executor.calls[2]?.arguments_, [
    "tab",
    "create",
    "--workspace",
    "w1P",
    "--cwd",
    "/worktrees/integration",
    "--label",
    "Pi Agents",
    "--env",
    "A_TAG=first",
    "--env",
    "Z_TAG=last",
    "--no-focus",
  ]);
  assert.deepEqual(executor.calls[3]?.arguments_, [
    "pane",
    "split",
    "--pane",
    "w1P:p4",
    "--direction",
    "right",
    "--ratio",
    "0.5",
    "--cwd",
    "/worktrees/story",
    "--env",
    "AGENTWORKS_RUN_ID=run-1",
    "--no-focus",
  ]);
  assert.deepEqual(executor.calls[6]?.arguments_, [
    "pane",
    "run",
    "w1P:p5",
    "/usr/bin/bwrap",
    "space value",
    "$(touch /tmp/injected)",
    "quote'value",
  ]);
  assert.deepEqual(executor.calls[9]?.arguments_, [
    "pane",
    "report-agent-session",
    "w1P:p5",
    "--source",
    "agentworks:controller",
    "--agent",
    "Builder 01",
    "--seq",
    "8",
    "--agent-session-id",
    "session-1",
    "--session-start-source",
    "agentworks",
  ]);
  assert.deepEqual(executor.calls[13]?.arguments_, [
    "pane",
    "focus",
    "--pane",
    "w1P:p5",
    "--direction",
    "left",
  ]);
  assert.deepEqual(executor.calls[14]?.arguments_, [
    "notification",
    "show",
    "Review requested",
    "--body",
    "Story 1 needs attention",
    "--position",
    "bottom-right",
    "--sound",
    "request",
  ]);
});

test("protocol, response, server, and input widening failures are typed and fail closed", async () => {
  await assert.rejects(
    gateway(new FakeExecutor(capabilityResponses(20))).assertCompatible(),
    InvalidHerdrResponseError,
  );
  await assert.rejects(
    gateway(
      new FakeExecutor([
        ...capabilityResponses(),
        {
          id: "cli:tab:list",
          result: { type: "tab_list", tabs: [], extra: true },
        },
      ]),
    ).listTabs(),
    InvalidHerdrResponseError,
  );
  await assert.rejects(
    gateway(
      new FakeExecutor([
        ...capabilityResponses(),
        { id: "cli:pane:get", error: { code: "not_found", message: "gone" } },
      ]),
    ).getPane("w1P:p4"),
    /not_found.*gone/u,
  );

  const client = gateway(new FakeExecutor(capabilityResponses()));
  await assert.rejects(client.getPane("--help"), HerdrCliCommandError);
  await assert.rejects(
    client.createTab({ workspaceId: "w1P", cwd: "relative", label: "tab" }),
    /absolute/u,
  );
  await assert.rejects(client.renamePane("w1P:p4", "--clear"), /cannot start/u);
  assert.throws(
    () =>
      client.reportAgentSession({
        paneId: "w1P:p4",
        source: "agentworks:controller",
        agent: "Builder",
      }),
    /exactly one/u,
  );
  assert.throws(
    () => client.runCommand("w1P:p4", ["bad\0argument"]),
    /null byte/u,
  );
});

test("Node executor passes shell-shaped arguments literally with shell disabled", async () => {
  if (!existsSync("/usr/bin/printf")) return;
  const root = mkdtempSync(join(tmpdir(), "agentworks-herdr-exec-"));
  const marker = join(root, "injected");
  try {
    const result = await new NodeHerdrCommandExecutor().execute(
      "/usr/bin/printf",
      ["%s", `$(touch ${marker})`],
      2_000,
      64 * 1024,
    );
    assert.equal(result.stdout, `$(touch ${marker})`);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
