# Agentworks Security Model

## Security objective

Agentworks must preserve the target repository, host credentials, unrelated files, and Git history even when an agent is mistaken, compromised, or follows a malicious project prompt.
System prompts, tool allowlists, and a process working directory are behavioral controls, not security boundaries.
Agentworks therefore fails closed unless it can enforce the required boundary outside the model process.

## Trust boundaries

The parent Pi extension has the user's host permissions and is trusted Agentworks code.
The controller has the minimum host authority needed to manage state, Herdr, and Git worktrees.
Role packs, project instructions, task text, model output, and child Pi processes are untrusted inputs.
Herdr terminal output is presentation data and is never a control protocol.
The child bridge protocol is authenticated, bounded, versioned, and tied to one run and agent identity.

## Process sandbox

The first supported production sandbox is Linux Bubblewrap.
Agentworks runs every child Pi process inside a mount namespace with the host root mounted read-only.
The assigned worktree is the only project-content path mounted read-write.
A private temporary directory, dedicated Pi session directory, and narrowly scoped Agentworks runtime paths are mounted read-write as required.
Git metadata remains read-only inside child sandboxes.
The original checkout remains read-only and is never the child cwd.

Roles without network requirements run with a separate network namespace.
Roles requiring network access must declare that requirement in their role and assignment.
Network access does not expand filesystem or credential access.

Only an explicit environment allowlist reaches a child process.
Controller tokens, run identity, child identity, terminal metadata, model configuration, and approved provider credentials are passed deliberately.
Unrelated secrets and parent environment variables are omitted.

Before launch, the capability doctor requires a canonical root-owned, non-writable Bubblewrap executable with parseable version output and runs a live sandbox probe.
The probe proves distinct user, mount, PID, and network namespaces; disables and tests nested user-namespace creation; verifies the host root and Git metadata reject writes; verifies the assigned boundary accepts writes; and confirms a parent canary is absent after environment clearing.
If any probe fails, the production launch gate returns no sandbox evidence and refuses to launch agents.
LOW, NORMAL, and HIGH all use the same hard sandbox gate.
A future platform adapter must pass the same boundary tests before it can advertise production support.

## Pi configuration exposure

A child needs selected Pi runtime resources, model registry information, and authentication material.
Agentworks exposes only the required paths, read-only wherever possible.
The child receives a dedicated writable session directory rather than the parent's session directory.
Agentworks does not expose the parent conversation unless a future explicitly approved fork-context feature provides a redacted copy.

The child bridge is loaded in a dormant mode by default.
It activates only when a valid Agentworks launch contract is present.
Child mode does not register the parent `agentworks` management tool, preventing recursive team creation.

## Git authority

The controller is the sole Git mutator.
Project Manager and worker agents can request operations but cannot create worktrees, stage, commit, merge, reset, remove worktrees, delete branches, or push.
Read-only Git inspection remains available inside the sandbox because Git metadata is mounted read-only.

Controller-created branches use deterministic run/story names and exact immutable base-commit evidence.
Integration worktree creation is idempotent across interrupted branch and attachment phases, rejects existing unregistered paths or mismatched branches, and verifies the registered worktree/branch/HEAD tuple after Git returns.
Mutating Git commands disable repository hooks, filesystem monitors, file-protocol expansion, and configured clean/smudge/process filters so an untrusted repository cannot turn checkout into controller-code execution.

After a writer reports completion and its durable lease is released, the controller verifies the exact worktree, branch, story HEAD, integration HEAD, ancestry, status, and changed paths before creating a candidate commit.
Status, staging, and commit commands run with effective clean/smudge/process filters neutralized, hooks and filesystem monitors disabled, signing and automatic maintenance disabled, and a fixed controller identity.
The commit records immutable operation trailers, and recovery accepts it only when the exact parent, full message, registered worktree identity, and clean status match.
Review targets an exact story commit and an exact integration-base commit, and the reviewer must not be the story writer.
Any change to either identity invalidates approval.
Merge preflight and execution neutralize effective custom merge drivers, branch merge options, hooks, signing, rerere, autostash, file protocol, filesystem monitors, and automatic maintenance before verifying the exact two-parent commit and resulting tree.

A merge requires all of the following evidence:

