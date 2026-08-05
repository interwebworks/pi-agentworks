import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ProductionSandboxLaunchGate } from "../src/application/sandbox/production-sandbox-launch-gate.ts";
import { BubblewrapCapabilityDoctor } from "../src/infrastructure/sandbox/bubblewrap-capability-doctor.ts";
import {
  BubblewrapSandboxConfigurationError,
  BubblewrapSandboxGateway,
} from "../src/infrastructure/sandbox/bubblewrap-sandbox-gateway.ts";

function gateway(): BubblewrapSandboxGateway {
  return new BubblewrapSandboxGateway(
    new ProductionSandboxLaunchGate(
      new BubblewrapCapabilityDoctor({ executablePath: "/usr/bin/bwrap" }),
    ),
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentworks-sandbox-launch-"));
  const worktree = join(root, "worktree");
  const gitMetadata = join(worktree, ".git");
  const session = join(root, "session");
  const runtime = join(root, "runtime");
  const readOnly = join(root, "read-only");
  const outside = join(root, "outside");
  for (const path of [worktree, session, runtime, readOnly, outside]) {
    mkdirSync(path);
  }
  writeFileSync(gitMetadata, "gitdir: /hidden/common/git\n");
  writeFileSync(join(runtime, "token"), "runtime-token\n");
  writeFileSync(join(readOnly, "resource"), "approved-resource\n");
  writeFileSync(join(outside, "secret"), "outside-secret\n");
  return { root, worktree, gitMetadata, session, runtime, readOnly, outside };
}

const BOUNDARY_SCRIPT = String.raw`
set -eu
test "$PWD" = "$1"
test "$HOME" = "$2"
test "$AGENTWORKS_ALLOWED" = yes
test -z "$(/usr/bin/env | /usr/bin/grep '^PARENT_SECRET=' || true)"
touch "$1/worktree-write"
if printf 'hacked\n' >> "$3" 2>/dev/null; then exit 11; fi
touch "$4/session-write"
test "$(cat "$5/token")" = runtime-token
if touch "$5/runtime-write" 2>/dev/null; then exit 12; fi
test "$(cat "$6/resource")" = approved-resource
if touch "$6/resource" 2>/dev/null; then exit 13; fi
if test -e "$7/secret"; then exit 14; fi
if touch "$7/write" 2>/dev/null; then exit 17; fi
if test -e "$8"; then exit 15; fi
if test -e "$9"; then exit 16; fi
printf 'network=%s\n' "$(readlink /proc/self/ns/net)"
printf 'default_routes=%s\n' "$(/usr/bin/awk 'NR > 1 && $2 == "00000000" { count += 1 } END { print count + 0 }' /proc/net/route)"
`;

test(
  "isolated launch exposes only approved writable and readable boundaries",
  { skip: !existsSync("/usr/bin/bwrap") },
  () => {
    const paths = fixture();
    const homeSecret = join(
      homedir(),
      `.agentworks-sandbox-secret-${String(process.pid)}`,
    );
    writeFileSync(homeSecret, "home-secret\n");
    try {
      const plan = gateway().plan({
        command: "/bin/sh",
        arguments: [
          "-c",
          BOUNDARY_SCRIPT,
          "agentworks-boundary-probe",
          paths.worktree,
          homedir(),
          paths.gitMetadata,
          paths.session,
          paths.runtime,
          paths.readOnly,
          paths.outside,
          homeSecret,
          `/run/user/${String(process.getuid?.() ?? 0)}`,
        ],
        assignedWorktreePath: paths.worktree,
        worktreeAccess: "read-write",
        gitMetadataPaths: [paths.gitMetadata],
        sessionPath: paths.session,
        runtimePath: paths.runtime,
        readOnlyPaths: [paths.readOnly],
        environment: { AGENTWORKS_ALLOWED: "yes" },
        networkPolicy: "isolated",
      });
      assert.equal(plan.evidence.networkIsolated, true);
      assert.equal("PARENT_SECRET" in plan.hostEnvironment, false);

      const result = spawnSync(plan.executablePath, plan.arguments, {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        shell: false,
        env: { ...plan.hostEnvironment, PARENT_SECRET: "must-not-cross" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.notEqual(
        /^network=(.+)$/mu.exec(result.stdout)?.[1],
        readlinkSync("/proc/self/ns/net"),
      );
      assert.match(result.stdout, /^default_routes=0$/mu);
      assert.equal(existsSync(join(paths.worktree, "worktree-write")), true);
      assert.equal(existsSync(join(paths.session, "session-write")), true);
      assert.equal(
        readFileSync(paths.gitMetadata, "utf8"),
        "gitdir: /hidden/common/git\n",
      );
      assert.equal(existsSync(join(paths.runtime, "runtime-write")), false);
      assert.equal(
        readFileSync(join(paths.readOnly, "resource"), "utf8"),
        "approved-resource\n",
      );
      assert.equal(
        readFileSync(join(paths.outside, "secret"), "utf8"),
        "outside-secret\n",
      );
    } finally {
      rmSync(homeSecret, { force: true });
      rmSync(paths.root, { recursive: true, force: true });
    }
  },
);

test(
  "read-only roles cannot mutate their assigned worktree",
  { skip: !existsSync("/usr/bin/bwrap") },
  () => {
    const paths = fixture();
    try {
      const plan = gateway().plan({
        command: "/bin/sh",
        arguments: [
          "-c",
          `if touch '${paths.worktree}/forbidden' 2>/dev/null; then exit 21; fi; touch '${paths.session}/allowed'`,
        ],
        assignedWorktreePath: paths.worktree,
        worktreeAccess: "read-only",
        gitMetadataPaths: [paths.gitMetadata],
        sessionPath: paths.session,
        runtimePath: paths.runtime,
        readOnlyPaths: [],
        environment: {},
        networkPolicy: "isolated",
      });
      assert.equal(plan.evidence.assignedWorktreeWritable, false);
      const result = spawnSync(plan.executablePath, plan.arguments, {
        encoding: "utf8",
        env: plan.hostEnvironment,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(paths.worktree, "forbidden")), false);
      assert.equal(existsSync(join(paths.session, "allowed")), true);
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  },
);

test(
  "network-approved launch retains the host network namespace",
  { skip: !existsSync("/usr/bin/bwrap") },
  () => {
    const paths = fixture();
    try {
      const plan = gateway().plan({
        command: "/bin/sh",
        arguments: ["-c", "readlink /proc/self/ns/net"],
        assignedWorktreePath: paths.worktree,
        worktreeAccess: "read-write",
        gitMetadataPaths: [paths.gitMetadata],
        sessionPath: paths.session,
        runtimePath: paths.runtime,
        readOnlyPaths: [],
        environment: {},
        networkPolicy: "host",
      });
      assert.equal(plan.evidence.networkIsolated, false);
      const result = spawnSync(plan.executablePath, plan.arguments, {
        encoding: "utf8",
        env: plan.hostEnvironment,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), readlinkSync("/proc/self/ns/net"));
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  },
);

test("planner rejects untrusted commands, missing Git metadata, overlap, and environment widening", () => {
  if (!existsSync("/usr/bin/bwrap")) return;
  const paths = fixture();
  try {
    const base = {
      command: "/bin/true",
      arguments: [],
      assignedWorktreePath: paths.worktree,
      worktreeAccess: "read-write" as const,
      gitMetadataPaths: [paths.gitMetadata],
      sessionPath: paths.session,
      runtimePath: paths.runtime,
      readOnlyPaths: [],
      environment: {},
      networkPolicy: "isolated" as const,
    };
    const planner = gateway();
    assert.throws(
      () => planner.plan({ ...base, command: join(paths.worktree, "tool") }),
      BubblewrapSandboxConfigurationError,
    );
    assert.throws(
      () => planner.plan({ ...base, gitMetadataPaths: [] }),
      /at least one Git metadata path/u,
    );
    assert.throws(
      () => planner.plan({ ...base, sessionPath: paths.worktree }),
      /cannot overlap/u,
    );
    assert.throws(
      () => planner.plan({ ...base, environment: { HOME: "/host-home" } }),
      /invalid or reserved/u,
    );
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});
