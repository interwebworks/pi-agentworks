import assert from "node:assert/strict";
import test from "node:test";
import type {
  HerdrNotificationRequest,
  HerdrNotificationResult,
} from "../src/application/ports/herdr-gateway.ts";
import {
  DeduplicatingNotificationGateway,
  InvalidAgentworksAlertError,
} from "../src/application/notifications/deduplicating-notification-gateway.ts";

class FakeNotifications {
  readonly requests: HerdrNotificationRequest[] = [];
  result: HerdrNotificationResult = { shown: true, reason: "shown" };
  error: Error | null = null;

  showNotification(
    request: HerdrNotificationRequest,
  ): Promise<HerdrNotificationResult> {
    this.requests.push(request);
    if (this.error !== null) return Promise.reject(this.error);
    return Promise.resolve(this.result);
  }
}

test("maps state severity to Herdr visual/audio delivery and reports evidence", async () => {
  const herdr = new FakeNotifications();
  const gateway = new DeduplicatingNotificationGateway(herdr, {
    now: () => 1_000,
  });
  const severities = [
    ["info", "none"],
    ["success", "done"],
    ["attention", "request"],
    ["failure", "request"],
  ] as const;
  for (const [severity, sound] of severities) {
    const result = await gateway.notify({
      deduplicationKey: `run-1:${severity}`,
      severity,
      title: `Alert ${severity}`,
      body: "Bounded alert body",
    });
    assert.equal(result.outcome, "shown");
    assert.equal(result.reason, "shown");
    assert.equal(result.sound, sound);
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/u);
  }
  assert.deepEqual(
    herdr.requests.map((request) => request.sound),
    ["none", "done", "request", "request"],
  );
  assert.equal(
    herdr.requests.every((request) => request.position === "bottom-right"),
    true,
  );
});

test("concurrent identical alerts produce one delivery while state changes remain visible", async () => {
  const herdr = new FakeNotifications();
  const gateway = new DeduplicatingNotificationGateway(herdr, {
    now: () => 2_000,
  });
  const alert = {
    deduplicationKey: "run-1:story-1:blocked",
    severity: "failure" as const,
    title: "Story blocked",
    body: "Tests failed",
  };
  const [first, second, third] = await Promise.all([
    gateway.notify(alert),
    gateway.notify(alert),
    gateway.notify(alert),
  ]);
  assert.equal(first.outcome, "shown");
  assert.equal(second.outcome, "suppressed");
  assert.equal(third.reason, "duplicate");
  assert.equal(herdr.requests.length, 1);

  const changed = await gateway.notify({
    ...alert,
    body: "Reviewer requested changes",
  });
  assert.equal(changed.outcome, "shown");
  assert.equal(herdr.requests.length, 2);
});

test("expiry, bounded eviction, and non-shown Herdr reasons remain deterministic", async () => {
  let now = 10_000;
  const herdr = new FakeNotifications();
  herdr.result = { shown: false, reason: "no_foreground_client" };
  const gateway = new DeduplicatingNotificationGateway(herdr, {
    now: () => now,
    defaultWindowMs: 100,
    maxEntries: 2,
  });
  const send = (key: string) =>
    gateway.notify({
      deduplicationKey: key,
      severity: "info",
      title: `Alert ${key}`,
    });

  const first = await send("a");
  const duplicate = await send("a");
  assert.equal(first.outcome, "not-shown");
  assert.equal(first.reason, "no_foreground_client");
  assert.equal(first.sound, "none");
  assert.equal(duplicate.outcome, "suppressed");
  assert.equal(duplicate.fingerprint, first.fingerprint);
  assert.equal(herdr.requests.length, 1);
  await send("b");
  await send("c");
  await send("a");
  assert.equal(herdr.requests.length, 4);

  now += 101;
  await send("a");
  assert.equal(herdr.requests.length, 5);
});

test("failed delivery is retryable and malformed alert widening is rejected", async () => {
  const herdr = new FakeNotifications();
  const gateway = new DeduplicatingNotificationGateway(herdr, {
    now: () => 1,
  });
  herdr.error = new Error("Herdr unavailable");
  await assert.rejects(
    gateway.notify({
      deduplicationKey: "run-1:error",
      severity: "failure",
      title: "Controller failed",
    }),
    /Herdr unavailable/u,
  );
  herdr.error = null;
  assert.equal(
    (
      await gateway.notify({
        deduplicationKey: "run-1:error",
        severity: "failure",
        title: "Controller failed",
      })
    ).outcome,
    "shown",
  );
  assert.equal(herdr.requests.length, 2);

  await assert.rejects(
    gateway.notify({
      deduplicationKey: "bad key",
      severity: "info",
      title: "Bad",
    }),
    InvalidAgentworksAlertError,
  );
  await assert.rejects(
    gateway.notify({
      deduplicationKey: "valid",
      severity: "info",
      title: "--help",
    }),
    /hyphen/u,
  );
});
