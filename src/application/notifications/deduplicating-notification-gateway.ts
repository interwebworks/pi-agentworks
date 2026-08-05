import { createHash } from "node:crypto";
import type {
  HerdrGateway,
  HerdrNotificationPosition,
  HerdrNotificationReason,
  HerdrNotificationSound,
} from "../ports/herdr-gateway.ts";

export type AgentworksAlertSeverity =
  "info" | "success" | "attention" | "failure";

export interface AgentworksAlert {
  readonly deduplicationKey: string;
  readonly severity: AgentworksAlertSeverity;
  readonly title: string;
  readonly body?: string;
  readonly position?: HerdrNotificationPosition;
  readonly deduplicationWindowMs?: number;
}

export interface AgentworksAlertResult {
  readonly outcome: "shown" | "not-shown" | "suppressed";
  readonly reason: HerdrNotificationReason | "duplicate";
  readonly sound: HerdrNotificationSound;
  readonly fingerprint: string;
}

export interface AgentworksNotificationGateway {
  notify(alert: AgentworksAlert): Promise<AgentworksAlertResult>;
}

type NotificationHerdrGateway = Pick<HerdrGateway, "showNotification">;

interface DeduplicationEntry {
  readonly fingerprint: string;
  readonly expiresAt: number;
}

export interface DeduplicatingNotificationGatewayOptions {
  readonly defaultWindowMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export class InvalidAgentworksAlertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentworksAlertError";
  }
}

const SOUND_BY_SEVERITY: Readonly<
  Record<AgentworksAlertSeverity, HerdrNotificationSound>
> = Object.freeze({
  info: "none",
  success: "done",
  attention: "request",
  failure: "request",
});

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidAgentworksAlertError(
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function boundedText(
  value: string,
  label: string,
  maximumLength: number,
): string {
  if (
    value.length < 1 ||
    value.length > maximumLength ||
    value.includes("\0")
  ) {
    throw new InvalidAgentworksAlertError(`${label} is invalid`);
  }
  return value;
}

function fingerprint(alert: AgentworksAlert): string {
  return createHash("sha256")
    .update(alert.severity)
    .update("\0")
    .update(alert.title)
    .update("\0")
    .update(alert.body ?? "")
    .update("\0")
    .update(alert.position ?? "bottom-right")
    .digest("hex");
}

export class DeduplicatingNotificationGateway implements AgentworksNotificationGateway {
  readonly #herdr: NotificationHerdrGateway;
  readonly #defaultWindowMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, DeduplicationEntry>();
  #queue: Promise<void> = Promise.resolve();

  constructor(
    herdr: NotificationHerdrGateway,
    options: DeduplicatingNotificationGatewayOptions = {},
  ) {
    this.#herdr = herdr;
    this.#defaultWindowMs = positiveSafeInteger(
      options.defaultWindowMs ?? 30_000,
      "default notification window",
    );
    this.#maxEntries = positiveSafeInteger(
      options.maxEntries ?? 1_024,
      "notification deduplication capacity",
    );
    this.#now = options.now ?? Date.now;
  }

  notify(alert: AgentworksAlert): Promise<AgentworksAlertResult> {
    const operation = this.#queue.then(() => this.#notifySerial(alert));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #notifySerial(alert: AgentworksAlert): Promise<AgentworksAlertResult> {
    this.#validate(alert);
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new InvalidAgentworksAlertError(
        "notification clock must return a non-negative safe integer",
      );
    }
    const windowMs = positiveSafeInteger(
      alert.deduplicationWindowMs ?? this.#defaultWindowMs,
      "notification deduplication window",
    );
    if (windowMs > 24 * 60 * 60 * 1_000) {
      throw new InvalidAgentworksAlertError(
        "notification deduplication window cannot exceed one day",
      );
    }
    this.#removeExpired(now);
    const alertFingerprint = fingerprint(alert);
    const existing = this.#entries.get(alert.deduplicationKey);
    const sound = SOUND_BY_SEVERITY[alert.severity];
    if (
      existing?.fingerprint === alertFingerprint &&
      existing.expiresAt > now
    ) {
      return Object.freeze({
        outcome: "suppressed",
        reason: "duplicate",
        sound,
        fingerprint: alertFingerprint,
      });
    }

    const delivery = await this.#herdr.showNotification({
      title: alert.title,
      ...(alert.body === undefined ? {} : { body: alert.body }),
      position: alert.position ?? "bottom-right",
      sound,
    });
    this.#entries.delete(alert.deduplicationKey);
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(alert.deduplicationKey, {
      fingerprint: alertFingerprint,
      expiresAt: now + windowMs,
    });
    return Object.freeze({
      outcome: delivery.shown ? "shown" : "not-shown",
      reason: delivery.reason,
      sound,
      fingerprint: alertFingerprint,
    });
  }

  #validate(alert: AgentworksAlert): void {
    if (!/^[A-Za-z0-9:._/-]{1,256}$/u.test(alert.deduplicationKey)) {
      throw new InvalidAgentworksAlertError(
        "notification deduplication key is invalid",
      );
    }
    boundedText(alert.title, "notification title", 256);
    if (alert.title.startsWith("-")) {
      throw new InvalidAgentworksAlertError(
        "notification title cannot start with a hyphen",
      );
    }
    if (alert.body !== undefined) {
      boundedText(alert.body, "notification body", 4_096);
    }
  }

  #removeExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}
