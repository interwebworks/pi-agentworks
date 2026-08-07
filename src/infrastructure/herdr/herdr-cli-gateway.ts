import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";
import {
  HERDR_PROTOCOL_VERSION,
  type HerdrAgentReport,
  type HerdrAgentSessionReport,
  type HerdrCapabilityEvidence,
  type HerdrCreateTabRequest,
  type HerdrFocusDirection,
  type HerdrGateway,
  type HerdrNotificationRequest,
  type HerdrNotificationResult,
  type HerdrPane,
  type HerdrPaneFocusResult,
  type HerdrPaneLayout,
  type HerdrPaneMetadataReport,
  type HerdrPaneProcessInfo,
  type HerdrSplitPaneRequest,
  type HerdrTab,
} from "../../application/ports/herdr-gateway.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARGUMENTS = 8_192;
const MAX_ARGUMENT_BYTES = 512 * 1024;
const Identifier = Type.String({ minLength: 1, maxLength: 256 });
const NullableString = Type.Union([
  Type.Null(),
  Type.String({ maxLength: 64 * 1024 }),
]);
const NullableInteger = Type.Union([Type.Null(), Type.Integer({ minimum: 0 })]);
const AgentStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("working"),
  Type.Literal("blocked"),
  Type.Literal("done"),
  Type.Literal("unknown"),
]);
const StringMapSchema = Type.Record(
  Type.String({ pattern: "^[A-Za-z0-9_-]{1,32}$" }),
  Type.String({ maxLength: 4_096 }),
  { maxProperties: 32 },
);
const AgentSessionSchema = Type.Object(
  {
    source: Identifier,
    agent: Identifier,
    kind: Type.Union([Type.Literal("id"), Type.Literal("path")]),
    value: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  },
  { additionalProperties: false },
);
const ScrollSchema = Type.Object(
  {
    offset_from_bottom: Type.Integer({ minimum: 0 }),
    max_offset_from_bottom: Type.Integer({ minimum: 0 }),
    viewport_rows: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const TabSchema = Type.Object(
  {
    tab_id: Identifier,
    workspace_id: Identifier,
    number: Type.Integer({ minimum: 0 }),
    label: Type.String({ maxLength: 4_096 }),
    focused: Type.Boolean(),
    pane_count: Type.Integer({ minimum: 0 }),
    agent_status: AgentStatusSchema,
  },
  { additionalProperties: false },
);
const PaneSchema = Type.Object(
  {
    pane_id: Identifier,
    terminal_id: Identifier,
    workspace_id: Identifier,
    tab_id: Identifier,
    focused: Type.Boolean(),
    agent_status: AgentStatusSchema,
    revision: Type.Integer({ minimum: 0 }),
    agent: Type.Optional(NullableString),
    agent_session: Type.Optional(Type.Union([Type.Null(), AgentSessionSchema])),
    cwd: Type.Optional(NullableString),
    display_agent: Type.Optional(NullableString),
    foreground_cwd: Type.Optional(NullableString),
    label: Type.Optional(NullableString),
    scroll: Type.Optional(Type.Union([Type.Null(), ScrollSchema])),
    state_labels: Type.Optional(StringMapSchema),
    terminal_title: Type.Optional(NullableString),
    terminal_title_stripped: Type.Optional(NullableString),
    title: Type.Optional(NullableString),
    tokens: Type.Optional(StringMapSchema),
  },
  { additionalProperties: false },
);
const RectSchema = Type.Object(
  {
    x: Type.Integer({ minimum: 0, maximum: 65_535 }),
    y: Type.Integer({ minimum: 0, maximum: 65_535 }),
    width: Type.Integer({ minimum: 0, maximum: 65_535 }),
    height: Type.Integer({ minimum: 0, maximum: 65_535 }),
  },
  { additionalProperties: false },
);
const LayoutSchema = Type.Object(
  {
    workspace_id: Identifier,
    tab_id: Identifier,
    zoomed: Type.Boolean(),
    area: RectSchema,
    focused_pane_id: Identifier,
    panes: Type.Array(
      Type.Object(
        { pane_id: Identifier, focused: Type.Boolean(), rect: RectSchema },
        { additionalProperties: false },
      ),
      { maxItems: 256 },
    ),
    splits: Type.Array(
      Type.Object(
        {
          id: Identifier,
          direction: Type.Union([Type.Literal("right"), Type.Literal("down")]),
          ratio: Type.Number({ minimum: 0, maximum: 1 }),
          rect: RectSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 255 },
    ),
  },
  { additionalProperties: false },
);
const ProcessSchema = Type.Object(
  {
    pid: Type.Integer({ minimum: 0 }),
    name: Type.String({ minLength: 1, maxLength: 4_096 }),
    argv: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Array(Type.String({ maxLength: 64 * 1024 }), { maxItems: 8_192 }),
      ]),
    ),
    argv0: Type.Optional(NullableString),
    cmdline: Type.Optional(NullableString),
    cwd: Type.Optional(NullableString),
  },
  { additionalProperties: false },
);
const ProcessInfoSchema = Type.Object(
  {
    pane_id: Identifier,
    shell_pid: Type.Optional(NullableInteger),
    foreground_process_group_id: Type.Optional(NullableInteger),
    tty: Type.Optional(NullableString),
    foreground_processes: Type.Optional(
      Type.Array(ProcessSchema, { maxItems: 4_096 }),
    ),
  },
  { additionalProperties: false },
);
const ErrorEnvelopeSchema = Type.Object(
  {
    id: Identifier,
    error: Type.Object(
      {
        code: Identifier,
        message: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const CapabilitySchema = Type.Object({
  protocol: Type.Literal(HERDR_PROTOCOL_VERSION),
  schema_version: Type.Integer({ minimum: 1 }),
});
const OkResultSchema = Type.Object(
  { type: Type.Literal("ok") },
  { additionalProperties: false },
);
const TabListResultSchema = Type.Object(
  {
    type: Type.Literal("tab_list"),
    tabs: Type.Array(TabSchema, { maxItems: 512 }),
  },
  { additionalProperties: false },
);
const PaneListResultSchema = Type.Object(
  {
    type: Type.Literal("pane_list"),
    panes: Type.Array(PaneSchema, { maxItems: 4_096 }),
  },
  { additionalProperties: false },
);
const PaneInfoResultSchema = Type.Object(
  { type: Type.Literal("pane_info"), pane: PaneSchema },
  { additionalProperties: false },
);
const TabInfoResultSchema = Type.Object(
  { type: Type.Literal("tab_info"), tab: TabSchema },
  { additionalProperties: false },
);
const TabCreatedResultSchema = Type.Object(
  { type: Type.Literal("tab_created"), tab: TabSchema, root_pane: PaneSchema },
  { additionalProperties: false },
);
const LayoutResultSchema = Type.Object(
  { type: Type.Literal("pane_layout"), layout: LayoutSchema },
  { additionalProperties: false },
);
const FocusResultSchema = Type.Object(
  {
    type: Type.Literal("pane_focus_direction"),
    focus: Type.Object(
      {
        changed: Type.Boolean(),
        source_pane_id: Identifier,
        focused_pane_id: Type.Optional(Type.Union([Type.Null(), Identifier])),
        reason: Type.Optional(
          Type.Union([Type.Null(), Type.Literal("no_neighbor")]),
        ),
        layout: LayoutSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const NotificationResultSchema = Type.Object(
  {
    type: Type.Literal("notification_show"),
    shown: Type.Boolean(),
    reason: Type.Union([
      Type.Literal("shown"),
      Type.Literal("disabled"),
      Type.Literal("rate_limited"),
      Type.Literal("no_foreground_client"),
      Type.Literal("busy"),
    ]),
  },
  { additionalProperties: false },
);
const ProcessInfoResultSchema = Type.Object(
  {
    type: Type.Literal("pane_process_info"),
    process_info: ProcessInfoSchema,
  },
  { additionalProperties: false },
);

type Schema = TSchema;
type RawTab = Static<typeof TabSchema>;
type RawPane = Static<typeof PaneSchema>;
type RawLayout = Static<typeof LayoutSchema>;
type RawProcessInfo = Static<typeof ProcessInfoSchema>;

export interface HerdrCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface HerdrCommandExecutor {
  execute(
    executablePath: string,
    arguments_: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<HerdrCommandResult>;
}

export class NodeHerdrCommandExecutor implements HerdrCommandExecutor {
  execute(
    executablePath: string,
    arguments_: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<HerdrCommandResult> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        executablePath,
        [...arguments_],
        {
          encoding: "utf8",
          maxBuffer: maxOutputBytes,
          timeout: timeoutMs,
          shell: false,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(
              new HerdrCliCommandError(
                `Herdr command failed: ${stderr.trim() || error.message}`,
                arguments_.slice(0, 2),
              ),
            );
            return;
          }
          resolvePromise({ stdout, stderr });
        },
      );
    });
  }
}

export interface HerdrCliGatewayOptions {
  readonly herdrPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly executor?: HerdrCommandExecutor;
}

export class HerdrCliCommandError extends Error {
  readonly command: readonly string[];

  constructor(message: string, command: readonly string[]) {
    super(message);
    this.name = "HerdrCliCommandError";
    this.command = command;
  }
}

export class InvalidHerdrResponseError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "InvalidHerdrResponseError";
    this.issues = issues;
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HerdrCliCommandError(`${label} must be positive`, []);
  }
  return value;
}

function assertText(
  value: string,
  label: string,
  maxLength = 64 * 1024,
): string {
  if (value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new HerdrCliCommandError(`${label} is invalid`, []);
  }
  return value;
}

function assertIdentifier(
  value: string,
  kind: "pane" | "tab" | "workspace",
): string {
  const patterns = {
    pane: /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/u,
    tab: /^[A-Za-z0-9]+:t[A-Za-z0-9]+$/u,
    workspace: /^[A-Za-z0-9]+$/u,
  };
  if (value.length > 128 || !patterns[kind].test(value)) {
    throw new HerdrCliCommandError(`Invalid Herdr ${kind} id`, []);
  }
  return value;
}

function responseIssues(schema: Schema, value: unknown): readonly string[] {
  return [...Errors(schema, value)].map(
    (error) => `${error.instancePath || "/"}: ${error.message}`,
  );
}

function rawPane(pane: RawPane): HerdrPane {
  return Object.freeze({
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    workspaceId: pane.workspace_id,
    tabId: pane.tab_id,
    focused: pane.focused,
    agentStatus: pane.agent_status,
    revision: pane.revision,
    agent: pane.agent ?? null,
    agentSession:
      pane.agent_session === undefined || pane.agent_session === null
        ? null
        : Object.freeze({ ...pane.agent_session }),
    cwd: pane.cwd ?? null,
    foregroundCwd: pane.foreground_cwd ?? null,
    label: pane.label ?? null,
    title: pane.title ?? null,
    terminalTitle: pane.terminal_title ?? null,
    terminalTitleStripped: pane.terminal_title_stripped ?? null,
    displayAgent: pane.display_agent ?? null,
    stateLabels: Object.freeze({ ...(pane.state_labels ?? {}) }),
    tokens: Object.freeze({ ...(pane.tokens ?? {}) }),
  });
}

function rawTab(tab: RawTab): HerdrTab {
  return Object.freeze({
    tabId: tab.tab_id,
    workspaceId: tab.workspace_id,
    number: tab.number,
    label: tab.label,
    focused: tab.focused,
    paneCount: tab.pane_count,
    agentStatus: tab.agent_status,
  });
}

function rawLayout(layout: RawLayout): HerdrPaneLayout {
  return Object.freeze({
    workspaceId: layout.workspace_id,
    tabId: layout.tab_id,
    zoomed: layout.zoomed,
    area: Object.freeze({ ...layout.area }),
    focusedPaneId: layout.focused_pane_id,
    panes: Object.freeze(
      layout.panes.map((pane) =>
        Object.freeze({
          paneId: pane.pane_id,
          focused: pane.focused,
          rect: Object.freeze({ ...pane.rect }),
        }),
      ),
    ),
    splits: Object.freeze(
      layout.splits.map((split) =>
        Object.freeze({
          id: split.id,
          direction: split.direction,
          ratio: split.ratio,
          rect: Object.freeze({ ...split.rect }),
        }),
      ),
    ),
  });
}

function rawProcessInfo(info: RawProcessInfo): HerdrPaneProcessInfo {
  return Object.freeze({
    paneId: info.pane_id,
    shellPid: info.shell_pid ?? null,
    foregroundProcessGroupId: info.foreground_process_group_id ?? null,
    tty: info.tty ?? null,
    foregroundProcesses: Object.freeze(
      (info.foreground_processes ?? []).map((process) =>
        Object.freeze({
          pid: process.pid,
          name: process.name,
          argv:
            process.argv === undefined || process.argv === null
              ? null
              : Object.freeze([...process.argv]),
          argv0: process.argv0 ?? null,
          cmdline: process.cmdline ?? null,
          cwd: process.cwd ?? null,
        }),
      ),
    ),
  });
}

export class HerdrCliGateway implements HerdrGateway {
  readonly #herdrPath: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #executor: HerdrCommandExecutor;
  #capability: Promise<HerdrCapabilityEvidence> | null = null;

  constructor(options: HerdrCliGatewayOptions = {}) {
    this.#herdrPath = options.herdrPath ?? "herdr";
    this.#timeoutMs = positiveSafeInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Herdr timeout",
    );
    this.#maxOutputBytes = positiveSafeInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "Herdr output limit",
    );
    this.#executor = options.executor ?? new NodeHerdrCommandExecutor();
  }

  assertCompatible(): Promise<HerdrCapabilityEvidence> {
    this.#capability ??= this.#readCapability().catch((error: unknown) => {
      this.#capability = null;
      throw error;
    });
    return this.#capability;
  }

  async listTabs(workspaceId?: string): Promise<readonly HerdrTab[]> {
    const args = ["tab", "list"];
    if (workspaceId !== undefined) {
      args.push("--workspace", assertIdentifier(workspaceId, "workspace"));
    }
    const result = await this.#success(args, TabListResultSchema);
    return Object.freeze(result.tabs.map(rawTab));
  }

  async listPanes(workspaceId?: string): Promise<readonly HerdrPane[]> {
    const args = ["pane", "list"];
    if (workspaceId !== undefined) {
      args.push("--workspace", assertIdentifier(workspaceId, "workspace"));
    }
    const result = await this.#success(args, PaneListResultSchema);
    return Object.freeze(result.panes.map(rawPane));
  }

  async getPane(paneId: string): Promise<HerdrPane> {
    const result = await this.#success(
      ["pane", "get", assertIdentifier(paneId, "pane")],
      PaneInfoResultSchema,
    );
    return rawPane(result.pane);
  }

  async getPaneLayout(paneId: string): Promise<HerdrPaneLayout> {
    const result = await this.#success(
      ["pane", "layout", "--pane", assertIdentifier(paneId, "pane")],
      LayoutResultSchema,
    );
    return rawLayout(result.layout);
  }

  async getPaneProcessInfo(paneId: string): Promise<HerdrPaneProcessInfo> {
    const result = await this.#success(
      ["pane", "process-info", "--pane", assertIdentifier(paneId, "pane")],
      ProcessInfoResultSchema,
    );
    return rawProcessInfo(result.process_info);
  }

  async createTab(request: HerdrCreateTabRequest): Promise<{
    readonly tab: HerdrTab;
    readonly rootPane: HerdrPane;
  }> {
    if (!isAbsolute(request.cwd)) {
      throw new HerdrCliCommandError("Herdr tab cwd must be absolute", []);
    }
    const args = [
      "tab",
      "create",
      "--workspace",
      assertIdentifier(request.workspaceId, "workspace"),
      "--cwd",
      assertText(request.cwd, "Herdr tab cwd"),
      "--label",
      assertText(request.label, "Herdr tab label", 256),
    ];
    this.#environmentOptions(args, request.environment);
    args.push(request.focus === true ? "--focus" : "--no-focus");
    const result = await this.#success(args, TabCreatedResultSchema);
    return Object.freeze({
      tab: rawTab(result.tab),
      rootPane: rawPane(result.root_pane),
    });
  }

  async splitPane(request: HerdrSplitPaneRequest): Promise<HerdrPane> {
    if (!isAbsolute(request.cwd)) {
      throw new HerdrCliCommandError("Herdr pane cwd must be absolute", []);
    }
    if (
      !Number.isFinite(request.ratio) ||
      request.ratio <= 0 ||
      request.ratio >= 1
    ) {
      throw new HerdrCliCommandError(
        "Herdr pane ratio must be between zero and one",
        [],
      );
    }
    const args = [
      "pane",
      "split",
      "--pane",
      assertIdentifier(request.paneId, "pane"),
      "--direction",
      request.direction,
      "--ratio",
      String(request.ratio),
      "--cwd",
      assertText(request.cwd, "Herdr pane cwd"),
    ];
    this.#environmentOptions(args, request.environment);
    args.push(request.focus === true ? "--focus" : "--no-focus");
    const result = await this.#success(args, PaneInfoResultSchema);
    return rawPane(result.pane);
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.#success(
      [
        "tab",
        "rename",
        assertIdentifier(tabId, "tab"),
        this.#positionalLabel(label),
      ],
      TabInfoResultSchema,
    );
  }

  async renamePane(paneId: string, label: string): Promise<void> {
    await this.#success(
      [
        "pane",
        "rename",
        assertIdentifier(paneId, "pane"),
        this.#positionalLabel(label),
      ],
      PaneInfoResultSchema,
    );
  }

  async focusTab(tabId: string): Promise<void> {
    await this.#success(
      ["tab", "focus", assertIdentifier(tabId, "tab")],
      TabInfoResultSchema,
    );
  }

  async focusPaneNeighbor(
    paneId: string,
    direction: HerdrFocusDirection,
  ): Promise<HerdrPaneFocusResult> {
    const result = await this.#success(
      [
        "pane",
        "focus",
        "--pane",
        assertIdentifier(paneId, "pane"),
        "--direction",
        direction,
      ],
      FocusResultSchema,
    );
    return Object.freeze({
      changed: result.focus.changed,
      sourcePaneId: result.focus.source_pane_id,
      focusedPaneId: result.focus.focused_pane_id ?? null,
      reason: result.focus.reason ?? null,
      layout: rawLayout(result.focus.layout),
    });
  }

  closeTab(tabId: string): Promise<void> {
    return this.#ok(["tab", "close", assertIdentifier(tabId, "tab")]);
  }

  closePane(paneId: string): Promise<void> {
    return this.#ok(["pane", "close", assertIdentifier(paneId, "pane")]);
  }

  runCommand(paneId: string, command: readonly string[]): Promise<void> {
    if (command.length === 0 || command.length > MAX_ARGUMENTS) {
      throw new HerdrCliCommandError(
        "Terminal command argument count is invalid",
        [],
      );
    }
    const arguments_ = command.map((argument) => {
      if (argument.includes("\0")) {
        throw new HerdrCliCommandError(
          "Terminal command contains a null byte",
          [],
        );
      }
      return assertText(
        argument,
        "Terminal command argument",
        MAX_ARGUMENT_BYTES,
      );
    });
    if (Buffer.byteLength(arguments_.join("\0")) > MAX_ARGUMENT_BYTES) {
      throw new HerdrCliCommandError("Terminal command is too large", []);
    }
    return this.#empty([
      "pane",
      "run",
      assertIdentifier(paneId, "pane"),
      ...arguments_,
    ]);
  }

  sendText(paneId: string, text: string): Promise<void> {
    return this.#empty([
      "pane",
      "send-text",
      assertIdentifier(paneId, "pane"),
      assertText(text, "Herdr pane text", MAX_ARGUMENT_BYTES),
    ]);
  }

  reportAgent(report: HerdrAgentReport): Promise<void> {
    if (report.sessionId !== undefined && report.sessionPath !== undefined) {
      throw new HerdrCliCommandError(
        "Herdr agent report cannot contain both session id and path",
        [],
      );
    }
    if (report.sessionPath !== undefined && !isAbsolute(report.sessionPath)) {
      throw new HerdrCliCommandError(
        "Herdr agent session path must be absolute",
        [],
      );
    }
    const args = [
      "pane",
      "report-agent",
      assertIdentifier(report.paneId, "pane"),
      "--source",
      this.#source(report.source),
      "--agent",
      assertText(report.agent, "Herdr agent label", 256),
      "--state",
      report.state,
    ];
    this.#optional(args, "--message", report.message, 4_096);
    this.#sequence(args, report.sequence);
    this.#optional(args, "--agent-session-id", report.sessionId);
    this.#optional(args, "--agent-session-path", report.sessionPath);
    return this.#empty(args);
  }

  reportAgentSession(report: HerdrAgentSessionReport): Promise<void> {
    if (
      (report.sessionId === undefined) ===
      (report.sessionPath === undefined)
    ) {
      throw new HerdrCliCommandError(
        "Herdr agent session requires exactly one id or path",
        [],
      );
    }
    if (report.sessionPath !== undefined && !isAbsolute(report.sessionPath)) {
      throw new HerdrCliCommandError(
        "Herdr agent session path must be absolute",
        [],
      );
    }
    const args = [
      "pane",
      "report-agent-session",
      assertIdentifier(report.paneId, "pane"),
      "--source",
      this.#source(report.source),
      "--agent",
      assertText(report.agent, "Herdr agent label", 256),
    ];
    this.#sequence(args, report.sequence);
    this.#optional(args, "--agent-session-id", report.sessionId);
    this.#optional(args, "--agent-session-path", report.sessionPath);
    this.#optional(
      args,
      "--session-start-source",
      report.sessionStartSource,
      256,
    );
    return this.#empty(args);
  }

  reportPaneMetadata(report: HerdrPaneMetadataReport): Promise<void> {
    const args = [
      "pane",
      "report-metadata",
      assertIdentifier(report.paneId, "pane"),
      "--source",
      this.#source(report.source),
    ];
    this.#sequence(args, report.sequence);
    this.#optional(args, "--title", report.title, 256);
    this.#optional(args, "--display-agent", report.displayAgent, 256);
    if (Object.keys(report.tokens ?? {}).length > 32) {
      throw new HerdrCliCommandError("Too many Herdr metadata tokens", []);
    }
    for (const [name, value] of Object.entries(report.tokens ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) {
        throw new HerdrCliCommandError("Invalid Herdr metadata token name", []);
      }
      args.push(
        "--token",
        `${name}=${assertText(value, "metadata token", 4_096)}`,
      );
    }
    if (report.ttlMs !== undefined) {
      this.#integerOption(args, "--ttl-ms", report.ttlMs);
    }
    return this.#empty(args);
  }

  async showNotification(
    request: HerdrNotificationRequest,
  ): Promise<HerdrNotificationResult> {
    const title = this.#positionalLabel(request.title);
    const args = ["notification", "show", title];
    this.#optional(args, "--body", request.body, 4_096);
    if (request.position !== undefined) {
      args.push("--position", request.position);
    }
    args.push("--sound", request.sound);
    const result = await this.#success(args, NotificationResultSchema);
    return Object.freeze({ shown: result.shown, reason: result.reason });
  }

  releaseAgent(
    paneId: string,
    source: string,
    agent: string,
    sequence?: number,
  ): Promise<void> {
    const args = [
      "pane",
      "release-agent",
      assertIdentifier(paneId, "pane"),
      "--source",
      this.#source(source),
      "--agent",
      assertText(agent, "Herdr agent label", 256),
    ];
    this.#sequence(args, sequence);
    return this.#empty(args);
  }

  async #readCapability(): Promise<HerdrCapabilityEvidence> {
    const versionResult = await this.#execute(["--version"]);
    const version = versionResult.stdout.trim();
    if (!/^herdr \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
      throw new InvalidHerdrResponseError("Herdr returned an invalid version");
    }
    const schemaResult = await this.#execute(["api", "schema", "--json"]);
    const schema = this.#json(schemaResult.stdout);
    if (!Check(CapabilitySchema, schema)) {
      throw new InvalidHerdrResponseError(
        `Herdr protocol ${String(HERDR_PROTOCOL_VERSION)} is required`,
        responseIssues(CapabilitySchema, schema),
      );
    }
    return Object.freeze({
      protocolVersion: schema.protocol,
      schemaVersion: schema.schema_version,
      cliVersion: version.slice("herdr ".length),
    });
  }

  async #ok(args: readonly string[]): Promise<void> {
    await this.#success(args, OkResultSchema);
  }

  async #empty(args: readonly string[]): Promise<void> {
    await this.assertCompatible();
    const response = await this.#execute(args);
    if (response.stdout.trim().length !== 0) {
      throw new InvalidHerdrResponseError(
        "Herdr returned unexpected output for a one-way command",
      );
    }
  }

  async #success<S extends Schema>(
    args: readonly string[],
    resultSchema: S,
  ): Promise<Static<S>> {
    await this.assertCompatible();
    const response = await this.#execute(args);
    const value = this.#json(response.stdout);
    if (Check(ErrorEnvelopeSchema, value)) {
      throw new HerdrCliCommandError(
        `Herdr rejected the command (${value.error.code}): ${value.error.message}`,
        args.slice(0, 2),
      );
    }
    const envelopeSchema = Type.Object(
      { id: Identifier, result: resultSchema },
      { additionalProperties: false },
    );
    if (!Check(envelopeSchema, value)) {
      throw new InvalidHerdrResponseError(
        "Herdr returned an invalid command response",
        responseIssues(envelopeSchema, value),
      );
    }
    return (value as unknown as { readonly result: Static<S> }).result;
  }

  async #execute(args: readonly string[]): Promise<HerdrCommandResult> {
    if (args.length === 0 || args.length > MAX_ARGUMENTS) {
      throw new HerdrCliCommandError("Herdr argument count is invalid", []);
    }
    let bytes = 0;
    for (const argument of args) {
      if (argument.includes("\0")) {
        throw new HerdrCliCommandError(
          "Herdr argument contains a null byte",
          [],
        );
      }
      bytes += Buffer.byteLength(argument);
    }
    if (bytes > MAX_ARGUMENT_BYTES) {
      throw new HerdrCliCommandError("Herdr arguments are too large", []);
    }
    return this.#executor.execute(
      this.#herdrPath,
      args,
      this.#timeoutMs,
      this.#maxOutputBytes,
    );
  }

  #json(stdout: string): unknown {
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new InvalidHerdrResponseError("Herdr returned invalid JSON");
    }
  }

  #source(source: string): string {
    if (!/^[A-Za-z0-9:._-]{1,128}$/u.test(source)) {
      throw new HerdrCliCommandError("Invalid Herdr lifecycle source", []);
    }
    return source;
  }

  #positionalLabel(label: string): string {
    const valid = assertText(label, "Herdr label", 256);
    if (valid.startsWith("-")) {
      throw new HerdrCliCommandError(
        "Herdr positional labels cannot start with a hyphen",
        [],
      );
    }
    return valid;
  }

  #environmentOptions(
    args: string[],
    environment: Readonly<Record<string, string>> | undefined,
  ): void {
    const entries = Object.entries(environment ?? {});
    if (entries.length > 64) {
      throw new HerdrCliCommandError(
        "Too many Herdr pane environment entries",
        [],
      );
    }
    for (const [name, value] of entries.sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)) {
        throw new HerdrCliCommandError(
          "Invalid Herdr pane environment name",
          [],
        );
      }
      args.push(
        "--env",
        `${name}=${assertText(value, "pane environment", 4_096)}`,
      );
    }
  }

  #optional(
    args: string[],
    flag: string,
    value: string | undefined,
    maxLength = 64 * 1024,
  ): void {
    if (value !== undefined)
      args.push(flag, assertText(value, flag, maxLength));
  }

  #sequence(args: string[], sequence: number | undefined): void {
    if (sequence !== undefined) this.#integerOption(args, "--seq", sequence);
  }

  #integerOption(args: string[], flag: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new HerdrCliCommandError(
        `${flag} must be a non-negative safe integer`,
        [],
      );
    }
    args.push(flag, String(value));
  }
}
