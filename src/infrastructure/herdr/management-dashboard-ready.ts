import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readProcessStartIdentity } from "../controller/controller-runtime.ts";

const READY_FILE_NAME = "management-dashboard-ready.json";
const MAX_READY_BYTES = 4_096;

export interface ManagementDashboardReadyProof {
  readonly runId: string;
  readonly processId: number;
  readonly processStartIdentity: string;
}

export function managementDashboardReadyPath(runtimeDirectory: string): string {
  return join(runtimeDirectory, READY_FILE_NAME);
}

function validProof(value: unknown): value is ManagementDashboardReadyProof {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proof = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(proof).length === 3 &&
    typeof proof.runId === "string" &&
    proof.runId.length > 0 &&
    proof.runId.length <= 64 &&
    typeof proof.processId === "number" &&
    Number.isSafeInteger(proof.processId) &&
    proof.processId > 0 &&
    typeof proof.processStartIdentity === "string" &&
    proof.processStartIdentity.length > 0 &&
    proof.processStartIdentity.length <= 128
  );
}

export function readManagementDashboardReadyProof(
  path: string,
): ManagementDashboardReadyProof | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 2 ||
      stat.size > MAX_READY_BYTES
    ) {
      return null;
    }
    const value = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
    return validProof(value) ? Object.freeze(value) : null;
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

/** Publish proof only after the dashboard has completed an authenticated read. */
export function writeManagementDashboardReadyProof(
  path: string,
  runId: string,
): ManagementDashboardReadyProof {
  const processStartIdentity = readProcessStartIdentity(process.pid);
  if (processStartIdentity === null) {
    throw new Error("Dashboard process start identity is unavailable");
  }
  const proof = Object.freeze({
    runId,
    processId: process.pid,
    processStartIdentity,
  });
  const temporaryPath = join(
    dirname(path),
    `.management-dashboard-ready-${String(process.pid)}.tmp`,
  );
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, JSON.stringify(proof), "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, path);
    return proof;
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary path may not exist after a successful rename.
    }
    throw error;
  }
}
