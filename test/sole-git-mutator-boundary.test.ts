import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProductionSandboxLaunchGate } from "../src/application/sandbox/production-sandbox-launch-gate.ts";
import { BubblewrapCapabilityDoctor } from "../src/infrastructure/sandbox/bubblewrap-capability-doctor.ts";
import { BubblewrapSandboxGateway } from "../src/infrastructure/sandbox/bubblewrap-sandbox-gateway.ts";

const BWRAP = "/usr/bin/bwrap";

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  }).trim();
}

// Live boundary proof: a real Bubblewrap child, planned by the production
// gateway, gets its worktree read-write but the whole Git object/ref store
// read-only. It must be able to edit files yet unable to commit, write refs, or
// write objects — so the controller (which runs outside the sandbox) is the
// sole Git mutator.
test("a sandboxed agent child cannot mutate Git through the production plan", (t) => {
  if (!existsSync(BWRAP)) {
    t.skip("bwrap unavailable");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "agentworks-sole-mutator-"));
  try {
    const checkout = join(root, "checkout");
    execFileSync("git", ["init", "--initial-branch", "main", checkout], {
      stdio: "ignore",
    });
    git(checkout, "config", "user.name", "Agentworks Test");
    git(checkout, "config", "user.email", "agentworks@example.test");
    execFileSync("sh", [
      "-c",
      `printf 'initial\\n' > '${join(checkout, "README.md")}'`,
    ]);
    git(checkout, "add", "README.md");
    git(checkout, "commit", "-m", "Initial commit");

    const worktree = join(root, "story");
    git(checkout, "worktree", "add", "-b", "story", worktree, "HEAD");
    const commonGit = join(checkout, ".git");
    const beforeMain = git(checkout, "rev-parse", "main");
    const beforeStory = git(checkout, "rev-parse", "story");

    const session = join(root, "session");
    const runtime = join(root, "runtime");
    mkdirSync(session);
    mkdirSync(runtime);

    // The child exits 0 only if it could write its worktree yet every Git
    // mutation was refused.
    const script = [
      ": > agent-wrote.txt || exit 20",
      "git -c user.name=c -c user.email=c@c add -A; a=$?",
      "git -c user.name=c -c user.email=c@c commit -m probe; c=$?",
      `printf x >> '${commonGit}/refs/heads/main' 2>/dev/null; r=$?`,
      `printf y >> '${commonGit}/objects/probe' 2>/dev/null; o=$?`,
      '[ -f agent-wrote.txt ] && [ "$a" -ne 0 ] && [ "$c" -ne 0 ] && [ "$r" -ne 0 ] && [ "$o" -ne 0 ] && exit 0',
      "exit 21",
    ].join("\n");

    const gateway = new BubblewrapSandboxGateway(
      new ProductionSandboxLaunchGate(
        new BubblewrapCapabilityDoctor({ executablePath: BWRAP }),
      ),
    );
    const plan = gateway.plan({
      command: "/bin/sh",
      arguments: ["-c", script],
      assignedWorktreePath: worktree,
      worktreeAccess: "read-write",
      gitMetadataPaths: [join(worktree, ".git"), commonGit],
      sessionPath: session,
      runtimePath: runtime,
      readOnlyPaths: [],
      environment: {},
      networkPolicy: "isolated",
    });

    const result = spawnSync(plan.executablePath, [...plan.arguments], {
      env: { ...plan.hostEnvironment },
      encoding: "utf8",
    });

    assert.equal(
      result.status,
      0,
      `child expected to prove Git is unwritable; status=${String(result.status)} stderr=${result.stderr}`,
    );
    // The controller's view of the repository is untouched by the child.
    assert.equal(git(checkout, "rev-parse", "main"), beforeMain);
    assert.equal(git(checkout, "rev-parse", "story"), beforeStory);
    assert.equal(existsSync(join(worktree, "agent-wrote.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
