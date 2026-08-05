import type {
  HerdrFocusDirection,
  HerdrGateway,
  HerdrPaneLayout,
  HerdrRect,
} from "../ports/herdr-gateway.ts";

interface FocusCandidate {
  readonly sourcePaneId: string;
  readonly direction: HerdrFocusDirection;
  readonly overlap: number;
  readonly centerDistance: number;
}

type FocusHerdrGateway = Pick<
  HerdrGateway,
  "focusPaneNeighbor" | "focusTab" | "getPaneLayout"
>;

export interface PaneFocusEvidence {
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly directionalAttempts: number;
}

export class PaneFocusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaneFocusError";
  }
}

function overlap(
  firstStart: number,
  firstSize: number,
  secondStart: number,
  secondSize: number,
): number {
  return Math.max(
    0,
    Math.min(firstStart + firstSize, secondStart + secondSize) -
      Math.max(firstStart, secondStart),
  );
}

function centerDistance(first: HerdrRect, second: HerdrRect): number {
  const firstX = first.x + first.width / 2;
  const firstY = first.y + first.height / 2;
  const secondX = second.x + second.width / 2;
  const secondY = second.y + second.height / 2;
  return Math.abs(firstX - secondX) + Math.abs(firstY - secondY);
}

function candidate(
  sourcePaneId: string,
  source: HerdrRect,
  target: HerdrRect,
): FocusCandidate | null {
  const verticalOverlap = overlap(
    source.y,
    source.height,
    target.y,
    target.height,
  );
  const horizontalOverlap = overlap(
    source.x,
    source.width,
    target.x,
    target.width,
  );
  if (source.x + source.width === target.x && verticalOverlap > 0) {
    return {
      sourcePaneId,
      direction: "right",
      overlap: verticalOverlap,
      centerDistance: centerDistance(source, target),
    };
  }
  if (target.x + target.width === source.x && verticalOverlap > 0) {
    return {
      sourcePaneId,
      direction: "left",
      overlap: verticalOverlap,
      centerDistance: centerDistance(source, target),
    };
  }
  if (source.y + source.height === target.y && horizontalOverlap > 0) {
    return {
      sourcePaneId,
      direction: "down",
      overlap: horizontalOverlap,
      centerDistance: centerDistance(source, target),
    };
  }
  if (target.y + target.height === source.y && horizontalOverlap > 0) {
    return {
      sourcePaneId,
      direction: "up",
      overlap: horizontalOverlap,
      centerDistance: centerDistance(source, target),
    };
  }
  return null;
}

function assertLayoutTarget(layout: HerdrPaneLayout, paneId: string): void {
  if (!layout.panes.some((pane) => pane.paneId === paneId)) {
    throw new PaneFocusError(
      "Target pane is absent from the live Herdr layout",
    );
  }
}

export class PaneFocusService {
  readonly #herdr: FocusHerdrGateway;

  constructor(herdr: FocusHerdrGateway) {
    this.#herdr = herdr;
  }

  async focus(paneId: string): Promise<PaneFocusEvidence> {
    const initial = await this.#herdr.getPaneLayout(paneId);
    assertLayoutTarget(initial, paneId);
    let attempts = 0;
    if (initial.focusedPaneId !== paneId) {
      const target = initial.panes.find((pane) => pane.paneId === paneId);
      if (target === undefined) {
        throw new PaneFocusError("Target pane rectangle is unavailable");
      }
      const candidates = initial.panes
        .filter((pane) => pane.paneId !== paneId)
        .map((pane) => candidate(pane.paneId, pane.rect, target.rect))
        .filter((value): value is FocusCandidate => value !== null)
        .sort(
          (left, right) =>
            right.overlap - left.overlap ||
            left.centerDistance - right.centerDistance ||
            left.sourcePaneId.localeCompare(right.sourcePaneId),
        );
      if (candidates.length === 0) {
        throw new PaneFocusError(
          "Target pane has no directional neighbor in a multi-pane tab",
        );
      }
      let focused = false;
      for (const move of candidates) {
        const result = await this.#herdr.focusPaneNeighbor(
          move.sourcePaneId,
          move.direction,
        );
        attempts += 1;
        if (
          result.sourcePaneId !== move.sourcePaneId ||
          result.layout.tabId !== initial.tabId ||
          result.layout.workspaceId !== initial.workspaceId
        ) {
          throw new PaneFocusError(
            "Herdr focus response changed source, tab, or workspace identity",
          );
        }
        if (result.focusedPaneId === paneId) {
          focused = true;
          break;
        }
      }
      if (!focused) {
        throw new PaneFocusError(
          "Directional Herdr focus could not select the exact target pane",
        );
      }
    }

    await this.#herdr.focusTab(initial.tabId);
    const verified = await this.#herdr.getPaneLayout(paneId);
    if (
      verified.tabId !== initial.tabId ||
      verified.workspaceId !== initial.workspaceId ||
      verified.focusedPaneId !== paneId
    ) {
      throw new PaneFocusError(
        "Herdr did not retain the exact pane focus after focusing its tab",
      );
    }
    return Object.freeze({
      paneId,
      tabId: verified.tabId,
      workspaceId: verified.workspaceId,
      directionalAttempts: attempts,
    });
  }
}
