import assert from "node:assert/strict";
import test from "node:test";
import { sessionStarted } from "../src/domain/agent-communication.ts";
import { encodeAgentMessage } from "../src/domain/agent-message-codec.ts";
import type { JsonValue } from "../src/application/ports/controller-repository.ts";
import {
  decodeAuthenticatedAgentMessage,
  InvalidAgentMessageRouteError,
} from "../src/application/protocol/agent-message-routing.ts";

test("authenticated message routing accepts a matching child identity", () => {
  const message = sessionStarted("run-1", "agent-1", "session-1");
  const payload = JSON.parse(encodeAgentMessage(message)) as JsonValue;
  assert.deepEqual(
    decodeAuthenticatedAgentMessage(payload, "run-1", "agent-1"),
    message,
  );
});

test("authenticated message routing rejects malformed payloads", () => {
  assert.throws(
    () =>
      decodeAuthenticatedAgentMessage(
        { type: "heartbeat" },
        "run-1",
        "agent-1",
      ),
    InvalidAgentMessageRouteError,
  );
});

test("authenticated message routing rejects identity drift", () => {
  const message = sessionStarted("run-1", "agent-1", "session-1");
  const payload = JSON.parse(encodeAgentMessage(message)) as JsonValue;
  assert.throws(
    () => decodeAuthenticatedAgentMessage(payload, "run-2", "agent-1"),
    /identity does not match/u,
  );
});
