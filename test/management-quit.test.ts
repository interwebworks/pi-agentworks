import assert from "node:assert/strict";
import test from "node:test";
import { assessManagementQuitReadiness } from "../src/domain/management-quit.ts";

test("management quit permits completed agent work with quiescent agents", () => {
  assert.deepEqual(
    assessManagementQuitReadiness({
      run: { id: "run-1", status: "active" },
      stories: [{ id: "story-1", status: "work-complete" }],
      agents: [{ id: "agent-1", status: "idle" }],
    }),
    { canQuit: true, blockers: [] },
  );
});

test("management quit identifies unfinished and unhealthy rows", () => {
  assert.deepEqual(
    assessManagementQuitReadiness({
      run: { id: "run-1", status: "blocked" },
      stories: [{ id: "story-1", status: "working" }],
      agents: [{ id: "agent-1", status: "blocked" }],
    }).blockers,
    [
      { entityType: "run", entityId: "run-1", status: "blocked" },
      { entityType: "story", entityId: "story-1", status: "working" },
      { entityType: "agent", entityId: "agent-1", status: "blocked" },
    ],
  );
});