- the requester is the Project Manager for the run;
- the story commit equals the independently reviewed commit;
- the integration HEAD equals the reviewed base or a renewed review approves the new base;
- all required validation checks passed;
- the story worktree is clean after controller-authored commit creation;
- the target is the run's integration branch;
- protected or default targets have explicit user approval;
- the operation carries the current controller fencing token and expected revision.

Routine cleanup never uses force.
A story worktree can be removed only when its exact controller-owned merge remains in integration ancestry, its writer lease is released, its agent is closed, its branch/path/HEAD registration belongs to the run, and status contains no tracked, untracked, ignored, conflict, or submodule changes.
After non-force worktree removal is verified, branch deletion uses an atomic expected-object compare-and-delete so concurrent advancement is preserved rather than deleted.
Unregistered replacement content at a recovered cleanup path always blocks branch deletion.

## Controller authority and persistence

Each run has one controller writer lease.
The lease includes a fencing token so a stale controller cannot mutate state or Git after replacement.
Each writable story separately has at most one assigned-agent lease with a monotonic token and expiration.
All story-lease mutations require the current controller fence, while reassignment, candidate handoff, agent closure, and cleanup require durable release or exact-token revocation first.
Stale story tokens cannot renew, release, revoke, or regain authority after a replacement writer receives a higher token.
Controller discovery uses a user-private runtime directory, lock file, PID metadata, socket, and database identity.

SQLite runs in WAL mode with foreign keys enabled and an explicit schema version.
Every state transition and append-only event is committed in one transaction with an expected revision and idempotency key.
Duplicate launch, commit, review, merge, cleanup, and notification requests return the original result instead of repeating side effects.

Startup validates both SQLite integrity and the semantic shape of persisted state before binding the socket.
Physical corruption or invalid persisted state writes a durable quarantine marker before moving the database and sidecars, preventing accidental empty-state recreation on retry.
Interrupted agent operations, candidate creation, and merge phases publish a reconciliation-required descriptor and synchronously reject new work.
After the Git and Herdr gateways are available, recovery clears that gate only by reconciling recorded phases against external Herdr and Git reality.
Corrupt or unreconciled state is never treated as permission to clean worktrees or rerun merges.

## Herdr boundary

Agentworks uses Herdr for tabs, panes, focus, metadata, process inspection, and notifications.
It never scrapes ANSI terminal output to decide whether work succeeded.
Raw text injection is limited to initial prompting, explicit user steering, and bounded liveness nudges.
Every automated prompt verifies the expected run, pane, child session, current state, and lease first.

Pane and tab identifiers are hints that must be reconciled against live Herdr metadata.
A pane closure marks the agent disconnected rather than complete.
Recovery recreates a pane only when controller state, Pi session metadata, worktree state, and user policy permit it.

## Liveness and alerts

Idle is not synonymous with stalled.
An incomplete assignment enters attention only when Pi is idle, no approval or supervisor request is pending, no recent meaningful operation or lifecycle change indicates progress, and the quiet threshold has elapsed.
Heartbeats establish process life but do not reset the meaningful-progress clock.
The Project Manager may send a `.` nudge after the controller revalidates that state.

Nudges are bounded to three attempts with increasing delays.
Further inactivity marks the assignment blocked and emits a deduplicated Herdr `request` sound plus red management and Pi-overlay state.
Failures, dirty worktrees, conflicts, sandbox violations, pane loss, controller inconsistency, and unsafe cleanup attempts also alert.

## Resource limits

Complexity mode limits active agents, not merely configured panes.
The controller also enforces configurable limits for child processes, provider concurrency, runtime, token/cost budget, disk usage, and worktree count.
Scheduling applies backpressure when a quota is reached.
Terminal geometry can reduce the active visible-pane limit without weakening the mode's absolute maximum.

## Required adversarial tests

A production release must prove that a child cannot write to the original checkout, another worktree, Git metadata, the user's home files, or Agentworks controller state.
It must prove that roles without network access cannot open external connections.
It must prove that duplicate and stale-fencing requests cannot launch, commit, merge, notify, or clean twice.
It must kill the controller after each external side-effect phase and verify safe recovery.
It must prove that pane closure and heartbeat loss do not imply completion.
It must prove that HIGH cannot bypass sandbox, merge, secret, protected-branch, or cleanup guards.
