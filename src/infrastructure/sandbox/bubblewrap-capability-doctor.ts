import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type {
  SandboxCapabilityDoctor,
  SandboxCapabilityProbe,
  SandboxCapabilityReport,
  SandboxProbeName,
} from "../../application/ports/sandbox-capability-doctor.ts";

const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const VERSION_PATTERN = /^bubblewrap (\d+)\.(\d+)\.(\d+)$/u;

const PROBE_SCRIPT = String.raw`
set -u
root=readonly
if touch /agentworks-root-write-probe 2>/dev/null; then
  root=writable
  rm -f /agentworks-root-write-probe
fi
worktree=readonly
if touch /tmp/agentworks-doctor/worktree/probe 2>/dev/null; then
  worktree=writable
fi
git=readonly
if touch /tmp/agentworks-doctor/git/probe 2>/dev/null; then
  git=writable
  rm -f /tmp/agentworks-doctor/git/probe
fi
environment=leaked
if [ "$AGENTWORKS_ALLOWED" = "doctor" ] && ! /usr/bin/env | /usr/bin/grep -q '^AGENTWORKS_DOCTOR_SECRET='; then
  environment=sanitized
fi
printf 'root=%s\n' "$root"
printf 'worktree=%s\n' "$worktree"
printf 'git=%s\n' "$git"
printf 'environment=%s\n' "$environment"
nested_userns=allowed
if ! /usr/bin/unshare --user true 2>/dev/null; then
  nested_userns=disabled
fi
printf 'nested_userns=%s\n' "$nested_userns"
printf 'user=%s\n' "$(readlink /proc/self/ns/user)"
printf 'mount=%s\n' "$(readlink /proc/self/ns/mnt)"
printf 'pid=%s\n' "$(readlink /proc/self/ns/pid)"
printf 'network=%s\n' "$(readlink /proc/self/ns/net)"
`;

export interface BubblewrapCapabilityDoctorOptions {
  readonly executablePath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly clock?: () => number;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function probe(
  name: SandboxProbeName,
  passed: boolean,
  detail: string,
): SandboxCapabilityProbe {
  return Object.freeze({ name, passed, detail });
}

function parseProof(serialized: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of serialized.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator < 1)
      throw new Error("sandbox probe returned malformed output");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (values.has(key))
      throw new Error("sandbox probe returned duplicate output");
    values.set(key, value);
  }
  return values;
}

function namespaceIdentity(name: "user" | "mnt" | "pid" | "net"): string {
  return readlinkSync(`/proc/self/ns/${name}`);
}

