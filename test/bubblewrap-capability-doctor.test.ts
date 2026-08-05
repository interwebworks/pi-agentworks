import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  ProductionSandboxLaunchGate,
  ProductionSandboxUnavailableError,
} from "../src/application/sandbox/production-sandbox-launch-gate.ts";
import { assertAgentLaunchPermitted } from "../src/domain/execution-policy.ts";
import { BubblewrapCapabilityDoctor } from "../src/infrastructure/sandbox/bubblewrap-capability-doctor.ts";

test("missing or non-absolute Bubblewrap paths fail closed", () => {
  const missing = new BubblewrapCapabilityDoctor({
    executablePath: "/definitely/missing/agentworks-bwrap",
    clock: () => 1_000,
  }).inspect();
  assert.equal(missing.supported, false);
  assert.equal(missing.evidence, null);
  assert.equal(missing.checkedAt, 1_000);
  assert.match(missing.reasons.join("\n"), /unavailable or untrusted/u);
  assert.deepEqual(
    missing.probes.map((probe) => probe.name),
    ["platform", "executable", "version"],
  );

  const relative = new BubblewrapCapabilityDoctor({
    executablePath: "bwrap",
  }).inspect();
  assert.equal(relative.supported, false);
  assert.equal(relative.evidence, null);
  assert.match(relative.probes[1]?.detail ?? "", /not absolute/u);

  const gate = new ProductionSandboxLaunchGate(
    new BubblewrapCapabilityDoctor({
      executablePath: "/definitely/missing/agentworks-bwrap",
    }),
  );
  assert.throws(
    () => gate.assertAvailable(),
    ProductionSandboxUnavailableError,
  );
});

test(
  "live Bubblewrap doctor proves each kernel and boundary capability",
  { skip: !existsSync("/usr/bin/bwrap") },
  () => {
    const report = new BubblewrapCapabilityDoctor({
      executablePath: "/usr/bin/bwrap",
      clock: () => 2_000,
    }).inspect();

    assert.equal(report.checkedAt, 2_000);
    assert.equal(report.adapter, "bubblewrap");
    assert.equal(report.probes.length, 12);
    assert.deepEqual(
      report.probes.map((probe) => probe.name),
      [
        "platform",
        "executable",
        "version",
        "user-namespace",
        "mount-namespace",
        "pid-namespace",
        "network-namespace",
        "nested-user-namespace-disabled",
        "root-read-only",
        "assigned-worktree-writable",
        "git-metadata-read-only",
        "environment-sanitized",
      ],
    );
    if (!report.supported) {
      assert.equal(report.evidence, null);
      assert.ok(report.reasons.length > 0);
      return;
    }

    assert.deepEqual(report.reasons, []);
    assert.equal(report.executablePath, "/usr/bin/bwrap");
    assert.match(report.version ?? "", /^\d+\.\d+\.\d+$/u);
    assert.equal(
      report.probes.every((probe) => probe.passed),
      true,
    );
    assert.deepEqual(report.evidence, {
      kind: "bubblewrap",
      filesystemBoundary: "kernel-enforced",
      rootReadOnly: true,
      assignedWorktreeWritable: true,
      gitMetadataReadOnly: true,
      environmentSanitized: true,
      networkIsolated: true,
    });
    const gated = new ProductionSandboxLaunchGate(
      new BubblewrapCapabilityDoctor({ executablePath: "/usr/bin/bwrap" }),
    ).assertAvailable();
    assert.equal(gated.supported, true);
    assertAgentLaunchPermitted({
      complexity: "HIGH",
      task: {
        schemaVersion: 1,
        taskId: "task-1",
        runId: "run-1",
        storyId: "story-1",
        title: "Prove the sandbox launch gate",
        userStory:
          "As a controller, I launch children only behind hard isolation.",
        objective: "Verify the Bubblewrap capability evidence.",
        assignedAgentId: "agent-1",
        assignedRole: "backend-developer",
        repositoryRoot: "/repo",
        baseBranch: "agentworks/run-1/integration",
        branchName: "agentworks/run-1/stories/story-1",
        worktreePath: "/worktrees/story-1",
        scope: { included: ["Sandbox probe"], excluded: ["Product changes"] },
        technologyChoices: ["Bubblewrap"],
        deliverables: ["Capability report"],
        acceptanceCriteria: ["All hard boundaries pass"],
        constraints: ["Do not bypass Bubblewrap"],
        dependencies: [],
        validation: [
          { command: "bwrap --version", expected: "Command succeeds" },
        ],
        escalationConditions: ["Boundary probe fails"],
        allowedTools: ["read"],
        writePolicy: "read-only",
      },
      sandbox: report.evidence,
      roleRequiresNetwork: false,
    });
  },
);
