import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentState,
  transitionAgent,
  type AgentState,
} from "../src/domain/controller-state.ts";
import {
  applySort,
  createSectionState,
  resolveAgentPaneFocus,
  scroll,
  select,
  sortBy,
} from "../src/application/tui/dashboard-interaction.ts";

test("createSectionState starts ascending, unscrolled, and unselected", () => {
  const state = createSectionState("title");
  assert.deepEqual(state, {
    sortKey: "title",
    sortDirection: "asc",
    scrollOffset: 0,
    selectedIndex: 0,
  });
});

test("sortBy toggles direction when the same key is chosen again", () => {
  const initial = createSectionState("title");
  const first = sortBy(initial, "title");
  assert.equal(first.sortDirection, "desc");
  const second = sortBy(first, "title");
  assert.equal(second.sortDirection, "asc");
});

test("sortBy resets to ascending when switching to a new key", () => {
  const descending = sortBy(createSectionState("title"), "title");
  assert.equal(descending.sortDirection, "desc");
  const switched = sortBy(descending, "status");
  assert.deepEqual(switched, {
    sortKey: "status",
    sortDirection: "asc",
    scrollOffset: descending.scrollOffset,
    selectedIndex: descending.selectedIndex,
  });
});

test("scroll clamps within 0..rowCount-1", () => {
  const state = createSectionState("title");
  assert.equal(scroll(state, -5, 4).scrollOffset, 0);
  assert.equal(scroll(state, 2, 4).scrollOffset, 2);
  assert.equal(scroll(state, 99, 4).scrollOffset, 3);
  assert.equal(scroll(state, 1, 0).scrollOffset, 0);
});

test("select clamps within 0..rowCount-1", () => {
  const state = createSectionState("title");
  assert.equal(select(state, -1, 5).selectedIndex, 0);
  assert.equal(select(state, 3, 5).selectedIndex, 3);
  assert.equal(select(state, 99, 5).selectedIndex, 4);
  assert.equal(select(state, 0, 0).selectedIndex, 0);
});

interface Row {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
}

test("applySort is a stable sort in both directions", () => {
  const rows: readonly Row[] = [
    { id: "a", title: "beta", priority: 1 },
    { id: "b", title: "alpha", priority: 1 },
    { id: "c", title: "alpha", priority: 2 },
  ];

  const ascendingByTitle = applySort(rows, "title", "asc");
  assert.deepEqual(
    ascendingByTitle.map((row) => row.id),
    ["b", "c", "a"],
  );

  const descendingByTitle = applySort(rows, "title", "desc");
  assert.deepEqual(
    descendingByTitle.map((row) => row.id),
    ["a", "b", "c"],
  );

  // Ties (same priority) must preserve original relative order.
  const byPriority = applySort(rows, "priority", "asc");
  assert.deepEqual(
    byPriority.map((row) => row.id),
    ["a", "b", "c"],
  );
});

test("applySort does not mutate the input array", () => {
  const rows: readonly Row[] = [
    { id: "a", title: "beta", priority: 1 },
    { id: "b", title: "alpha", priority: 2 },
  ];
  applySort(rows, "title", "asc");
  assert.deepEqual(
    rows.map((row) => row.id),
    ["a", "b"],
  );
});

function agentWithPane(id: string, paneId: string | null): AgentState {
  const created = createAgentState({
    id,
    runId: "run-1",
    roleRuntimeId: "software-development/backend-developer",
    taskId: null,
    worktreePath: `/worktrees/run-1/${id}`,
    createdAt: 1_000,
  });
  return paneId === null
    ? created
    : transitionAgent(created, {
        type: "launch-requested",
        at: 1_001,
        paneId,
      });
}

test("resolveAgentPaneFocus returns the selected agent's paneId", () => {
  const agents = [
    agentWithPane("agent-1", "pane-1"),
    agentWithPane("agent-2", "pane-2"),
  ];
  assert.equal(resolveAgentPaneFocus(agents, 0), "pane-1");
  assert.equal(resolveAgentPaneFocus(agents, 1), "pane-2");
});

test("resolveAgentPaneFocus returns null for an unlaunched agent", () => {
  const agents = [agentWithPane("agent-1", null)];
  assert.equal(resolveAgentPaneFocus(agents, 0), null);
});

test("resolveAgentPaneFocus returns null for an out-of-range index", () => {
  const agents = [agentWithPane("agent-1", "pane-1")];
  assert.equal(resolveAgentPaneFocus(agents, 5), null);
  assert.equal(resolveAgentPaneFocus(agents, -1), null);
});
