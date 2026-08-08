import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  candidateReady,
  operationStarted,
  reviewSubmitted,
  sessionShutdown,
  type AgentMessage,
} from "../src/domain/agent-communication.ts";
import {
  createAgentState,
  createRunState,
  createStoryState,
  transitionRun,
  transitionStory,
  type AgentState,
  type RunState,
  type StoryState,
} from "../src/domain/controller-state.ts";
import {
  integrationBranchForRun,
  storyBranchForRun,
} from "../src/domain/workspace-naming.ts";
import {
  agentCapacity,
  countOccupiedAgentSlots,
} from "../src/domain/scheduling.ts";
import { AgentMessageController } from "../src/application/controller/agent-message-controller.ts";
import { ControllerAgentLifecycle } from "../src/application/orchestration/controller-agent-lifecycle.ts";
import { ControllerOrchestrationEffects } from "../src/application/orchestration/controller-orchestration-effects.ts";
import {
  drainOrchestrationLoop,
  OrchestrationLoop,
} from "../src/application/orchestration/orchestration-loop.ts";
import type {
  ControllerEventInput,
  FencedWrite,
} from "../src/application/ports/controller-repository.ts";
import type { StoryAgentLauncher } from "../src/application/ports/story-agent-launcher.ts";
import { GitCliRepositoryInspector } from "../src/infrastructure/git/git-cli-repository-inspector.ts";
import { GitCliWorkspaceGateway } from "../src/infrastructure/git/git-cli-workspace-gateway.ts";
import { SqliteControllerRepository } from "../src/infrastructure/controller/sqlite-controller-repository.ts";
import { RealOrchestrationContext } from "../src/application/orchestration/real-orchestration-context.ts";
import type {
  RoleCatalog,
  RoleCatalogEntry,
} from "../src/application/launch/role-resource-resolver.ts";
import type {
  ControllerAction,
  RoleAuthority,
} from "../src/domain/role-pack.ts";

const RUN_ID = "lifecycle-run";
const FIRST_STORY = "foundation";
const SECOND_STORY = "dependent";

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  }).trim();
}

function createRepository(root: string): string {
  const repository = join(root, "checkout");
  execFileSync("git", ["init", "--initial-branch", "main", repository], {
    stdio: "ignore",
  });
  git(repository, "config", "user.name", "Agentworks Test");
  git(repository, "config", "user.email", "agentworks@example.test");
  writeFileSync(join(repository, "README.md"), "initial\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "Initial commit");
  writeFileSync(
    join(repository, "personal-notes.txt"),
    "untouched user work\n",
  );
  return repository;
}

function checkoutFingerprint(repository: string): string {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else {
        files.push(
          `${relative(repository, absolute)}:${createHash("sha256")
            .update(readFileSync(absolute))
            .digest("hex")}`,
        );
      }
    }
  };
  walk(repository);
  return JSON.stringify({
    files,
    head: git(repository, "rev-parse", "HEAD"),
    branch: git(repository, "branch", "--show-current"),
    status: git(repository, "status", "--porcelain=v1"),
  });
}

function preparedRun(repository: string, integrationPath: string): RunState {
  let run = createRunState({
    id: RUN_ID,
    title: "Two-story lifecycle",
    complexity: "LOW",
    repositoryRoot: repository,
    originalCheckout: repository,
    baseBranch: "main",
    integrationBranch: integrationBranchForRun(RUN_ID),
    integrationWorktree: integrationPath,
    createdAt: 1_000,
  });
  run = transitionRun(run, { type: "plan-prepared", at: 1_001 });
  run = transitionRun(run, { type: "plan-approved", at: 1_002 });
  return transitionRun(run, {
    type: "run-started",
    at: 1_003,
    integrationWorktreeReady: true,
  });
}

function preparedStory(
  id: string,
  path: string,
  dependencies: readonly string[],
): StoryState {
  let story = createStoryState({
    id,
    runId: RUN_ID,
    title: `Implement ${id}`,
    branchName: storyBranchForRun(RUN_ID, id),
    worktreePath: path,
    planning: {
      narrative: `Deliver ${id}`,
      objective: `Deliver ${id}`,
      taskKinds: ["software"],
      writable: true,
      scope: { included: ["."], excluded: [".git"] },
      technologyChoices: ["existing stack"],
      constraints: ["stay isolated"],
      dependencies,
      deliverables: [`${id}.txt`],
      acceptanceCriteria: [`${id} is integrated`],
      validation: [{ command: "test -f README.md", expected: "passes" }],
      escalationConditions: ["blocked"],
    },
    createdAt: 1_000,
  });
  story = transitionStory(story, {
    type: "story-prepared",
    at: 1_001,
    complexity: "LOW",
  });
  return transitionStory(story, {
    type: "story-plan-approved",
    at: 1_002,
  });
}

