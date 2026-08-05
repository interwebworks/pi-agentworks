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

`RolePackRepository` discovers built-in, user, package, and trusted-project role packs.

`TeamComposer` selects roles germane to the task while respecting complexity limits.

`TaskSpecificationFactory` validates that every assignment is executable without unapproved invention.

`RunCoordinator` advances stories through planned, approved, assigned, working, review, merge, and completion states.

`AgentSupervisor` tracks heartbeats, bounded `.` nudges, blocked states, recovery, and escalation.

`MergePolicy` decides whether review and branch evidence permit integration.

`CleanupPolicy` decides whether a worktree is safe to remove.

`ControllerRepository` persists authoritative state and append-only events in SQLite.

`ControllerServer` exposes a versioned authenticated Unix socket protocol.

`HerdrGateway` creates, lays out, focuses, labels, restores, and closes tabs and panes.

`GitWorkspaceGateway` creates branches and worktrees, inspects cleanliness and ancestry, merges approved branches, and removes only verified worktrees.

`PiAgentLauncher` starts an interactive Pi agent with an explicit role prompt, task specification, model, tool allowlist, session name, environment allowlist, and controller endpoint.

`NotificationGateway` emits Herdr visual and audio alerts with deduplication.

## Authoritative state

SQLite is the machine source of truth.
The controller is the only writer.
Clients send commands with an expected run revision.
Successful state changes increment the revision and append an event in the same transaction.
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
The controller rejects unknown versions, invalid tokens, oversized frames, duplicate sequence numbers, and agent/run mismatches.

The child bridge is dormant outside an Agentworks launch environment.
This prevents recursively creating teams in ordinary Pi sessions.

## Liveness

A heartbeat does not imply useful work, so operation and Pi lifecycle state are tracked separately.
An incomplete agent that becomes idle enters an attention window.
After a configurable quiet period, the supervisor asks the Project Manager to send one `.` nudge.
The default policy allows three nudges with increasing delays.
Further inactivity marks the assignment blocked, emits an audio alert, and requires PM or user action.

## Git safety

The original checkout is never an agent cwd.
The Project Manager integration branch also lives in a worktree.
Every write-capable story has one active writer lease.
Commands resolve canonical repository and worktree paths before execution.

Merge eligibility requires an approved reviewer result, successful required checks, a clean story worktree, the expected branch HEAD, and an unchanged integration base since review or a renewed review after rebasing.
Cleanup requires merge ancestry proof and a clean worktree.
Agentworks does not use force removal for routine cleanup.

## Recovery

Controller state records Herdr workspace, tab, pane, Pi session, branch, worktree, process, and last acknowledged sequence identities.
On reconnect, the extension queries controller state and live Herdr state before changing anything.
Missing panes become disconnected.
The user can restore a recoverable session or explicitly abandon it.
Unmerged worktrees are never deleted during recovery.

## Test strategy

Domain policy uses pure unit tests.
Controller persistence and transactions use temporary SQLite databases.
Unix socket tests use temporary directories and invalid-token cases.
Git tests use disposable repositories and real worktree commands.
Herdr tests use a fake gateway for unit and integration work, plus opt-in live tests against a dedicated Herdr session.
Pi extension tests use mocked extension and UI ports.
Packaging tests install from a local path into an isolated Pi configuration directory.
End-to-end tests create a disposable repository, launch a small Agentworks run in Herdr, verify pane layout and state flow, and prove that the original checkout remains untouched.
