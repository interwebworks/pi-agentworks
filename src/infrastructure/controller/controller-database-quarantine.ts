import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { ControllerDatabaseIntegrityError } from "./sqlite-controller-repository.ts";

export const CONTROLLER_QUARANTINE_SCHEMA_VERSION = 1 as const;

export const ControllerQuarantineRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CONTROLLER_QUARANTINE_SCHEMA_VERSION),
    occurredAt: Type.Integer({ minimum: 0 }),
    databasePath: Type.String({ minLength: 1 }),
    reason: Type.Union([
      Type.Literal("sqlite-corruption"),
      Type.Literal("persisted-state-invalid"),
    ]),
    quarantinedFiles: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 3,
    }),
  },
  { additionalProperties: false },
);

export interface ControllerQuarantineRecord {
  readonly schemaVersion: typeof CONTROLLER_QUARANTINE_SCHEMA_VERSION;
  readonly occurredAt: number;
  readonly databasePath: string;
  readonly reason: "sqlite-corruption" | "persisted-state-invalid";
  readonly quarantinedFiles: readonly string[];
}

export class ControllerDatabaseQuarantinedError extends Error {
  readonly markerPath: string;

  constructor(markerPath: string) {
    super(
      `Controller database is quarantined; inspect ${markerPath} before recovery`,
    );
    this.name = "ControllerDatabaseQuarantinedError";
    this.markerPath = markerPath;
  }
}

export function isControllerDatabaseCorruption(error: unknown): boolean {
  if (error instanceof ControllerDatabaseIntegrityError) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ERR_SQLITE_CORRUPT" ||
    code === "ERR_SQLITE_NOTADB" ||
    /database disk image is malformed|file is not a database|database corruption/u.test(
      error.message.toLowerCase(),
    )
  );
}

export function readControllerQuarantineRecord(
  markerPath: string,
): ControllerQuarantineRecord | null {
  if (!existsSync(markerPath)) return null;
  const descriptor = openSync(
    markerPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!Check(ControllerQuarantineRecordSchema, value)) {
      throw new ControllerDatabaseQuarantinedError(markerPath);
    }
    return Object.freeze(value);
  } catch (error) {
    if (error instanceof ControllerDatabaseQuarantinedError) throw error;
    throw new ControllerDatabaseQuarantinedError(markerPath);
  } finally {
    closeSync(descriptor);
  }
}

export function assertControllerDatabaseNotQuarantined(
  markerPath: string,
): void {
  if (readControllerQuarantineRecord(markerPath) !== null) {
    throw new ControllerDatabaseQuarantinedError(markerPath);
  }
}

export function quarantineControllerDatabase(input: {
  readonly databasePath: string;
  readonly markerPath: string;
  readonly occurredAt: number;
  readonly reason: ControllerQuarantineRecord["reason"];
}): never {
  if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
    throw new Error("Quarantine timestamp must be a non-negative safe integer");
  }
  if (existsSync(input.markerPath)) {
    throw new ControllerDatabaseQuarantinedError(input.markerPath);
  }

  const suffix = `.corrupt-${String(input.occurredAt)}-${randomUUID()}`;
  const moves = [
    input.databasePath,
    `${input.databasePath}-wal`,
    `${input.databasePath}-shm`,
  ]
    .filter((source) => existsSync(source))
    .map((source) =>
      Object.freeze({ source, destination: `${source}${suffix}` }),
    );
  if (moves.length === 0) {
    throw new Error(
      "No controller database files were available to quarantine",
    );
  }

  const record: ControllerQuarantineRecord = Object.freeze({
    schemaVersion: CONTROLLER_QUARANTINE_SCHEMA_VERSION,
    occurredAt: input.occurredAt,
    databasePath: input.databasePath,
    reason: input.reason,
    quarantinedFiles: Object.freeze(moves.map((move) => move.destination)),
  });
  const temporaryPath = `${input.markerPath}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, input.markerPath);
    chmodSync(input.markerPath, 0o600);
    fsyncDirectory(dirname(input.markerPath));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }

  for (const move of moves) {
    renameSync(move.source, move.destination);
    chmodSync(move.destination, 0o600);
  }
  fsyncDirectory(dirname(input.markerPath));
  throw new ControllerDatabaseQuarantinedError(input.markerPath);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