function event(type: string, at: number): ControllerEventInput {
  return {
    eventId: `${type}-${String(at)}`,
    type,
    entityType: "run",
    entityId: RUN_ID,
    payload: {},
    occurredAt: at,
  };
}

function idleAgent(
  id: string,
  roleRuntimeId: string,
  taskId: string,
  worktreePath: string,
  at: number,
): AgentState {
  return {
    ...createAgentState({
      id,
      runId: RUN_ID,
      roleRuntimeId,
      taskId,
      worktreePath,
      createdAt: at,
    }),
    status: "idle",
    paneId: `pane-${id}`,
    piSessionPath: `/sessions/${id}.jsonl`,
    lastHeartbeatAt: at,
    lastMeaningfulActivityAt: at,
    updatedAt: at,
  };
}

function lifecycleRole(
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
    responsibilities: ["test lifecycle authority"],
    promptFile: `${id}.md`,
    systemPrompt: `Act as ${id}`,
    tools: authority === "worker" ? ["read", "write"] : ["read"],
    controllerActions: [...controllerActions],
    writePolicy: authority === "worker" ? "story-writer" : "read-only",
    networkAccess: "disabled",
  });
}

function lifecycleRoleCatalog(roles: readonly RoleCatalogEntry[]): RoleCatalog {
  const byRuntimeId = new Map(roles.map((role) => [role.runtimeId, role]));
  return Object.freeze({
    find(runtimeId: string) {
      return Promise.resolve(byRuntimeId.get(runtimeId) ?? null);
    },
  });
}

