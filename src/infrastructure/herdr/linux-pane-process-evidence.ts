import { closeSync, constants, openSync, readSync } from "node:fs";
import type { HerdrGateway } from "../../application/ports/herdr-gateway.ts";
import type {
  PaneProcessEvidenceGateway,
  PaneShellEnvironmentEvidence,
} from "../../application/ports/pane-process-evidence.ts";
import { readProcessStartIdentity } from "../controller/controller-runtime.ts";

const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_ENTRIES = 512;

export class PaneProcessEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaneProcessEvidenceError";
  }
}

function readBoundedEnvironment(processId: number): Buffer | null {
  let descriptor: number;
  try {
    descriptor = openSync(
      `/proc/${String(processId)}/environ`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return null;
    }
    throw error;
  }
  try {
    const buffer = Buffer.allocUnsafe(MAX_ENVIRONMENT_BYTES + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > MAX_ENVIRONMENT_BYTES) {
      throw new PaneProcessEvidenceError(
        "Pane shell environment exceeds the evidence limit",
      );
    }
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(descriptor);
  }
}

function parseEnvironment(buffer: Buffer): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  const entries = buffer.toString("utf8").split("\0");
  if (entries.at(-1) === "") entries.pop();
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new PaneProcessEvidenceError(
      "Pane shell environment has too many entries",
    );
  }
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      throw new PaneProcessEvidenceError(
        "Pane shell environment contains a malformed entry",
      );
    }
    const name = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || name in environment) {
      throw new PaneProcessEvidenceError(
        "Pane shell environment contains an invalid or duplicate name",
      );
    }
    environment[name] = entry.slice(separator + 1);
  }
  return Object.freeze(environment);
}

export class LinuxPaneProcessEvidenceGateway implements PaneProcessEvidenceGateway {
  readonly #herdr: Pick<HerdrGateway, "getPaneProcessInfo">;

  constructor(herdr: Pick<HerdrGateway, "getPaneProcessInfo">) {
    this.#herdr = herdr;
  }

  async readShellEnvironment(
    paneId: string,
  ): Promise<PaneShellEnvironmentEvidence | null> {
    const before = await this.#herdr.getPaneProcessInfo(paneId);
    if (before.paneId !== paneId || before.shellPid === null) return null;
    const startIdentity = readProcessStartIdentity(before.shellPid);
    if (startIdentity === null) return null;
    const rawEnvironment = readBoundedEnvironment(before.shellPid);
    if (rawEnvironment === null) return null;
    const after = await this.#herdr.getPaneProcessInfo(paneId);
    const afterStartIdentity =
      after.shellPid === null ? null : readProcessStartIdentity(after.shellPid);
    if (
      after.paneId !== paneId ||
      after.shellPid !== before.shellPid ||
      afterStartIdentity !== startIdentity
    ) {
      throw new PaneProcessEvidenceError(
        "Pane shell identity changed while ownership evidence was read",
      );
    }
    return Object.freeze({
      paneId,
      shellPid: before.shellPid,
      environment: parseEnvironment(rawEnvironment),
    });
  }
}
