import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PrivateAgentSessionProvider,
  PrivateAgentSessionProviderError,
} from "../src/infrastructure/launch/private-agent-session-provider.ts";

test("private session provider creates private idempotent session evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-session-"));
  const provider = new PrivateAgentSessionProvider(root);
  const first = await provider.create(
    { id: "run-1" },
    { id: "story-1" },
    "agent-1",
  );
  const second = await provider.create(
    { id: "run-1" },
    { id: "story-1" },
    "agent-1",
  );

  assert.equal(first.sessionPath, second.sessionPath);
  assert.equal(first.controllerChildAuthToken, second.controllerChildAuthToken);
  assert.match(first.controllerChildAuthToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((lstatSync(first.sessionPath).mode & 0o077) === 0, true);

  await provider.cleanup(first, "test cleanup");
  assert.equal(existsSync(first.sessionPath), false);
});

test("private session provider rejects unsafe identities", () => {
  const root = mkdtempSync(join(tmpdir(), "agentworks-session-"));
  const provider = new PrivateAgentSessionProvider(root);
  assert.throws(
    () => provider.create({ id: "../escape" }, { id: "story-1" }, "agent-1"),
    PrivateAgentSessionProviderError,
  );
});