function commandDiagnostic(
  error: Error | undefined,
  stderr: string,
  fallback: string,
): string {
  if (error !== undefined && error.message.length > 0) return error.message;
  const normalized = stderr.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export class BubblewrapCapabilityDoctor implements SandboxCapabilityDoctor {
  readonly #requestedExecutablePath: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #clock: () => number;

  constructor(options: BubblewrapCapabilityDoctorOptions = {}) {
    this.#requestedExecutablePath =
      options.executablePath ?? DEFAULT_BWRAP_PATH;
    this.#timeoutMs = positiveSafeInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "sandbox doctor timeout",
    );
    this.#maxOutputBytes = positiveSafeInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "sandbox doctor output limit",
    );
    this.#clock = options.clock ?? Date.now;
  }

  inspect(): SandboxCapabilityReport {
    const checkedAt = this.#clock();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
      throw new Error("sandbox doctor clock returned an invalid timestamp");
    }
    const probes: SandboxCapabilityProbe[] = [];
    const reasons: string[] = [];
    const platformPassed = process.platform === "linux";
    probes.push(
      probe(
        "platform",
        platformPassed,
        platformPassed ? "Linux is available" : "Linux is required",
      ),
    );
    if (!platformPassed) reasons.push("Bubblewrap requires Linux");

    let executablePath: string | null = null;
    let executablePassed = false;
    try {
      if (!isAbsolute(this.#requestedExecutablePath)) {
        throw new Error("path is not absolute");
      }
      executablePath = realpathSync(resolve(this.#requestedExecutablePath));
      const status = statSync(executablePath);
      accessSync(executablePath, constants.X_OK);
      if (!status.isFile()) throw new Error("path is not a regular file");
      if (status.uid !== 0) throw new Error("executable is not owned by root");
      if ((status.mode & 0o022) !== 0) {
        throw new Error("executable is group- or world-writable");
      }
      executablePassed = true;
      probes.push(
        probe("executable", true, `Trusted executable: ${executablePath}`),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      probes.push(probe("executable", false, detail));
      reasons.push(
        `Bubblewrap executable is unavailable or untrusted: ${detail}`,
      );
    }

    let version: string | null = null;
    let versionPassed = false;
    if (executablePassed && executablePath !== null) {
      const result = spawnSync(executablePath, ["--version"], {
        encoding: "utf8",
        timeout: this.#timeoutMs,
        maxBuffer: this.#maxOutputBytes,
        shell: false,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      });
      const output = result.stdout.trim();
      if (
        result.error === undefined &&
        result.status === 0 &&
        VERSION_PATTERN.test(output)
      ) {
        version = output.slice("bubblewrap ".length);
        versionPassed = true;
        probes.push(probe("version", true, `Bubblewrap ${version}`));
      } else {
        const detail = commandDiagnostic(
          result.error,
          result.stderr,
          "invalid version output",
        );
        probes.push(probe("version", false, detail));
        reasons.push(`Bubblewrap version check failed: ${detail}`);
      }
    } else {
      probes.push(probe("version", false, "Executable check did not pass"));
      reasons.push("Bubblewrap version could not be checked");
    }

    if (
      !platformPassed ||
      !executablePassed ||
      !versionPassed ||
      executablePath === null
    ) {
      return this.#report(checkedAt, executablePath, version, probes, reasons);
    }

    const directory = mkdtempSync(join(tmpdir(), "agentworks-bwrap-doctor-"));
    const worktreeSource = join(directory, "worktree");
    const gitSource = join(directory, "git-metadata");
    mkdirSync(worktreeSource, { mode: 0o700 });
    mkdirSync(gitSource, { mode: 0o700 });
    const canary = randomBytes(24).toString("hex");
    try {
      const result = spawnSync(
        executablePath,
        [
          "--die-with-parent",
          "--new-session",
          "--unshare-user",
          "--disable-userns",
          "--unshare-pid",
          "--unshare-uts",
          "--unshare-ipc",
          "--unshare-net",
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--tmpfs",
          "/tmp",
          "--dir",
          "/tmp/agentworks-doctor",
          "--ro-bind",
          gitSource,
          "/tmp/agentworks-doctor/git",
          "--bind",
          worktreeSource,
          "/tmp/agentworks-doctor/worktree",
          "--clearenv",
          "--setenv",
          "PATH",
          "/usr/bin:/bin",
          "--setenv",
          "AGENTWORKS_ALLOWED",
          "doctor",
          "/bin/sh",
          "-c",
          PROBE_SCRIPT,
        ],
        {
          encoding: "utf8",
          timeout: this.#timeoutMs,
          maxBuffer: this.#maxOutputBytes,
          shell: false,
          env: {
            PATH: "/usr/bin:/bin",
            LC_ALL: "C",
            AGENTWORKS_DOCTOR_SECRET: canary,
          },
        },
      );
      if (result.error !== undefined || result.status !== 0) {
        const detail = commandDiagnostic(
          result.error,
          result.stderr,
          "probe process failed",
        );
        this.#appendFailedBoundaryProbes(probes, reasons, detail);
      } else {
        const proof = parseProof(result.stdout);
        this.#appendBoundaryProbes(probes, reasons, proof, worktreeSource);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#appendFailedBoundaryProbes(probes, reasons, detail);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    return this.#report(checkedAt, executablePath, version, probes, reasons);
  }

  #appendBoundaryProbes(
    probes: SandboxCapabilityProbe[],
    reasons: string[],
    proof: ReadonlyMap<string, string>,
    worktreeSource: string,
  ): void {
    const namespaceChecks: readonly [
      SandboxProbeName,
      string,
      "user" | "mnt" | "pid" | "net",
    ][] = [
      ["user-namespace", "user", "user"],
      ["mount-namespace", "mount", "mnt"],
      ["pid-namespace", "pid", "pid"],
      ["network-namespace", "network", "net"],
    ];
    for (const [name, key, hostName] of namespaceChecks) {
      const childIdentity = proof.get(key);
      const passed =
        childIdentity !== undefined &&
        childIdentity !== namespaceIdentity(hostName);
      probes.push(
        probe(
          name,
          passed,
          passed ? "Child namespace is distinct" : "Namespace was not isolated",
        ),
      );
      if (!passed) reasons.push(`${name} probe failed`);
    }

    const boundaries: readonly [SandboxProbeName, boolean, string][] = [
      [
        "nested-user-namespace-disabled",
        proof.get("nested_userns") === "disabled",
        "nested user namespace",
      ],
      ["root-read-only", proof.get("root") === "readonly", "host root"],
      [
        "assigned-worktree-writable",
        proof.get("worktree") === "writable" &&
          existsSync(join(worktreeSource, "probe")),
        "assigned worktree",
      ],
      [
        "git-metadata-read-only",
        proof.get("git") === "readonly",
        "Git metadata",
      ],
      [
        "environment-sanitized",
        proof.get("environment") === "sanitized",
        "child environment",
      ],
    ];
    for (const [name, passed, label] of boundaries) {
      probes.push(
        probe(
          name,
          passed,
          passed ? `${label} boundary passed` : `${label} boundary failed`,
        ),
      );
      if (!passed) reasons.push(`${label} boundary probe failed`);
    }
  }

  #appendFailedBoundaryProbes(
    probes: SandboxCapabilityProbe[],
    reasons: string[],
    detail: string,
  ): void {
    const names: readonly SandboxProbeName[] = [
      "user-namespace",
      "nested-user-namespace-disabled",
      "mount-namespace",
      "pid-namespace",
      "network-namespace",
      "root-read-only",
      "assigned-worktree-writable",
      "git-metadata-read-only",
      "environment-sanitized",
    ];
    for (const name of names) probes.push(probe(name, false, detail));
    reasons.push(`Bubblewrap boundary probe failed: ${detail}`);
  }

  #report(
    checkedAt: number,
    executablePath: string | null,
    version: string | null,
    probes: readonly SandboxCapabilityProbe[],
    reasons: readonly string[],
  ): SandboxCapabilityReport {
    const supported =
      probes.length === 12 && probes.every((item) => item.passed);
    return Object.freeze({
      adapter: "bubblewrap",
      supported,
      executablePath,
      version,
      checkedAt,
      evidence: supported
        ? Object.freeze({
            kind: "bubblewrap",
            filesystemBoundary: "kernel-enforced",
            rootReadOnly: true,
            assignedWorktreeWritable: true,
            gitMetadataReadOnly: true,
            environmentSanitized: true,
            networkIsolated: true,
          })
        : null,
      probes: Object.freeze([...probes]),
      reasons: Object.freeze([...reasons]),
    });
  }
}
