import type {
  ControllerEventRecord,
  JsonValue,
} from "../ports/controller-repository.ts";

export interface SupervisorAttentionRow {
  readonly eventId: string;
  readonly agentId: string;
  readonly reason: string;
  readonly occurredAt: number;
}

function reasonFromPayload(
  payload: ControllerEventRecord["payload"],
): string | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const record = payload as Readonly<Record<string, JsonValue>>;
  const reason = record.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

/** Project durable supervisor-attention events into a parent-dashboard view. */
export function projectSupervisorAttention(
  events: readonly ControllerEventRecord[],
): readonly SupervisorAttentionRow[] {
  const rows: SupervisorAttentionRow[] = [];
  for (const event of events) {
    if (event.type !== "supervisor-attention-required") continue;
    const reason = reasonFromPayload(event.payload);
    if (reason === null) continue;
    rows.push(
      Object.freeze({
        eventId: event.eventId,
        agentId: event.entityId,
        reason,
        occurredAt: event.occurredAt,
      }),
    );
  }
  return Object.freeze(rows);
}
