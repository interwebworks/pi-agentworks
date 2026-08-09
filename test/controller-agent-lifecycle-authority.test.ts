import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateReady,
  reviewSubmitted,
  type AgentMessage,
} from "../src/domain/agent-communication.ts";
import {
  createAgentState,
  createRunState,
  createStoryState,
  type AgentState,
  type StoryState,
} from "../src/domain/controller-state.ts";
import type {
  ControllerAction,
  RoleAuthority,
} from "../src/domain/role-pack.ts";
import { ControllerAgentLifecycle } from "../src/application/orchestration/controller-agent-lifecycle.ts";
import type {
  ControllerRepository,
  ControllerSnapshot,
  FencedWrite,
} from "../src/application/ports/controller-repository.ts";
import type { GitWorkspaceGateway } from "../src/application/ports/git-workspace-gateway.ts";
import type {
  RoleCatalog,
  RoleCatalogEntry,
} from "../src/application/launch/role-resource-resolver.ts";

const RUN_ID = "authority-run";
const STORY_ID = "authority-story";
const WRITE: FencedWrite = {
  ownerId: "controller",
  fencingToken: 7,
  now: 2_000,
};

function role(
  runtimeId: string,
  authority: RoleAuthority,
  controllerActions: readonly ControllerAction[],
): RoleCatalogEntry {
  const id = runtimeId.split("/").at(-1) ?? runtimeId;
  return Object.freeze({
    id,
    runtimeId,
    label: id,
    description: `${id} test role`,
    authority,
    required: false,
    taskKinds: ["software"],
    responsibilities: ["exercise lifecycle authority"],
    promptFile: `${id}.md`,
    systemPrompt: `Act as ${id}`,
    tools: authority === "worker" ? ["read", "write"] : ["read"],
    controllerActions: [...controllerActions],
    writePolicy: authority === "worker" ? "story-writer" : "read-only",
    networkAccess: "disabled",
  });
}

function agent(
  id: string,
  roleRuntimeId: string,
  status: AgentState["status"],
): AgentState {
  return Object.freeze({
    ...createAgentState({
      id,
      runId: RUN_ID,
      roleRuntimeId,
      taskId: STORY_ID,
      worktreePath: "/tmp/authority-story",
      createdAt: 1_000,
    }),
    status,
    paneId: status === "closed" ? null : `pane-${id}`,
    piSessionPath: `/sessions/${id}.jsonl`,
    updatedAt: 1_100,
  });
}

function story(kind: "writer" | "reviewer", agentId: string): StoryState {
  const initial = createStoryState({
    id: STORY_ID,
    runId: RUN_ID,
    title: "Authority story",
    branchName: "agentworks/authority/story",
    worktreePath: "/tmp/authority-story",
    createdAt: 1_000,
  });
  return Object.freeze({
    ...initial,
    status: kind === "writer" ? "assigned" : "awaiting-review",
    assignedAgentId: kind === "writer" ? agentId : "writer-agent",
    candidateStoryHead: kind === "reviewer" ? "a".repeat(40) : null,
    reviewedIntegrationHead: kind === "reviewer" ? "b".repeat(40) : null,
    reviewerAgentId: kind === "reviewer" ? agentId : null,
    updatedAt: 1_100,
  });
}

function snapshot(
  lifecycleAgent: AgentState,
  lifecycleStory: StoryState,
): ControllerSnapshot {
  return Object.freeze({
    revision: 3,
    run: Object.freeze({
      ...createRunState({
        id: RUN_ID,
        title: "Authority run",
        complexity: "LOW",
        repositoryRoot: "/tmp/authority",
        originalCheckout: "/tmp/authority",
        baseBranch: "main",
        integrationBranch: "agentworks/authority/integration",
        integrationWorktree: "/tmp/authority-integration",
        createdAt: 1_000,
      }),
      status: "active",
      updatedAt: 1_100,
    }),
    stories: Object.freeze([lifecycleStory]),
    agents: Object.freeze([lifecycleAgent]),
  });
}

