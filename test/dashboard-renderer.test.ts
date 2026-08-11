import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DashboardViewModel } from "../src/application/tui/dashboard-view-model.ts";
import {
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
  assert.match(output, /q quit {2}r refresh/u);
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
