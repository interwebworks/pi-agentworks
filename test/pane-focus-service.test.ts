import assert from "node:assert/strict";
import test from "node:test";
import type {
  HerdrFocusDirection,
  HerdrPaneFocusResult,
  HerdrPaneLayout,
} from "../src/application/ports/herdr-gateway.ts";
import {
  PaneFocusError,
  PaneFocusService,
} from "../src/application/herdr/pane-focus-service.ts";

function layout(focusedPaneId = "w1P:p0"): HerdrPaneLayout {
  return {
    workspaceId: "w1P",
    tabId: "w1P:tA",
    zoomed: false,
    area: { x: 0, y: 0, width: 100, height: 100 },
    focusedPaneId,
    panes: [
      {
        paneId: "w1P:p0",
        focused: focusedPaneId === "w1P:p0",
        rect: { x: 0, y: 0, width: 50, height: 50 },
      },
      {
        paneId: "w1P:p1",
        focused: focusedPaneId === "w1P:p1",
        rect: { x: 50, y: 0, width: 50, height: 50 },
      },
      {
        paneId: "w1P:p2",
        focused: focusedPaneId === "w1P:p2",
        rect: { x: 0, y: 50, width: 50, height: 50 },
      },
      {
        paneId: "w1P:p3",
        focused: focusedPaneId === "w1P:p3",
        rect: { x: 50, y: 50, width: 50, height: 50 },
      },
    ],
    splits: [],
  };
}

class FakeFocusHerdr {
  currentLayout: HerdrPaneLayout;
  readonly moves: { paneId: string; direction: HerdrFocusDirection }[] = [];
  readonly focusedTabs: string[] = [];
  tamperIdentity = false;

  constructor(initial: HerdrPaneLayout) {
    this.currentLayout = initial;
  }

  getPaneLayout(): Promise<HerdrPaneLayout> {
    return Promise.resolve(this.currentLayout);
  }

  focusTab(tabId: string): Promise<void> {
    this.focusedTabs.push(tabId);
    return Promise.resolve();
  }

  focusPaneNeighbor(
    paneId: string,
    direction: HerdrFocusDirection,
  ): Promise<HerdrPaneFocusResult> {
    this.moves.push({ paneId, direction });
    const reachesTarget = paneId === "w1P:p2" && direction === "right";
    const focusedPaneId = reachesTarget ? "w1P:p3" : "w1P:p2";
    this.currentLayout = {
      ...layout(focusedPaneId),
      workspaceId: this.tamperIdentity ? "w9X" : "w1P",
    };
    return Promise.resolve({
      changed: true,
      sourcePaneId: paneId,
      focusedPaneId,
      reason: null,
      layout: this.currentLayout,
    });
  }
}

test("selects an exact target through bounded adjacent directional focus then focuses its tab", async () => {
  const herdr = new FakeFocusHerdr(layout());
  const evidence = await new PaneFocusService(herdr).focus("w1P:p3");
  assert.deepEqual(evidence, {
    paneId: "w1P:p3",
    tabId: "w1P:tA",
    workspaceId: "w1P",
    directionalAttempts: 2,
  });
  assert.deepEqual(herdr.moves, [
    { paneId: "w1P:p1", direction: "down" },
    { paneId: "w1P:p2", direction: "right" },
  ]);
  assert.deepEqual(herdr.focusedTabs, ["w1P:tA"]);
});

test("a tab whose exact pane is already selected needs no directional move", async () => {
  const herdr = new FakeFocusHerdr(layout("w1P:p3"));
  const evidence = await new PaneFocusService(herdr).focus("w1P:p3");
  assert.equal(evidence.directionalAttempts, 0);
  assert.equal(herdr.moves.length, 0);
  assert.deepEqual(herdr.focusedTabs, ["w1P:tA"]);
});

test("fails closed when geometry has no neighbor or Herdr changes identity", async () => {
  const firstPane = layout().panes[0];
  assert.ok(firstPane);
  const isolated: HerdrPaneLayout = {
    ...layout(),
    panes: [
      firstPane,
      {
        paneId: "w1P:p9",
        focused: false,
        rect: { x: 75, y: 75, width: 10, height: 10 },
      },
    ],
  };
  await assert.rejects(
    new PaneFocusService(new FakeFocusHerdr(isolated)).focus("w1P:p9"),
    PaneFocusError,
  );

  const tampered = new FakeFocusHerdr(layout());
  tampered.tamperIdentity = true;
  await assert.rejects(
    new PaneFocusService(tampered).focus("w1P:p3"),
    /changed source, tab, or workspace/u,
  );
});
