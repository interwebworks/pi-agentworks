import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DashboardViewModel } from "../src/application/tui/dashboard-view-model.ts";
import {
  managementControlHint,
  renderDashboard,
  sanitizeDashboardText,
} from "../src/application/tui/dashboard-renderer.ts";

const view: DashboardViewModel = {
  revision: 9,
  run: {
    id: "run-1",
    title: "Build the live management dashboard",
    complexity: "HIGH",
    status: "active",
    blockedReason: null,
    storyStatusCounts: {
      planned: 0,
      "awaiting-approval": 0,
      ready: 0,
      assigned: 0,
      working: 1,
      "work-complete": 0,
      "awaiting-candidate": 0,
      "awaiting-review": 0,
      "changes-requested": 0,
      approved: 0,
      merging: 0,
      merged: 0,
      blocked: 0,
      failed: 0,
    },
  },
  stories: [
    {
      id: "story-1",
      title: "Management dashboard",
      status: "working",
      branchName: "agentworks/run-1/story-1",
      worktreePath: "/worktrees/story-1",
      assignedAgentId: "agent-1",
      reviewerAgentId: null,
      attention: "info",
    },
  ],
  agents: [
    {
      id: "agent-1",
      role: "software-development/frontend-developer",
      status: "blocked",
      currentOperation: "Waiting for review",
      paneId: "w1P:p9",
      attention: "critical",
    },
  ],
  staleAgents: [],
  supervisorAttention: [
    {
      eventId: "event-1",
      agentId: "agent-1",
      reason: "review required",
      occurredAt: 12,
    },
  ],
};

test("renders useful run, story, agent, next-action, and attention sections", () => {
  const output = renderDashboard(view, {
    width: 120,
    height: 40,
    plannedActions: ["launch-agent:story-1"],
  }).join("\n");
  assert.match(output, /AGENTWORKS {2}run-1 {2}HIGH {2}active {2}rev 9/u);
  assert.match(output, /STORIES \(1\)/u);
  assert.match(output, /Management dashboard/u);
  assert.match(output, /AGENTS \(1\)/u);
  assert.match(output, /Waiting for review/u);
  assert.match(output, /Next\s+launch-agent:story-1/u);
  assert.match(output, /agent-1: review required/u);
  assert.match(output, /p pause {2}f show Pi Agents {2}r refresh {2}q quit/u);
  assert.doesNotMatch(output, /a approve/u);
});

test("renders the selected row and keyboard navigation contract", () => {
  const output = renderDashboard(view, {
    width: 120,
    height: 40,
    selection: { section: "agents", index: 0 },
  }).join("\n");
  assert.match(output, /^> blocked\s+agent-1/mu);
  assert.match(
    output,
    /↑\/k ↓\/j row {2}←\/h →\/l section {2}enter focus agent/u,
  );
});

test("shows only state-valid workflow controls", () => {
  assert.equal(
    managementControlHint("awaiting-approval"),
    "a approve story  A approve all  x reject  f show Pi Agents  r refresh  q quit",
  );
  assert.equal(
    managementControlHint("blocked"),
    "p resume  f show Pi Agents  r refresh  q quit",
  );
  assert.equal(
    managementControlHint("completed"),
    "f show Pi Agents  r refresh  q quit",
  );
});

test("reserves a bottom review panel for the selected proposed story", () => {
  const selectedStory = view.stories[0];
  assert.ok(selectedStory);
  const output = renderDashboard(
    {
      ...view,
      run: { ...view.run, status: "awaiting-approval" },
      stories: [
        {
          ...selectedStory,
          status: "awaiting-approval",
          planning: {
            narrative:
              "As a user, I want a reviewed proposal before work starts so that I can make an informed approval decision.",
            objective:
              "Deliver an independently verifiable management dashboard.",
            taskKinds: ["software-development"],
            writable: true,
            scope: {
              included: ["the management dashboard"],
              excluded: ["unrelated pane behavior"],
            },
            technologyChoices: ["TypeScript", "existing terminal renderer"],
            constraints: ["preserve controller authority"],
            dependencies: [],
            deliverables: ["proposal review panel"],
            acceptanceCriteria: ["the complete story plan is reviewable"],
            validation: [{ command: "npm test", expected: "passes" }],
            escalationConditions: ["approval requirements are ambiguous"],
          },
        },
      ],
    },
    {
      width: 100,
      height: 36,
      selection: { section: "stories", index: 0 },
    },
  ).join("\n");
  assert.match(output, /STORY PLAN {2}story-1 {2}awaiting-approval/u);
  assert.match(output, /USER STORY {2}Management dashboard/u);
  assert.match(output, /reviewed proposal before work starts/u);
  assert.match(output, /ACCEPTANCE CRITERIA/u);
  assert.match(output, /a approve story {2}A approve all/u);
});

test("marks quit-blocking story and agent rows in red-ready form", () => {
  const output = renderDashboard(view, {
    width: 120,
    height: 40,
    quitBlockers: [
      { entityType: "story", entityId: "story-1", status: "working" },
      { entityType: "agent", entityId: "agent-1", status: "blocked" },
    ],
  }).join("\n");
  assert.match(output, /^× working\s+agent-1/mu);
  assert.match(output, /^× blocked\s+agent-1/mu);
});

test("renders the durable launch failure that prevented agent panes", () => {
  const output = renderDashboard(
    {
      ...view,
      run: {
        ...view.run,
        status: "blocked",
        blockedReason: "initial orchestration failed: Integration base changed",
      },
    },
    { width: 120, height: 40 },
  ).join("\n");
  assert.match(output, /RUN: initial orchestration failed/u);
});

test("never exceeds the requested terminal width or height", () => {
  const lines = renderDashboard(view, { width: 32, height: 8 });
  assert.equal(lines.length, 8);
  assert.ok(lines.every((line) => visibleWidth(line) <= 32));
});

test("strips terminal controls from all controller presentation text", () => {
  const hostile: DashboardViewModel = {
    ...view,
    run: { ...view.run, title: "safe\u001b[2J\u009b31m title" },
    supervisorAttention: [
      {
        eventId: "event-2",
        agentId: "agent\n2",
        reason: "request\u0007 approval",
        occurredAt: 14,
      },
    ],
  };
  const output = renderDashboard(hostile, { width: 120, height: 40 }).join(
    "\n",
  );
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.includes("\u009b"), false);
  assert.equal(output.includes("\u0007"), false);
  assert.match(output, /safe \[2J 31m title/u);
  assert.match(output, /agent 2: request {2}approval/u);
  assert.equal(sanitizeDashboardText("a\u0000b\u009fc"), "a b c");
});
