# Agentworks Architecture

## Design goals

Agentworks applies SOLID boundaries without multiplying abstractions that have no independent reason to change.
Domain policy remains independent of Pi, Herdr, Git, SQLite, and terminal rendering.
Adapters depend on narrow application ports.
All destructive behavior is guarded by explicit policy and independently testable preconditions.

## Runtime topology

A parent Pi extension is the user and model entrypoint.
A per-run controller process owns state, scheduling, recovery metadata, and the authenticated local protocol.
A management TUI connects to the controller in a right-side Herdr pane.
Each role runs as a real interactive Pi process in a dedicated Herdr pane and a dedicated Git worktree.
A child bridge mode of the same Pi extension reports session identity, lifecycle, current operation, completion output, and supervisor messages to the controller.

## Layers

### Domain

The domain layer contains complexity policy, role definitions, task specifications, stories, agent state transitions, review requirements, merge eligibility, cleanup eligibility, and run invariants.
It imports no infrastructure or UI modules.

### Application

Application services implement use cases such as plan a run, approve a plan, create a team, assign a story, launch an agent, report progress, nudge a stalled agent, approve review, merge a story, clean a worktree, recover a pane, and close a run.
They depend on ports for persistence, Git, Herdr, process launch, notifications, clocks, identifiers, and user approvals.

### Infrastructure

Infrastructure adapters implement the controller SQLite repository, Unix socket transport, Git worktree operations, Herdr CLI or socket operations, Pi process launch, filesystem role-pack loading, and audio notifications.
Every external result is parsed into a typed internal value before it reaches application policy.

### Interfaces

The Pi extension adapts commands, tools, forms, status rendering, and the persistent right-side overlay.
The management TUI adapts controller snapshots and actions into an htop-style dashboard.
The child bridge adapts Pi lifecycle events into controller reports.

## Primary components

`ComplexityPolicy` owns confirmation and concurrency behavior for LOW, NORMAL, and HIGH.

`RolePackRepository` discovers strict data-only role packs with builtin, user, and trusted-project precedence.
Manifests reject unknown fields, unsafe controller authority, symlinks, traversal, oversized prompts, and write-policy conflicts before a role becomes selectable.
Package-provided roots can be supplied through the same repository port without changing domain policy.

`TeamComposer` selects roles germane to the task while respecting complexity limits.

`TaskSpecificationFactory` validates that every assignment is executable without unapproved invention.

`RunCoordinator` advances versioned run and story records through guarded planning, approval, assignment, work, candidate, exact-HEAD review, merge, blocking, failure, and completion states.
Terminal states cannot be reopened, incomplete runs cannot complete, and review evidence is invalidated when its story or integration identity changes.

`AgentSupervisor` tracks explicit launch, Pi-session readiness, meaningful activity, heartbeats, waiting, blocking, pane loss, recovery, bounded `.` nudges, completion, and closure.
Heartbeats prove process life but do not postpone a nudge when no meaningful work advances.

`MergePolicy` decides whether review and branch evidence permit integration.

`CleanupPolicy` decides whether a worktree is safe to remove.

`ControllerRepository` persists authoritative state and append-only events in SQLite.

`ControllerServer` exposes a versioned authenticated Unix socket protocol.

`HerdrGateway` creates, lays out, focuses, labels, restores, and closes tabs and panes.

`GitWorkspaceGateway` is the sole Git mutator and creates branches, worktrees, candidate commits, approved merges, and verified cleanup.
The Project Manager and workers can request Git operations but cannot execute mutating Git commands directly.

`SandboxGateway` enforces the child filesystem, Git metadata, environment, and network boundary outside the model process.
The first production adapter uses Linux Bubblewrap and fails closed when its required capabilities are unavailable.

`PiAgentLauncher` starts an interactive Pi agent inside the approved sandbox with an explicit role prompt, task specification, model, tool allowlist, session name, environment allowlist, and controller endpoint.

`NotificationGateway` emits Herdr visual and audio alerts with deduplication.

## Authoritative state

SQLite is the machine source of truth.
The controller is the only database writer and runs with WAL, foreign keys, schema migrations, integrity checks, and corruption quarantine.
A single controller lease and fencing token prevent stale controllers from mutating state or external resources.
Clients send commands with an expected run revision and idempotency key.
Successful state changes replace one complete run aggregate, increment its revision, append one or more ordered events, and record the idempotency result in the same immediate transaction.
Event consumers resume with a revision and within-revision event index so bounded pages cannot skip events.
Persisted JSON is checked against strict versioned state schemas before it can re-enter controller policy.
The management pane and Pi overlay subscribe to snapshots and events.
Terminal output is never parsed to infer task completion.

State lives under a user-private runtime directory outside the target repository.
Only worktree paths and Agentworks-authored task artifacts are created near the repository.
No Agentworks runtime database is placed in the original checkout.

## Herdr layout

The parent pane ID and tab ID come from Herdr environment variables.
The management pane splits the parent pane to the right and uses enough width for long agent lists.
The `Pi Agents` tab is created in the same workspace.

The grid planner maps an agent count to rows and columns with no more than sixteen cells.
The Herdr adapter builds a deterministic binary split tree because Herdr exposes right and down splits rather than a direct grid primitive.
Layout operations are idempotent against controller pane records.
The adapter validates returned pane IDs before launching any process.

