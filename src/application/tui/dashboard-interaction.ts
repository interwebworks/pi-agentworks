import type { AgentState } from "../../domain/controller-state.ts";

export type SortDirection = "asc" | "desc";

export interface SectionState {
  readonly sortKey: string;
  readonly sortDirection: SortDirection;
  readonly scrollOffset: number;
  readonly selectedIndex: number;
}

export function createSectionState(sortKey: string): SectionState {
  return Object.freeze({
    sortKey,
    sortDirection: "asc",
    scrollOffset: 0,
    selectedIndex: 0,
  });
}

/** Sorting by the active key flips direction; a new key resets to ascending. */
export function sortBy(state: SectionState, key: string): SectionState {
  return Object.freeze({
    ...state,
    sortKey: key,
    sortDirection:
      state.sortKey === key && state.sortDirection === "asc" ? "desc" : "asc",
  });
}

function clampIndex(value: number, rowCount: number): number {
  if (rowCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(value, 0), rowCount - 1);
}

export function scroll(
  state: SectionState,
  delta: number,
  rowCount: number,
): SectionState {
  return Object.freeze({
    ...state,
    scrollOffset: clampIndex(state.scrollOffset + delta, rowCount),
  });
}

export function select(
  state: SectionState,
  index: number,
  rowCount: number,
): SectionState {
  return Object.freeze({
    ...state,
    selectedIndex: clampIndex(index, rowCount),
  });
}

/** Stable sort: ties preserve original row order. */
export function applySort<RowType>(
  rows: readonly RowType[],
  sortKey: keyof RowType,
  direction: SortDirection,
): readonly RowType[] {
  const sign = direction === "asc" ? 1 : -1;
  return Object.freeze(
    rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const leftValue = left.row[sortKey];
        const rightValue = right.row[sortKey];
        if (leftValue < rightValue) {
          return -1 * sign;
        }
        if (leftValue > rightValue) {
          return 1 * sign;
        }
        return left.index - right.index;
      })
      .map((entry) => entry.row),
  );
}

/**
 * Resolves which paneId selecting the agent at `index` should focus.
 * Returns null when the index is out of range or the agent has no pane
 * yet (not launched).
 */
export function resolveAgentPaneFocus(
  agents: readonly AgentState[],
  index: number,
): string | null {
  const agent = agents[index];
  return agent === undefined ? null : agent.paneId;
}
