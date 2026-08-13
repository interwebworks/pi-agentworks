import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type {
  AssistantMessage,
  Message,
  Tool,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  InitialStoryPlanSchema,
  parseInitialStoryPlan,
  type InitialStoryPlan,
} from "../domain/initial-story-plan.ts";
import type { ComplexityMode } from "../domain/complexity.ts";

const MAX_PLANNING_TURNS = 12;
const MAX_TOOL_RESULT_BYTES = 24 * 1024;
const MAX_FILE_BYTES = 48 * 1024;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 40;
const MAX_SEARCH_FILES = 1_000;
const MAX_SEARCH_FILE_BYTES = 128 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "runtime",
]);
const SENSITIVE_FILE_NAMES = new Set([".env", ".env.local", ".npmrc"]);

// Codex applies OpenAI strict-schema validation to every JSON-schema tool in
// this request, including tools marked `strict: "prefer"`. Strict schemas
// require every declared object property to appear in `required`, so defaults
// are represented as explicit nulls rather than omitted optional properties.
const NullablePath = Type.Union([
  Type.String({ minLength: 1, maxLength: 512 }),
  Type.Null(),
]);
const ListRepositoryFilesSchema = Type.Object(
  {
    path: NullablePath,
    depth: Type.Union([Type.Integer({ minimum: 1, maximum: 4 }), Type.Null()]),
  },
  { additionalProperties: false },
);
const ReadRepositoryFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    startLine: Type.Union([
      Type.Integer({ minimum: 1, maximum: 100_000 }),
      Type.Null(),
    ]),
    maxLines: Type.Union([
      Type.Integer({ minimum: 1, maximum: 400 }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
const SearchRepositorySchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 240 }),
    path: NullablePath,
  },
  { additionalProperties: false },
);

const PLANNING_TOOLS: readonly Tool[] = Object.freeze([
  {
    name: "list_repository_files",
    description:
      "List safe repository files and directories beneath a relative path. Use this to discover the codebase before planning.",
    parameters: ListRepositoryFilesSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  },
  {
    name: "read_repository_file",
    description:
      "Read a bounded range from one safe, relative repository file. Use this to understand existing architecture and conventions.",
    parameters: ReadRepositoryFileSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  },
  {
    name: "search_repository",
    description:
      "Search safe, text-like repository files for a literal query and receive matching paths and line excerpts.",
    parameters: SearchRepositorySchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  },
  {
    name: "submit_agentworks_plan",
    description:
      "Submit the complete implementation-ready initial Agentworks story plan. Call this exactly once after repository inspection. Do not emit the plan as prose.",
    parameters: InitialStoryPlanSchema,
    constrainedSampling: { type: "json_schema", strict: "require" },
  },
]);

export class ParentModelPlanningError extends Error {
  constructor(message: string) {
    super(`Agentworks parent-model planning failed: ${message}`);
    this.name = "ParentModelPlanningError";
  }
}

export interface ParentLaunchPlanner {
  plan(input: {
    readonly task: string;
    readonly mode: ComplexityMode;
    readonly context: ExtensionContext;
  }): Promise<InitialStoryPlan>;
}

function plannerSystemPrompt(mode: ComplexityMode): string {
  return `You are Agentworks' sole preflight implementation planner.
Create the complete execution plan before any Agentworks management pane or child agent exists.
You may inspect the repository with the supplied read-only tools.
Every declared tool argument must be present. Use null for an argument whose documented default you want.
Do not modify files, delegate work, or create a planning story.

Turn the requested outcome into dependency-ordered, independently deliverable implementation stories.
Every story must be writable and must contain precise scope, technology choices grounded in the repository, deliverables, acceptance criteria, validation commands, and escalation conditions.
Use concise stable lowercase kebab-case ids.
A story may depend only on another submitted story id.
Do not create stories merely for project management, exploration, or planning.
Do not overlap ownership between stories.
Use the requested ${mode} operating mode only to calibrate the degree of decomposition, not to omit requirements.

When the plan is ready, call submit_agentworks_plan exactly once.
Do not reply with a prose plan or JSON outside that tool call.`;
}

