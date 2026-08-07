import assert from "node:assert/strict";
import test from "node:test";
import type { ManagementPaneEvidence } from "../src/application/herdr/management-pane-lifecycle.ts";
import type { HerdrPaneProcessInfo } from "../src/application/ports/herdr-gateway.ts";
import { ManagementDashboardLauncher } from "../src/infrastructure/herdr/management-dashboard-launcher.ts";

const request = {
  runId: "run-1",
  runtimeRoot: "/runtime",
  workspaceId: "w1P",
  parentTabId: "w1P:t2",
  parentPaneId: "w1P:p1",
};

const pane: ManagementPaneEvidence = {
  paneId: "w1P:p2",
  workspaceId: "w1P",
  tabId: "w1P:t2",
  parentPaneId: "w1P:p1",
  shellPid: 42,
  created: true,
  recovered: false,
};

function processInfo(argv: readonly string[] | null): HerdrPaneProcessInfo {
  return {
    paneId: "w1P:p2",
    shellPid: 42,
    foregroundProcessGroupId: argv === null ? null : 44,
    tty: "/dev/pts/1",
    foregroundProcesses:
      argv === null
        ? []
        : [
            {
              pid: 44,
              name: "node",
              argv,
              argv0: argv[0] ?? null,
              cmdline: argv.join(" "),
              cwd: "/repo",
            },
          ],
  };
}

const command = [
  "/node",
  "--experimental-strip-types",
  "/dashboard.ts",
  "--runtime-root",
  "/runtime",
  "--run-id",
  "run-1",
  "--ready-path",
  "/runtime/run-1/management-dashboard-ready.json",
];

const readyProof = {
  runId: "run-1",
  processId: 44,
  processStartIdentity: "linux:44",
};

test("creates the right sibling and starts the bounded live dashboard command", async () => {
  const lifecycleRequests: unknown[] = [];
  const order: string[] = [];
  const commands: string[][] = [];
  let reads = 0;
  const launcher = new ManagementDashboardLauncher(
    {
      ensure(input) {
        order.push("lifecycle");
        lifecycleRequests.push(input);
        return Promise.resolve(pane);
      },
    },
    {
      assertCompatible: () => {
        order.push("compatibility");
        return Promise.resolve({
          protocolVersion: 17,
          schemaVersion: 1,
          cliVersion: "test",
        });
      },
      getPaneProcessInfo() {
        reads += 1;
        return Promise.resolve(
          reads === 1 ? processInfo(null) : processInfo(command),
        );
      },
      runCommand(_paneId, input) {
        commands.push([...input]);
        return Promise.resolve();
      },
    },
    {
      nodePath: "/node",
      entryPath: "/dashboard.ts",
      sleep: () => Promise.resolve(),
      readReadyProof: () => readyProof,
      readProcessStartIdentity: () => "linux:44",
    },
  );

  const evidence = await launcher.ensure(request);
  assert.deepEqual(order.slice(0, 2), ["compatibility", "lifecycle"]);
  assert.deepEqual(lifecycleRequests, [
    {
      runId: "run-1",
      operationId: "management-run-1",
      workspaceId: "w1P",
      parentTabId: "w1P:t2",
      parentPaneId: "w1P:p1",
      expectedPaneId: null,
      cwd: "/runtime/run-1",
      splitRatio: 0.34,
      metadataSequence: 0,
    },
  ]);
  assert.deepEqual(commands, [command]);
  assert.deepEqual(evidence, {
    paneId: "w1P:p2",
    paneCreated: true,
    dashboardStarted: true,
  });
});

test("does not restart an already exact dashboard process", async () => {
  let runs = 0;
  const launcher = new ManagementDashboardLauncher(
    {
      ensure: () =>
        Promise.resolve({ ...pane, created: false, recovered: true }),
    },
    {
      assertCompatible: () =>
        Promise.resolve({
          protocolVersion: 17,
          schemaVersion: 1,
          cliVersion: "test",
        }),
      getPaneProcessInfo: () => Promise.resolve(processInfo(command)),
      runCommand: () => {
        runs += 1;
        return Promise.resolve();
      },
    },
    {
      nodePath: "/node",
      entryPath: "/dashboard.ts",
      readReadyProof: () => readyProof,
      readProcessStartIdentity: () => "linux:44",
    },
  );
  const evidence = await launcher.ensure(request);
  assert.equal(runs, 0);
  assert.deepEqual(evidence, {
    paneId: "w1P:p2",
    paneCreated: false,
    dashboardStarted: false,
  });
});

test("refuses to inject the dashboard command over an arbitrary foreground process", async () => {
  let runs = 0;
  const launcher = new ManagementDashboardLauncher(
    {
      ensure: () =>
        Promise.resolve({ ...pane, created: false, recovered: true }),
    },
    {
      assertCompatible: () =>
        Promise.resolve({
          protocolVersion: 17,
          schemaVersion: 1,
          cliVersion: "test",
        }),
      getPaneProcessInfo: () =>
        Promise.resolve(processInfo(["/usr/bin/vim", "important.txt"])),
      runCommand: () => {
        runs += 1;
        return Promise.resolve();
      },
    },
    {
      nodePath: "/node",
      entryPath: "/dashboard.ts",
      sleep: () => Promise.resolve(),
      readReadyProof: () => null,
    },
  );
  await assert.rejects(
    launcher.ensure(request),
    /unexpected foreground process/u,
  );
  assert.equal(runs, 0);
});
