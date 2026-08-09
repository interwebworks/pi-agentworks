import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsNeedingRestoration,
  assessAgentConnections,
  type ExpectedAgentPane,
  type LivePaneEvidence,
} from "../src/domain/agent-connection.ts";

function agent(overrides: Partial<ExpectedAgentPane>): ExpectedAgentPane {
  return {
    agentId: "agent-1",
    paneId: "w1P:pA",
    ownershipToken: "run-1/agent-1",
    sessionPresent: true,
    status: "working",
    ...overrides,
  };
}

function pane(paneId: string, token: string | null): LivePaneEvidence {
  return { paneId, ownershipToken: token };
}

function only<T>(items: readonly T[]): T {
  assert.equal(items.length, 1);
  const item = items[0];
  assert.ok(item);
  return item;
}

test("an owned live pane is connected", () => {
  const result = only(
    assessAgentConnections([agent({})], [pane("w1P:pA", "run-1/agent-1")]),
  );
  assert.equal(result.connection, "connected");
  assert.equal(result.restoration, "none");
});

test("a vanished pane disconnects and resumes when the session survives", () => {
  const result = only(
    assessAgentConnections([agent({ sessionPresent: true })], []),
  );
  assert.equal(result.connection, "disconnected");
  assert.equal(result.restoration, "resume-session");
  assert.match(result.reason, /pane is gone/u);
});

test("a vanished pane with no session relaunches fresh", () => {
  const result = only(
    assessAgentConnections([agent({ sessionPresent: false })], []),
  );
  assert.equal(result.restoration, "relaunch-fresh");
});

test("a reclaimed pane whose token changed is disconnected", () => {
  const result = only(
    assessAgentConnections([agent({})], [pane("w1P:pA", "run-1/intruder")]),
  );
  assert.equal(result.connection, "disconnected");
  assert.match(result.reason, /ownership token/u);
});

test("terminal agents are inactive with nothing to restore", () => {
  for (const status of ["completed", "closed", "failed"]) {
    const result = only(assessAgentConnections([agent({ status })], []));
    assert.equal(result.connection, "inactive");
    assert.equal(result.restoration, "none");
  }
});

test("a durably disconnected agent still plans exact session restoration", () => {
  const result = only(
    assessAgentConnections([agent({ status: "disconnected" })], []),
  );
  assert.equal(result.connection, "disconnected");
  assert.equal(result.restoration, "resume-session");
});

test("restoration filter returns only the agents needing action", () => {
  const assessments = assessAgentConnections(
    [
      agent({ agentId: "a", paneId: "p1", ownershipToken: "t1" }),
      agent({ agentId: "b", paneId: "p2", ownershipToken: "t2" }),
      agent({
        agentId: "c",
        paneId: "p3",
        ownershipToken: "t3",
        status: "closed",
      }),
    ],
    [pane("p1", "t1")],
  );
  const needing = agentsNeedingRestoration(assessments);
  assert.deepEqual(
    needing.map((a) => a.agentId),
    ["b"],
  );
});
