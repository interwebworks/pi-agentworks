import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import type {
  BackgroundWorkProvider,
  registerBackgroundWorkProvider,
} from "pi-subagents/background-work";

export const AGENTWORKS_BACKGROUND_WORK_PROVIDER = "pi-agentworks";
export const AGENTWORKS_BACKGROUND_WORK_ENTRY =
  "pi-agentworks.background-run.v1";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENTRY_VERSION = 1;

type BackgroundWorkProviderRegistrar = typeof registerBackgroundWorkProvider;

export interface AgentworksBackgroundWorkOptions {
  readonly isRunActive: (runId: string) => boolean;
  readonly registerProvider?: BackgroundWorkProviderRegistrar;
}

export interface AgentworksBackgroundWorkBinding {
  recordLaunchedRun(
    runId: string,
    context: Pick<ExtensionContext, "sessionManager">,
  ): void;
}

interface SessionBinding {
  readonly sessionId: string;
  readonly runIds: Set<string>;
  readonly disposeProvider: () => void;
}

interface PersistedRunEntry {
  readonly version: typeof ENTRY_VERSION;
  readonly runId: string;
  readonly sessionId: string;
}

interface BackgroundWorkPublicApi {
  readonly registerBackgroundWorkProvider: BackgroundWorkProviderRegistrar;
}

async function loadBackgroundWorkPublicApi(): Promise<BackgroundWorkPublicApi> {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  return jiti.import<BackgroundWorkPublicApi>("pi-subagents/background-work");
}

function validRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

function restoredRunIds(
  entries: readonly unknown[],
  sessionId: string,
): Set<string> {
  const runIds = new Set<string>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Readonly<Record<string, unknown>>;
    if (
      record.type !== "custom" ||
      record.customType !== AGENTWORKS_BACKGROUND_WORK_ENTRY ||
      record.data === null ||
      typeof record.data !== "object" ||
      Array.isArray(record.data)
    ) {
      continue;
    }
    const data = record.data as Readonly<Record<string, unknown>>;
    if (
      data.version === ENTRY_VERSION &&
      data.sessionId === sessionId &&
      validRunId(data.runId)
    ) {
      runIds.add(data.runId);
    }
  }
  return runIds;
}

/**
 * Publish controller-owned Agentworks work through pi-subagents' public,
 * process-local background-work registry.
 *
 * The registry is visibility only. It cannot launch, resume, stop, or mutate an
 * Agentworks run, and a failed registration never changes Agentworks policy.
 */
export function installAgentworksBackgroundWork(
  pi: ExtensionAPI,
  options: AgentworksBackgroundWorkOptions,
): AgentworksBackgroundWorkBinding {
  let activeSession: SessionBinding | null = null;
  let lifecycleGeneration = 0;

  pi.on("session_start", async (_event, context) => {
    const generation = ++lifecycleGeneration;
    activeSession?.disposeProvider();
    activeSession = null;

    const sessionId = context.sessionManager.getSessionId();
    const runIds = restoredRunIds(
      context.sessionManager.getBranch(),
      sessionId,
    );
    const provider: BackgroundWorkProvider = {
      name: AGENTWORKS_BACKGROUND_WORK_PROVIDER,
      listActiveWork: () =>
        [...runIds]
          .sort()
          .filter((runId) => {
            try {
              return options.isRunActive(runId);
            } catch {
              // Losing visibility for possibly active work is less safe than
              // retaining it until a later successful reconciliation.
              return true;
            }
          })
          .map((runId) => ({ id: runId, sessionId })),
    };
    const registerProvider =
      options.registerProvider ??
      (await loadBackgroundWorkPublicApi()).registerBackgroundWorkProvider;
    if (generation !== lifecycleGeneration) return;
    const disposeProvider = registerProvider(provider);
    if (generation !== lifecycleGeneration) {
      disposeProvider();
      return;
    }
    activeSession = { sessionId, runIds, disposeProvider };
  });

  pi.on("session_shutdown", () => {
    lifecycleGeneration += 1;
    activeSession?.disposeProvider();
    activeSession = null;
  });

  const binding: AgentworksBackgroundWorkBinding = {
    recordLaunchedRun(runId, context) {
      if (!validRunId(runId)) return;
      const sessionId = context.sessionManager.getSessionId();
      const session = activeSession;
      if (session?.sessionId !== sessionId) return;
      if (session.runIds.has(runId)) return;
      session.runIds.add(runId);
      const entry: PersistedRunEntry = {
        version: ENTRY_VERSION,
        runId,
        sessionId,
      };
      try {
        pi.appendEntry(AGENTWORKS_BACKGROUND_WORK_ENTRY, entry);
      } catch {
        // Background visibility must not become an execution or policy gate.
        // The in-memory binding remains valid for this session.
      }
    },
  };
  return Object.freeze(binding);
}
