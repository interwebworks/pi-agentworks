export const MAX_AGENT_GRID_PANES = 16;

export interface PaneGridCell {
  readonly slot: number;
  readonly row: number;
  readonly column: number;
}

export interface PaneGridSplit {
  readonly parentSlot: number;
  readonly newSlot: number;
  readonly direction: "right" | "down";
  readonly ratio: number;
}

export interface PaneGridPlan {
  readonly paneCount: number;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly cells: readonly PaneGridCell[];
  readonly rowPaneCounts: readonly number[];
  readonly splits: readonly PaneGridSplit[];
}

export class InvalidPaneGridSizeError extends Error {
  constructor(paneCount: number) {
    super(
      `Pane grid size must be an integer from 1 through ${String(MAX_AGENT_GRID_PANES)}; received ${String(paneCount)}`,
    );
    this.name = "InvalidPaneGridSizeError";
  }
}

function appendStableSplits(
  paneCount: number,
): readonly PaneGridSplit[] | null {
  // Agent panes materialize one at a time. These first six plans deliberately
  // share prefixes, so an added agent never turns a prior tiled layout into
  // narrow slivers. Five panes form two half-height columns plus one full-height
  // column, maximizing the smallest usable pane rectangle.
  const splits: readonly PaneGridSplit[] = [
    Object.freeze({
      parentSlot: 0,
      newSlot: 1,
      direction: "right" as const,
      ratio: 0.5,
    }),
    Object.freeze({
      parentSlot: 0,
      newSlot: 2,
      direction: "down" as const,
      ratio: 0.5,
    }),
    Object.freeze({
      parentSlot: 1,
      newSlot: 3,
      direction: "right" as const,
      ratio: 0.5,
    }),
    Object.freeze({
      parentSlot: 1,
      newSlot: 4,
      direction: "down" as const,
      ratio: 0.5,
    }),
    Object.freeze({
      parentSlot: 3,
      newSlot: 5,
      direction: "down" as const,
      ratio: 0.5,
    }),
  ];
  return paneCount <= 6 ? splits.slice(0, paneCount - 1) : null;
}

export function planPaneGrid(paneCount: number): PaneGridPlan {
  if (
    !Number.isSafeInteger(paneCount) ||
    paneCount < 1 ||
    paneCount > MAX_AGENT_GRID_PANES
  ) {
    throw new InvalidPaneGridSizeError(paneCount);
  }

  const columnCount = Math.ceil(Math.sqrt(paneCount));
  const rowCount = Math.ceil(paneCount / columnCount);
  const baseRowSize = Math.floor(paneCount / rowCount);
  const largerRows = paneCount % rowCount;
  const rowPaneCounts = Array.from(
    { length: rowCount },
    (_, row) => baseRowSize + (row < largerRows ? 1 : 0),
  );
  const rowStarts: number[] = [];
  let nextSlot = 0;
  for (const rowSize of rowPaneCounts) {
    rowStarts.push(nextSlot);
    nextSlot += rowSize;
  }

  const splits: PaneGridSplit[] = [];
  let remainingRowParent = 0;
  for (let row = 1; row < rowCount; row += 1) {
    const remainingRows = rowCount - row + 1;
    const rowStart = rowStarts[row];
    if (rowStart === undefined) throw new InvalidPaneGridSizeError(paneCount);
    splits.push(
      Object.freeze({
        parentSlot: remainingRowParent,
        newSlot: rowStart,
        direction: "down",
        ratio: 1 / remainingRows,
      }),
    );
    remainingRowParent = rowStart;
  }

  const cells: PaneGridCell[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const rowStart = rowStarts[row];
    const rowSize = rowPaneCounts[row];
    if (rowStart === undefined || rowSize === undefined) {
      throw new InvalidPaneGridSizeError(paneCount);
    }
    let remainingColumnParent = rowStart;
    for (let column = 0; column < rowSize; column += 1) {
      const slot = rowStart + column;
      cells.push(Object.freeze({ slot, row, column }));
      if (column === 0) continue;
      const remainingColumns = rowSize - column + 1;
      splits.push(
        Object.freeze({
          parentSlot: remainingColumnParent,
          newSlot: slot,
          direction: "right",
          ratio: 1 / remainingColumns,
        }),
      );
      remainingColumnParent = slot;
    }
  }

  return Object.freeze({
    paneCount,
    rowCount,
    columnCount,
    cells: Object.freeze(cells),
    rowPaneCounts: Object.freeze(rowPaneCounts),
    splits: Object.freeze(appendStableSplits(paneCount) ?? splits),
  });
}
