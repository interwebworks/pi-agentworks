import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidPaneGridSizeError,
  MAX_AGENT_GRID_PANES,
  planPaneGrid,
} from "../src/domain/pane-grid.ts";

test("plans balanced deterministic grids for every supported pane count", () => {
  for (let paneCount = 1; paneCount <= MAX_AGENT_GRID_PANES; paneCount += 1) {
    const first = planPaneGrid(paneCount);
    const repeated = planPaneGrid(paneCount);
    assert.deepEqual(repeated, first);
    assert.equal(first.cells.length, paneCount);
    assert.equal(first.splits.length, paneCount - 1);
    assert.equal(
      first.rowPaneCounts.reduce((sum, count) => sum + count, 0),
      paneCount,
    );
    assert.ok(
      Math.max(...first.rowPaneCounts) - Math.min(...first.rowPaneCounts) <= 1,
    );
    assert.equal(new Set(first.cells.map((cell) => cell.slot)).size, paneCount);
    assert.deepEqual(
      [...first.cells].sort((left, right) => left.slot - right.slot),
      first.cells,
    );

    const available = new Set([0]);
    for (const split of first.splits) {
      assert.equal(available.has(split.parentSlot), true);
      assert.equal(available.has(split.newSlot), false);
      assert.ok(split.ratio > 0 && split.ratio < 1);
      available.add(split.newSlot);
    }
    assert.equal(available.size, paneCount);
  }
});

test("agent-grid plans stay append-stable through a complete six-pane tile", () => {
  for (let paneCount = 2; paneCount <= 6; paneCount += 1) {
    assert.deepEqual(
      planPaneGrid(paneCount).splits.slice(0, -1),
      planPaneGrid(paneCount - 1).splits,
    );
  }
  assert.deepEqual(planPaneGrid(5).splits, [
    { parentSlot: 0, newSlot: 1, direction: "right", ratio: 0.5 },
    { parentSlot: 0, newSlot: 2, direction: "down", ratio: 0.5 },
    { parentSlot: 1, newSlot: 3, direction: "right", ratio: 0.5 },
    { parentSlot: 1, newSlot: 4, direction: "down", ratio: 0.5 },
  ]);
});

test("uses expected landscape-biased dimensions at representative sizes", () => {
  assert.deepEqual(planPaneGrid(1).rowPaneCounts, [1]);
  assert.deepEqual(planPaneGrid(2).rowPaneCounts, [2]);
  assert.deepEqual(planPaneGrid(3).rowPaneCounts, [2, 1]);
  assert.deepEqual(planPaneGrid(4).rowPaneCounts, [2, 2]);
  assert.deepEqual(planPaneGrid(6).rowPaneCounts, [3, 3]);
  assert.deepEqual(planPaneGrid(9).rowPaneCounts, [3, 3, 3]);
  assert.deepEqual(planPaneGrid(12).rowPaneCounts, [4, 4, 4]);
  assert.deepEqual(planPaneGrid(16).rowPaneCounts, [4, 4, 4, 4]);
});

test("rejects empty, oversized, fractional, and non-finite grids", () => {
  for (const paneCount of [0, 17, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => planPaneGrid(paneCount), InvalidPaneGridSizeError);
  }
});
