export const HERDR_PROTOCOL_VERSION = 17 as const;

export type HerdrAgentStatus =
  "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrCapabilityEvidence {
  readonly protocolVersion: typeof HERDR_PROTOCOL_VERSION;
  readonly schemaVersion: number;
  readonly cliVersion: string;
}

export interface HerdrTab {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly number: number;
  readonly label: string;
  readonly focused: boolean;
  readonly paneCount: number;
  readonly agentStatus: HerdrAgentStatus;
}

export interface HerdrAgentSession {
  readonly source: string;
  readonly agent: string;
  readonly kind: "id" | "path";
  readonly value: string;
}

export interface HerdrPane {
  readonly paneId: string;
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly focused: boolean;
  readonly agentStatus: HerdrAgentStatus;
  readonly revision: number;
  readonly agent: string | null;
  readonly agentSession: HerdrAgentSession | null;
  readonly cwd: string | null;
  readonly foregroundCwd: string | null;
  readonly label: string | null;
  readonly title: string | null;
  readonly terminalTitle: string | null;
  readonly terminalTitleStripped: string | null;
  readonly displayAgent: string | null;
  readonly stateLabels: Readonly<Record<string, string>>;
  readonly tokens: Readonly<Record<string, string>>;
}

export interface HerdrRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HerdrPaneLayout {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly zoomed: boolean;
  readonly area: HerdrRect;
  readonly focusedPaneId: string;
  readonly panes: readonly {
    readonly paneId: string;
    readonly focused: boolean;
    readonly rect: HerdrRect;
  }[];
  readonly splits: readonly {
    readonly id: string;
    readonly direction: "right" | "down";
    readonly ratio: number;
    readonly rect: HerdrRect;
  }[];
}

export interface HerdrProcess {
  readonly pid: number;
  readonly name: string;
  readonly argv: readonly string[] | null;
  readonly argv0: string | null;
  readonly cmdline: string | null;
  readonly cwd: string | null;
}

export interface HerdrPaneProcessInfo {
  readonly paneId: string;
  readonly shellPid: number | null;
  readonly foregroundProcessGroupId: number | null;
  readonly tty: string | null;
  readonly foregroundProcesses: readonly HerdrProcess[];
}

export interface HerdrCreateTabRequest {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly label: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly focus?: boolean;
}

export interface HerdrSplitPaneRequest {
  readonly paneId: string;
  readonly direction: "right" | "down";
  readonly ratio: number;
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly focus?: boolean;
}

export interface HerdrAgentReport {
  readonly paneId: string;
  readonly source: string;
  readonly agent: string;
  readonly state: Exclude<HerdrAgentStatus, "done">;
  readonly message?: string;
  readonly sequence?: number;
  readonly sessionId?: string;
  readonly sessionPath?: string;
}

export interface HerdrAgentSessionReport {
  readonly paneId: string;
  readonly source: string;
  readonly agent: string;
  readonly sequence?: number;
  readonly sessionId?: string;
  readonly sessionPath?: string;
  readonly sessionStartSource?: string;
}

export interface HerdrPaneMetadataReport {
  readonly paneId: string;
  readonly source: string;
  readonly sequence?: number;
  readonly title?: string;
  readonly displayAgent?: string;
  readonly tokens?: Readonly<Record<string, string>>;
  readonly ttlMs?: number;
}

export interface HerdrGateway {
  assertCompatible(): Promise<HerdrCapabilityEvidence>;
  listTabs(workspaceId?: string): Promise<readonly HerdrTab[]>;
  listPanes(workspaceId?: string): Promise<readonly HerdrPane[]>;
  getPane(paneId: string): Promise<HerdrPane>;
  getPaneLayout(paneId: string): Promise<HerdrPaneLayout>;
  getPaneProcessInfo(paneId: string): Promise<HerdrPaneProcessInfo>;
  createTab(request: HerdrCreateTabRequest): Promise<{
    readonly tab: HerdrTab;
    readonly rootPane: HerdrPane;
  }>;
  splitPane(request: HerdrSplitPaneRequest): Promise<HerdrPane>;
  renameTab(tabId: string, label: string): Promise<void>;
  renamePane(paneId: string, label: string): Promise<void>;
  focusTab(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  closePane(paneId: string): Promise<void>;
  runCommand(paneId: string, command: readonly string[]): Promise<void>;
  sendText(paneId: string, text: string): Promise<void>;
  reportAgent(report: HerdrAgentReport): Promise<void>;
  reportAgentSession(report: HerdrAgentSessionReport): Promise<void>;
  reportPaneMetadata(report: HerdrPaneMetadataReport): Promise<void>;
  releaseAgent(
    paneId: string,
    source: string,
    agent: string,
    sequence?: number,
  ): Promise<void>;
}