function userMessage(task: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Plan this requested Agentworks outcome:\n\n${task}`,
      },
    ],
    timestamp: Date.now(),
  };
}

function textResult(
  toolCallId: string,
  toolName: string,
  text: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function errorResult(
  toolCallId: string,
  toolName: string,
  text: string,
): ToolResultMessage {
  return {
    ...textResult(toolCallId, toolName, text),
    isError: true,
  };
}

function bounded(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_TOOL_RESULT_BYTES) return text;
  let result = text.slice(0, MAX_TOOL_RESULT_BYTES);
  while (Buffer.byteLength(result, "utf8") > MAX_TOOL_RESULT_BYTES) {
    result = result.slice(0, -1);
  }
  return `${result}\n\n[Output truncated]`;
}

function safeRelativePath(root: string, requested: string | undefined): string {
  const candidate = resolve(root, requested?.trim() ?? ".");
  const relation = relative(root, candidate);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !relation.includes(`..${sep}`))
  ) {
    return candidate;
  }
  throw new ParentModelPlanningError(
    "repository inspection path escapes the repository root",
  );
}

function isExcludedPath(path: string): boolean {
  return path
    .split(/[\\/]/u)
    .some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment));
}

function isSensitivePath(path: string): boolean {
  return path
    .split(/[\\/]/u)
    .some((segment) => SENSITIVE_FILE_NAMES.has(segment));
}

async function listFiles(
  root: string,
  path: string | undefined,
  depth: number | undefined,
): Promise<string> {
  const directory = safeRelativePath(root, path);
  const maximumDepth = depth ?? 2;
  const entries: string[] = [];
  const visit = async (current: string, level: number): Promise<void> => {
    if (entries.length >= MAX_DIRECTORY_ENTRIES || level > maximumDepth) return;
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) return;
      const fullPath = resolve(current, child.name);
      const displayPath = relative(root, fullPath);
      if (isExcludedPath(displayPath) || isSensitivePath(displayPath)) continue;
      entries.push(`${child.isDirectory() ? "dir" : "file"} ${displayPath}`);
      if (child.isDirectory() && level < maximumDepth)
        await visit(fullPath, level + 1);
    }
  };
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ParentModelPlanningError(
      "list_repository_files requires a safe directory",
    );
  }
  await visit(directory, 1);
  return bounded(
    entries.length === 0 ? "No visible files." : entries.join("\n"),
  );
}

async function readRepositoryFile(
  root: string,
  path: string,
  startLine: number | undefined,
  maxLines: number | undefined,
): Promise<string> {
  const file = safeRelativePath(root, path);
  const displayPath = relative(root, file);
  if (isExcludedPath(displayPath) || isSensitivePath(displayPath)) {
    throw new ParentModelPlanningError(
      "that repository file is not available to the planner",
    );
  }
  const metadata = await lstat(file);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_FILE_BYTES
  ) {
    throw new ParentModelPlanningError(
      "that repository file is not a safe bounded text file",
    );
  }
  const contents = await readFile(file, "utf8");
  const from = (startLine ?? 1) - 1;
  const lines = contents.split("\n");
  const selected = lines.slice(from, from + (maxLines ?? 200));
  return bounded(
    selected
      .map((line, index) => `${String(from + index + 1)}: ${line}`)
      .join("\n"),
  );
}

async function collectSearchFiles(
  root: string,
  start: string,
): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    if (files.length >= MAX_SEARCH_FILES) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_SEARCH_FILES) return;
      const fullPath = resolve(current, entry.name);
      const displayPath = relative(root, fullPath);
      if (isExcludedPath(displayPath) || isSensitivePath(displayPath)) continue;
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(fullPath);
    }
  };
  await visit(start);
  return files;
}

async function searchRepository(
  root: string,
  query: string,
  path: string | undefined,
): Promise<string> {
  const start = safeRelativePath(root, path);
  const metadata = await lstat(start);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ParentModelPlanningError(
      "search_repository requires a safe directory",
    );
  }
  const normalized = query.toLowerCase();
  const matches: string[] = [];
  for (const file of await collectSearchFiles(root, start)) {
    if (matches.length >= MAX_SEARCH_RESULTS) break;
    const metadata = await lstat(file);
    if (metadata.size > MAX_SEARCH_FILE_BYTES) continue;
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line?.toLowerCase().includes(normalized)) {
        matches.push(
          `${relative(root, file)}:${String(index + 1)}: ${line.trim()}`,
        );
        if (matches.length >= MAX_SEARCH_RESULTS) break;
      }
    }
  }
  return bounded(matches.length === 0 ? "No matches." : matches.join("\n"));
}

async function executePlanningTool(
  root: string,
  call: {
    readonly id: string;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  },
): Promise<ToolResultMessage> {
  try {
    switch (call.name) {
      case "list_repository_files":
        return textResult(
          call.id,
          call.name,
          await listFiles(
            root,
            typeof call.arguments.path === "string"
              ? call.arguments.path
              : undefined,
            typeof call.arguments.depth === "number"
              ? call.arguments.depth
              : undefined,
          ),
        );
      case "read_repository_file":
        if (typeof call.arguments.path !== "string") {
          return errorResult(call.id, call.name, "path is required");
        }
        return textResult(
          call.id,
          call.name,
          await readRepositoryFile(
            root,
            call.arguments.path,
            typeof call.arguments.startLine === "number"
              ? call.arguments.startLine
              : undefined,
            typeof call.arguments.maxLines === "number"
              ? call.arguments.maxLines
              : undefined,
          ),
        );
      case "search_repository":
        if (typeof call.arguments.query !== "string") {
          return errorResult(call.id, call.name, "query is required");
        }
        return textResult(
          call.id,
          call.name,
          await searchRepository(
            root,
            call.arguments.query,
            typeof call.arguments.path === "string"
              ? call.arguments.path
              : undefined,
          ),
        );
      default:
        return errorResult(call.id, call.name, "unknown planning tool");
    }
  } catch (error) {
    return errorResult(
      call.id,
      call.name,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function planningToolCalls(message: AssistantMessage) {
  return message.content.filter(
    (
      content,
    ): content is Extract<
      AssistantMessage["content"][number],
      { type: "toolCall" }
    > => content.type === "toolCall",
  );
}

/**
 * Invoke the selected parent model directly with bounded, read-only repository
 * inspection tools. The plan is parsed at this boundary before any controller
 * or management-pane mutation can occur.
 */
export function createParentModelPlanner(): ParentLaunchPlanner {
  return {
    async plan({ task, mode, context }): Promise<InitialStoryPlan> {
      if (context.model === undefined) {
        throw new ParentModelPlanningError(
          "select an authenticated planning model before launching Agentworks",
        );
      }
      const root = resolve(context.cwd);
      const messages: Message[] = [userMessage(task)];
      for (let turn = 0; turn < MAX_PLANNING_TURNS; turn += 1) {
        const response = await context.modelRegistry.complete(
          context.model,
          {
            systemPrompt: plannerSystemPrompt(mode),
            messages,
            tools: [...PLANNING_TOOLS],
          },
          {
            ...(context.thinkingLevel === undefined ||
            context.thinkingLevel === "off"
              ? {}
              : { reasoning: context.thinkingLevel }),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          },
        );
        if (
          response.stopReason === "error" ||
          response.stopReason === "aborted"
        ) {
          throw new ParentModelPlanningError(
            response.errorMessage ??
              `model stopped with ${response.stopReason}`,
          );
        }
        const calls = planningToolCalls(response);
        const submission = calls.find(
          (call) => call.name === "submit_agentworks_plan",
        );
        if (submission !== undefined)
          return parseInitialStoryPlan(submission.arguments);
        if (calls.length === 0) {
          throw new ParentModelPlanningError(
            "the planner did not submit a structured story plan",
          );
        }
        const results = await Promise.all(
          calls.map((call) => executePlanningTool(root, call)),
        );
        messages.push(response, ...results);
      }
      throw new ParentModelPlanningError(
        `planner exceeded ${String(MAX_PLANNING_TURNS)} bounded inspection turns without submitting a plan`,
      );
    },
  };
}