## Child protocol

The controller creates a random run token and a user-only Unix socket.
Child processes receive only the socket path, token, run ID, agent ID, and role-safe environment.
The child bridge sends versioned messages for session-ready, state, operation, heartbeat, supervisor-message, completion, failure, and shutdown.
Transport uses four-byte big-endian length-prefixed JSON with bounded frame size, queued frames, JSON depth, JSON nodes, connections, and idle time.
The socket and its directory are user-private, an existing path is never replaced implicitly, and cleanup removes only the exact socket inode created by the server.
The controller uses constant-time token-digest comparison and rejects unknown versions, invalid tokens, oversized frames, duplicate sequence numbers, and agent/run mismatches.

The child bridge is dormant outside an Agentworks launch environment.
Child mode does not register the parent management tool.
This prevents recursively creating teams in ordinary Pi sessions.

## Liveness

A heartbeat does not imply useful work, so operation and Pi lifecycle state are tracked separately.
An incomplete agent that becomes idle enters an attention window.
After a configurable quiet period, the supervisor asks the Project Manager to send one `.` nudge.
The default policy allows three nudges with increasing delays.
Further inactivity marks the assignment blocked, emits an audio alert, and requires PM or user action.

## Git safety

The original checkout is never an agent cwd.
Before planning worktrees, a read-only Git adapter resolves canonical repository, per-worktree Git directory, common Git directory, current HEAD, object format, local branches, and credential-redacted remotes with bounded argument-array commands.
Default-branch detection uses local remote-HEAD evidence first and offline conventional or single-branch evidence second; it never contacts a remote during inspection.
The detected default branch is always protected, while repository and user branch-pattern protections are additive and cannot weaken it.
The Project Manager integration branch also lives in a worktree.
Each writable story gets a deterministic `agentworks/<run>/stories/<story>` branch and a non-overlapping worktree created from an exact integration commit, never from a moving branch name alone.
Interrupted story branch creation and worktree attachment are recovered idempotently only while the unattached branch still equals that expected integration commit.
Every write-capable story has at most one durable writer lease.
Writer leases use monotonic per-story tokens under the controller fencing token, expire unless renewed, and record acquisition, renewal, release, and revocation in an append-only SQLite audit table.
A snapshot cannot reassign a story, remove or close its writer, or move past the writable phase while the durable lease remains held, even if an in-memory transition claim says it was released.
Reassignment therefore revokes or releases the exact current token first, returns the story to ready, assigns the replacement, and acquires a higher token that fences out the former writer.
Commands resolve canonical repository and worktree paths before execution.

Child sandboxes mount the host root and Git metadata read-only while mounting only the assigned worktree and narrowly scoped runtime paths read-write.
Tool restrictions and cwd are defense in depth rather than the security boundary.
The controller creates candidate commits after writer completion so review and merge operate on exact immutable commit identities.

Merge eligibility requires an approved reviewer result, successful required checks, a clean story worktree, the expected branch HEAD, and an unchanged integration base since review or a renewed review after rebasing.
Cleanup requires merge ancestry proof and a clean worktree.
Agentworks does not use force removal for routine cleanup.

## Recovery

Controller state records Herdr workspace, tab, pane, Pi session, branch, worktree, process, and last acknowledged sequence identities.
Each run publishes an atomically replaced, strictly validated discovery descriptor beside its private token, SQLite database, and socket in a user-only runtime directory.
Startup checks database integrity and acquires the fenced writer lease before recovering a socket; only an explicit connection-refused result permits removal of a stale socket.
Lease renewal republishes expiration and fencing metadata, while graceful shutdown removes discovery and the owned socket but preserves the database and token for restart.
The parent launches the controller as a detached Node process without a shell, redirects output to a private log, and confirms health over the authenticated protocol rather than trusting spawn success.
Linux process start-time identity prevents PID reuse from masquerading as the recorded controller.
`SIGINT`, `SIGTERM`, and protocol shutdown release the lease; after `SIGKILL`, the supervisor waits for lease expiry and starts a newly fenced controller that recovers the stale socket.
On reconnect, the extension validates the descriptor and token, then queries controller state and live Herdr state before changing anything.
Missing panes become disconnected.
The user can restore a recoverable session or explicitly abandon it.
Unmerged worktrees are never deleted during recovery.
Controller recovery is idempotent at every external side-effect boundary, including worktree creation, pane creation, child registration, candidate commit, review, merge, and cleanup.

## Test strategy

The full threat model and adversarial release gates are defined in [security-model.md](security-model.md).

Domain policy uses pure unit tests.
Controller persistence and transactions use temporary SQLite databases.
Unix socket tests use temporary directories and invalid-token cases.
Git tests use disposable repositories and real worktree commands.
Herdr tests use a fake gateway for unit and integration work, plus opt-in live tests against a dedicated Herdr session.
Pi extension tests use mocked extension and UI ports.
Packaging tests install from a local path into an isolated Pi configuration directory.
End-to-end tests create a disposable repository, launch a small Agentworks run in Herdr, verify pane layout and state flow, and prove that the original checkout remains untouched.