test("durable child events drive two dependent stories through exact production Git lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-production-lifecycle-"));
  const checkout = createRepository(root);
  const originalFingerprint = checkoutFingerprint(checkout);
  const integrationPath = join(root, "worktrees", RUN_ID, "integration");
  const firstPath = join(root, "worktrees", RUN_ID, FIRST_STORY);
  const secondPath = join(root, "worktrees", RUN_ID, SECOND_STORY);
  const databasePath = join(root, "runtime", "controller.sqlite");
  const repository = new SqliteControllerRepository(databasePath);
  try {
    let now = 2_000;
    const clock = (): number => {
      now += 1;
      return now;
    };
    const lease = repository.acquireLease(
      "controller-lifecycle",
      clock(),
      1_000_000,
    );
    const write = (): FencedWrite => ({
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      now: clock(),
    });
    const inspector = new GitCliRepositoryInspector();
    const gateway = new GitCliWorkspaceGateway();
    const inspection = inspector.inspect(checkout);
    const integration = gateway.createIntegrationWorkspace({
      runId: RUN_ID,
      originalCheckout: checkout,
      repositoryRoot: checkout,
      commonGitDirectory: inspection.commonGitDirectory,
      baseBranch: "main",
      expectedBaseHead: inspection.headCommit ?? "",
      integrationBranch: integrationBranchForRun(RUN_ID),
      worktreePath: integrationPath,
    });
    const run = preparedRun(checkout, integrationPath);
    const stories = [
      preparedStory(FIRST_STORY, firstPath, []),
      preparedStory(SECOND_STORY, secondPath, [FIRST_STORY]),
    ];
    repository.initializeRun({
      write: write(),
      idempotencyKey: "initialize-production-lifecycle",
      request: { command: "initialize-production-lifecycle" },
      run,
      stories,
      agents: [],
      events: [event("run-initialized", clock())],
    });

    const launchOrder: string[] = [];
    const launcher: StoryAgentLauncher = {
      launchProjectManager: () =>
        Promise.reject(new Error("unexpected manager")),
      launchAdvisor: () => Promise.reject(new Error("unexpected advisor")),
      launchWriter: (story, currentRun, snapshot) => {
        launchOrder.push(`writer:${story.id}`);
        const integrationHead = inspector.inspect(integrationPath).headCommit;
        assert.ok(integrationHead);
        gateway.createStoryWorkspace({
          runId: currentRun.id,
          storyId: story.id,
          originalCheckout: checkout,
          repositoryRoot: checkout,
          commonGitDirectory: inspection.commonGitDirectory,
          integrationBranch: currentRun.integrationBranch,
          expectedIntegrationHead: integrationHead,
          storyBranch: story.branchName,
          worktreePath: story.worktreePath,
        });
        const agent = idleAgent(
          `writer-${story.id}`,
          "software-development/backend-developer",
          story.id,
          story.worktreePath,
          clock(),
        );
        repository.acquireWriterLease({
          write: write(),
          runId: currentRun.id,
          storyId: story.id,
          ownerAgentId: agent.id,
          ttlMs: 10_000,
          agent,
        });
        assert.equal(
          snapshot.stories.filter((candidate) => candidate.status !== "ready")
            .length <= 1,
          true,
        );
        return Promise.resolve({
          agent,
          events: [event(`writer-launched-${story.id}`, clock())],
        });
      },
      launchReviewer: (story) => {
        launchOrder.push(`reviewer:${story.id}`);
        return Promise.resolve({
          agent: idleAgent(
            `reviewer-${story.id}`,
            "software-development/code-reviewer",
            story.id,
            story.worktreePath,
            clock(),
          ),
          events: [],
        });
      },
    };
    const effects = new ControllerOrchestrationEffects({
      git: gateway,
      launcher,
      context: new RealOrchestrationContext({
        repository,
        gitInspector: inspector,
      }),
      clock,
    });
    const loop = new OrchestrationLoop({
      repository,
      effects,
      runId: RUN_ID,
      dependenciesByStory: new Map([
        [FIRST_STORY, []],
        [SECOND_STORY, [FIRST_STORY]],
      ]),
      clock,
    });
    const lifecycle = new ControllerAgentLifecycle({
      repository,
      git: gateway,
      roleCatalog: lifecycleRoleCatalog([
        lifecycleRole("software-development/backend-developer", "worker", [
          "report-status",
          "submit-work",
        ]),
        lifecycleRole("software-development/code-reviewer", "reviewer", [
          "report-status",
          "submit-review",
        ]),
      ]),
      clock,
      writerLeaseTtlMs: 10_000,
    });
    const messages = new AgentMessageController(repository, clock);
    let requestSequence = 0;
    let maximumOccupied = 0;
    const recordCapacity = (): void => {
      const current = repository.loadSnapshot(RUN_ID);
      assert.ok(current);
      const occupied = countOccupiedAgentSlots(current.agents);
      maximumOccupied = Math.max(maximumOccupied, occupied);
      assert.equal(occupied <= agentCapacity("LOW", occupied).limit, true);
    };
    const deliver = async (message: AgentMessage): Promise<void> => {
      requestSequence += 1;
      const requestId = `child-${String(requestSequence)}`;
      const committed = messages.apply(message, write(), requestId);
      const beforeLifecycle = repository.loadSnapshot(RUN_ID)?.revision;
      assert.equal(beforeLifecycle, committed.revision);
      await lifecycle.handle(message, write(), requestId);
      await drainOrchestrationLoop(loop, write());
      recordCapacity();
    };

    const initial = await drainOrchestrationLoop(loop, write());
    assert.deepEqual(
      initial.actions.map((action) =>
        "storyId" in action ? `${action.type}:${action.storyId}` : action.type,
      ),
      [`assign-story:${FIRST_STORY}`],
    );
    recordCapacity();
    assert.deepEqual(launchOrder, [`writer:${FIRST_STORY}`]);
    assert.equal(
      repository
        .loadSnapshot(RUN_ID)
        ?.stories.find((story) => story.id === SECOND_STORY)?.status,
      "ready",
    );

    const completeStory = async (storyId: string, storyPath: string) => {
      const writerId = `writer-${storyId}`;
      await deliver(operationStarted(RUN_ID, writerId, storyId));
      writeFileSync(
        join(storyPath, `${storyId}.txt`),
        `${storyId} delivered\n`,
      );
      await deliver(candidateReady(RUN_ID, writerId));
      const candidate = repository
        .loadSnapshot(RUN_ID)
        ?.stories.find((story) => story.id === storyId);
      assert.ok(candidate?.candidateStoryHead);
      assert.ok(candidate.reviewedIntegrationHead);
      assert.equal(
        git(
          storyPath,
          "show",
          "-s",
          "--format=%B",
          candidate.candidateStoryHead,
        ).includes(`Agentworks-Story: ${storyId}`),
        true,
      );
      assert.equal(
        repository.readWriterLease(RUN_ID, storyId)?.ownerAgentId,
        null,
      );
      await deliver(sessionShutdown(RUN_ID, writerId, `session-${writerId}`));
      assert.equal(
        repository
          .loadSnapshot(RUN_ID)
          ?.agents.find((agent) => agent.id === writerId)?.status,
        "closed",
      );

      const reviewerId = `reviewer-${storyId}`;
      await deliver(operationStarted(RUN_ID, reviewerId, storyId));
      const selfReview = reviewSubmitted(
        RUN_ID,
        writerId,
        "approved",
        candidate.candidateStoryHead,
        candidate.reviewedIntegrationHead,
      );
      requestSequence += 1;
      const selfRequest = `child-${String(requestSequence)}`;
      messages.apply(selfReview, write(), selfRequest);
      await assert.rejects(
        lifecycle.handle(selfReview, write(), selfRequest),
        /role .* lacks submit-review authority/u,
      );
      const staleReview = reviewSubmitted(
        RUN_ID,
        reviewerId,
        "approved",
        "0".repeat(40),
        candidate.reviewedIntegrationHead,
      );
      requestSequence += 1;
      const staleRequest = `child-${String(requestSequence)}`;
      messages.apply(staleReview, write(), staleRequest);
      await assert.rejects(
        lifecycle.handle(staleReview, write(), staleRequest),
        /review evidence is stale/u,
      );
      assert.equal(
        repository
          .loadSnapshot(RUN_ID)
          ?.stories.find((story) => story.id === storyId)?.status,
        "awaiting-review",
      );

      const approvedReview = reviewSubmitted(
        RUN_ID,
        reviewerId,
        "approved",
        candidate.candidateStoryHead,
        candidate.reviewedIntegrationHead,
      );
      await deliver(approvedReview);
      await deliver(approvedReview);
      assert.equal(
        repository
          .loadSnapshot(RUN_ID)
          ?.stories.find((story) => story.id === storyId)?.status,
        "approved",
      );
      await deliver(
        sessionShutdown(RUN_ID, reviewerId, `session-${reviewerId}`),
      );
    };

    await completeStory(FIRST_STORY, firstPath);
    let snapshot = repository.loadSnapshot(RUN_ID);
    assert.ok(snapshot);
    const first = snapshot.stories.find((story) => story.id === FIRST_STORY);
    const dependent = snapshot.stories.find(
      (story) => story.id === SECOND_STORY,
    );
    assert.equal(first?.status, "merged");
    assert.equal(first.workspaceCleaned, true);
    assert.equal(dependent?.status, "assigned");
    assert.deepEqual(launchOrder, [
      `writer:${FIRST_STORY}`,
      `reviewer:${FIRST_STORY}`,
      `writer:${SECOND_STORY}`,
    ]);
    assert.equal(checkoutFingerprint(checkout), originalFingerprint);

    await completeStory(SECOND_STORY, secondPath);
    snapshot = repository.loadSnapshot(RUN_ID);
    assert.ok(snapshot);
    assert.equal(snapshot.run.status, "completed");
    assert.equal(
      snapshot.stories.every(
        (story) => story.status === "merged" && story.workspaceCleaned === true,
      ),
      true,
    );
    assert.equal(
      snapshot.agents.every((agent) => agent.status === "closed"),
      true,
    );
    assert.equal(
      snapshot.agents.filter((agent) => agent.status !== "closed").length,
      0,
    );
    assert.equal(maximumOccupied, 2);
    assert.deepEqual(launchOrder, [
      `writer:${FIRST_STORY}`,
      `reviewer:${FIRST_STORY}`,
      `writer:${SECOND_STORY}`,
      `reviewer:${SECOND_STORY}`,
    ]);
    assert.equal(
      git(integrationPath, "rev-parse", "HEAD"),
      snapshot.stories.find((story) => story.id === SECOND_STORY)?.mergeHead,
    );
    assert.equal(checkoutFingerprint(checkout), originalFingerprint);
    const lifecycleEvents = repository.readEvents(
      RUN_ID,
      { revision: 0, eventIndex: -1 },
      1_000,
    );
    assert.equal(
      lifecycleEvents.filter(
        (entry) => entry.type === "story-workspace-cleaned",
      ).length,
      2,
    );
    assert.equal(
      lifecycleEvents.filter((entry) => entry.type === "candidate-created")
        .length,
      2,
    );
    assert.deepEqual(await drainOrchestrationLoop(loop, write()), {
      ticks: 1,
      actions: [],
      committed: false,
    });
    assert.equal(integration.branchHead, git(checkout, "rev-parse", "main"));
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});
