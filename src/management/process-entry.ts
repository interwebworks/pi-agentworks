import { pathToFileURL } from "node:url";
import { renderDashboard } from "../application/tui/dashboard-renderer.ts";
import type { RunStatus } from "../domain/controller-state.ts";
import {
  createDiscoveredParentClientFactory,
  readControllerDashboard,
  type ParentControllerClient,
} from "../infrastructure/controller/parent-management-gateway.ts";
import { resolveControllerRuntimePaths } from "../infrastructure/controller/controller-runtime.ts";
import {
  managementDashboardReadyPath,
  writeManagementDashboardReadyProof,
} from "../infrastructure/herdr/management-dashboard-ready.ts";

const REFRESH_INTERVAL_MS = 1_000;

export interface ManagementProcessConfiguration {
  readonly runtimeRoot: string;
  readonly runId: string;
  readonly readyPath: string;
}

export function parseManagementProcessArguments(
  arguments_: readonly string[],
): ManagementProcessConfiguration {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("Dashboard arguments must be name/value pairs");
    }
    if (values.has(name))
      throw new Error(`Dashboard argument ${name} is duplicated`);
    values.set(name, value);
  }
  if (
    [...values.keys()].some(
      (name) =>
        name !== "--runtime-root" &&
        name !== "--run-id" &&
        name !== "--ready-path",
    )
  ) {
    throw new Error("Dashboard received an unknown argument");
  }
  const runtimeRoot = values.get("--runtime-root")?.trim();
  const runId = values.get("--run-id")?.trim();
  const readyPath = values.get("--ready-path")?.trim();
  if (!runtimeRoot || !runId || !readyPath) {
    throw new Error(
      "Dashboard requires --runtime-root, --run-id, and --ready-path",
    );
  }
  const expectedReadyPath = managementDashboardReadyPath(
    resolveControllerRuntimePaths(runtimeRoot, runId).runtimeDirectory,
  );
  if (readyPath !== expectedReadyPath) {
    throw new Error(
      "Dashboard ready path does not match the private run runtime",
    );
  }
  return Object.freeze({ runtimeRoot, runId, readyPath });
}

function paint(line: string): string {
  if (line.startsWith("AGENTWORKS")) return `\x1b[1;36m${line}\x1b[0m`;
  if (line.startsWith("!") || line.startsWith("×"))
    return `\x1b[31m${line}\x1b[0m`;
  if (/^(STORIES|AGENTS|ATTENTION)/u.test(line))
    return `\x1b[1;34m${line}\x1b[0m`;
  if (line.startsWith("·")) return `\x1b[36m${line}\x1b[0m`;
  return line;
}

/** Run the polling terminal dashboard until q, Ctrl-C, or termination. */
export async function runManagementDashboard(
  configuration: ManagementProcessConfiguration,
): Promise<void> {
  const createClient = createDiscoveredParentClientFactory(
    configuration.runtimeRoot,
    undefined,
    "management",
  );
  let stopped = false;
  let rendering = false;
  let authenticated = false;
  let currentRunStatus: RunStatus | null = null;
  let controlInFlight = false;
  let notice = "";
  const state: { timer?: NodeJS.Timeout } = {};
  const render = async (): Promise<void> => {
    if (rendering || stopped) return;
    rendering = true;
    const client = await createClient(configuration.runId);
    try {
      const dashboard = await readControllerDashboard(client);
      currentRunStatus = dashboard.view.run.status;
      if (!authenticated) {
        writeManagementDashboardReadyProof(
          configuration.readyPath,
          configuration.runId,
        );
        authenticated = true;
      }
      const lines = renderDashboard(dashboard.view, {
        width: process.stdout.columns || 100,
        height: process.stdout.rows || 30,
        plannedActions: dashboard.plannedActions,
        notice,
        refreshedAt: Date.now(),
      });
      process.stdout.write(`\x1b[2J\x1b[H${lines.map(paint).join("\n")}\x1b[J`);
    } finally {
      client.close();
      rendering = false;
    }
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (state.timer !== undefined) clearInterval(state.timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
  const control = async (
    action: "approve" | "reject" | "pause" | "resume",
  ): Promise<void> => {
    if (controlInFlight || stopped) return;
    controlInFlight = true;
    let client: ParentControllerClient | undefined;
    try {
      client = await createClient(configuration.runId);
      await client.request({
        action: "parent.control",
        idempotencyKey: `management-${action}-${Date.now().toString(36)}`,
        payload: { action },
      });
      if (action === "approve" || action === "resume") {
        await client.request({ action: "orchestration.execute", payload: {} });
      }
      notice = `${action} accepted`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notice = `${action} failed: ${message.replace(/[\r\n]+/gu, " ").slice(0, 240)}`;
    } finally {
      client?.close();
      controlInFlight = false;
    }
    await render();
  };
  const onInput = (data: Buffer): void => {
    const text = data.toString("utf8");
    if (text === "q" || text === "\u0003") stop();
    if (text === "r") void render().catch(showError);
    if (text === "a") void control("approve").catch(showError);
    if (text === "x") void control("reject").catch(showError);
    if (text === "p") {
      if (currentRunStatus === "blocked") {
        void control("resume").catch(showError);
      } else if (
        currentRunStatus === "ready" ||
        currentRunStatus === "active"
      ) {
        void control("pause").catch(showError);
      } else {
        notice = `pause/resume is unavailable while the run is ${currentRunStatus ?? "loading"}`;
        void render().catch(showError);
      }
    }
  };
  const showError = (error: unknown): void => {
    rendering = false;
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `\x1b[2J\x1b[H\x1b[31mAgentworks dashboard error\x1b[0m\n${message}\x1b[J`,
    );
  };

  process.stdout.write("\x1b[?1049h\x1b[?25l");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onInput);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await render().catch(showError);
  state.timer = setInterval(
    () => void render().catch(showError),
    REFRESH_INTERVAL_MS,
  );
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!stopped) return;
      clearInterval(check);
      resolve();
    }, 25);
  });
  process.stdin.off("data", onInput);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  runManagementDashboard(
    parseManagementProcessArguments(process.argv.slice(2)),
  ).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