function guardedLifecycle(
  current: ControllerSnapshot,
  catalogRole: RoleCatalogEntry,
): {
  readonly lifecycle: ControllerAgentLifecycle;
  readonly privilegedCalls: () => number;
} {
  let calls = 0;
  const repository = new Proxy(
    {
      loadSnapshot(runId: string) {
        assert.equal(runId, RUN_ID);
        return current;
      },
    },
    {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver) as unknown;
        }
        return () => {
          calls += 1;
          throw new Error(`unexpected repository call ${String(property)}`);
        };
      },
    },
  ) as unknown as ControllerRepository;
  const git = new Proxy(
    {},
    {
      get(_target, property) {
        return () => {
          calls += 1;
          throw new Error(`unexpected Git call ${String(property)}`);
        };
      },
    },
  ) as GitWorkspaceGateway;
  const roleCatalog: RoleCatalog = Object.freeze({
    find() {
      return Promise.resolve(catalogRole);
    },
  });
  return Object.freeze({
    lifecycle: new ControllerAgentLifecycle({
      repository,
      git,
      roleCatalog,
      clock: () => 2_000,
      writerLeaseTtlMs: 10_000,
    }),
    privilegedCalls: () => calls,
  });
}

interface RejectionCase {
  readonly name: string;
  readonly lifecycleAgent: AgentState;
  readonly lifecycleStory: StoryState;
  readonly catalogRole: RoleCatalogEntry;
  readonly message: AgentMessage;
  readonly expected: RegExp;
}

const unauthorizedWriter = agent("writer-agent", "test/writer", "idle");
const closedWriter = agent("writer-agent", "test/writer", "closed");
const unauthorizedReviewer = agent("reviewer-agent", "test/reviewer", "idle");
const failedReviewer = agent("reviewer-agent", "test/reviewer", "failed");

const cases: readonly RejectionCase[] = [
  {
    name: "server rejects raw candidate-ready when catalog lookup does not resolve the agent's exact role",
    lifecycleAgent: unauthorizedWriter,
    lifecycleStory: story("writer", unauthorizedWriter.id),
    catalogRole: role("test/other-writer", "worker", ["submit-work"]),
    message: candidateReady(RUN_ID, unauthorizedWriter.id),
    expected: /no exact controller role authority/u,
  },
  {
    name: "server rejects raw candidate-ready without submit-work authority before privileged effects",
    lifecycleAgent: unauthorizedWriter,
    lifecycleStory: story("writer", unauthorizedWriter.id),
    catalogRole: role("test/writer", "worker", ["report-status"]),
    message: candidateReady(RUN_ID, unauthorizedWriter.id),
    expected: /lacks submit-work authority/u,
  },
  {
    name: "server rejects raw candidate-ready from a closed writer before privileged effects",
    lifecycleAgent: closedWriter,
    lifecycleStory: story("writer", closedWriter.id),
    catalogRole: role("test/writer", "worker", ["submit-work"]),
    message: candidateReady(RUN_ID, closedWriter.id),
    expected: /inactive status closed/u,
  },
  {
    name: "server rejects raw review-submitted without submit-review authority before privileged effects",
    lifecycleAgent: unauthorizedReviewer,
    lifecycleStory: story("reviewer", unauthorizedReviewer.id),
    catalogRole: role("test/reviewer", "reviewer", ["report-status"]),
    message: reviewSubmitted(
      RUN_ID,
      unauthorizedReviewer.id,
      "approved",
      "a".repeat(40),
      "b".repeat(40),
    ),
    expected: /lacks submit-review authority/u,
  },
  {
    name: "server rejects raw review-submitted from a failed reviewer before privileged effects",
    lifecycleAgent: failedReviewer,
    lifecycleStory: story("reviewer", failedReviewer.id),
    catalogRole: role("test/reviewer", "reviewer", ["submit-review"]),
    message: reviewSubmitted(
      RUN_ID,
      failedReviewer.id,
      "approved",
      "a".repeat(40),
      "b".repeat(40),
    ),
    expected: /inactive status failed/u,
  },
];

for (const rejection of cases) {
  test(rejection.name, async () => {
    const current = snapshot(
      rejection.lifecycleAgent,
      rejection.lifecycleStory,
    );
    const before = JSON.stringify(current);
    const guarded = guardedLifecycle(current, rejection.catalogRole);

    await assert.rejects(
      guarded.lifecycle.handle(
        rejection.message,
        WRITE,
        `raw-${rejection.name}`,
      ),
      rejection.expected,
    );

    assert.equal(guarded.privilegedCalls(), 0);
    assert.equal(JSON.stringify(current), before);
  });
}
