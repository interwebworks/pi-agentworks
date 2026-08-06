import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { assertSafeWorkspaceId } from "../../domain/workspace-naming.ts";
import type { PrivateSessionProvider } from "../../application/launch/herdr-session-evidence-adapter.ts";
import type { PrivateSessionEvidence } from "../../application/launch/assignment-resource-evidence.ts";

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export class PrivateAgentSessionProviderError extends Error {
  constructor(message: string) {
    super(`Private agent session provider failed: ${message}`);
    this.name = "PrivateAgentSessionProviderError";
  }
}

function assertPrivateDirectory(path: string, label: string): void {
  const link = lstatSync(path);
  if (link.isSymbolicLink() || !link.isDirectory()) {
    throw new PrivateAgentSessionProviderError(
      `${label} must be a real directory`,
    );
  }
  const details = lstatSync(path);
  if (details.uid !== process.getuid?.() || (details.mode & 0o077) !== 0) {
    throw new PrivateAgentSessionProviderError(
      `${label} must be private and controller-owned`,
    );
  }
  chmodSync(path, 0o700);
}

function assertWithin(candidate: string, parent: string): void {
  const relativePath = relative(parent, candidate);
  if (
    relativePath.startsWith("..") ||
    relativePath.includes(".." + "/") ||
    resolve(candidate) === resolve(parent)
  ) {
    throw new PrivateAgentSessionProviderError(
      "session path escapes the configured private root",
    );
  }
}

export class PrivateAgentSessionProvider implements PrivateSessionProvider {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(this.#root, "private session root");
  }

  create(
    run: { readonly id: string },
    story: { readonly id: string },
    agentId: string,
  ): Promise<PrivateSessionEvidence> {
    try {
      assertSafeWorkspaceId(run.id, "run id");
      assertSafeWorkspaceId(story.id, "story id");
      assertSafeWorkspaceId(agentId, "agent id");
    } catch (error) {
      throw new PrivateAgentSessionProviderError(
        error instanceof Error ? error.message : "identity is unsafe",
      );
    }
    const runDirectory = join(this.#root, run.id);
    const sessionPath = join(runDirectory, `${story.id}-${agentId}`);
    const configPath = join(sessionPath, "config");
    assertWithin(sessionPath, this.#root);
    const existed = existsSync(sessionPath);
    try {
      mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
      assertPrivateDirectory(sessionPath, "agent session path");
      mkdirSync(configPath, { recursive: true, mode: 0o700 });
      assertPrivateDirectory(configPath, "agent config path");
      const capabilityPath = join(
        sessionPath,
        "controller-child-capability.token",
      );
      let capability: string;
      if (existsSync(capabilityPath)) {
        const status = lstatSync(capabilityPath);
        if (status.isSymbolicLink() || !status.isFile()) {
          throw new PrivateAgentSessionProviderError(
            "capability path is not a regular file",
          );
        }
        capability = readFileSync(capabilityPath, "utf8").trim();
      } else {
        capability = randomBytes(32).toString("base64url");
        writeFileSync(capabilityPath, `${capability}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      }
      if (!CAPABILITY_PATTERN.test(capability)) {
        throw new PrivateAgentSessionProviderError(
          "controller child capability has invalid format",
        );
      }
      return Promise.resolve(
        Object.freeze({
          sessionPath,
          configPath,
          controllerChildAuthToken: capability,
        }),
      );
    } catch (error) {
      if (!existed) {
        rmSync(sessionPath, { recursive: true, force: true });
      }
      throw error;
    }
  }

  cleanup(session: PrivateSessionEvidence, reason: string): Promise<void> {
    void reason;
    const sessionPath = resolve(session.sessionPath);
    assertWithin(sessionPath, this.#root);
    if (existsSync(sessionPath)) {
      assertPrivateDirectory(sessionPath, "agent session path");
      rmSync(sessionPath, { recursive: true, force: false });
    }
    return Promise.resolve();
  }
}
