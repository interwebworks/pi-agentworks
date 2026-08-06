# Agentworks Backlog

This file is the canonical open-work surface for Agentworks.
Items remain open until their acceptance evidence is recorded by tests or deterministic validation.

## P0 - Package and contracts

- [x] Record the approved product contract and SOLID architecture.
- [x] Implement complexity policy and task-specification contracts with runtime validation and tests.
- [x] Add the strict role-pack schema, bounded prompt loading, trust gate, and builtin/user/project discovery precedence.
- [x] Add package-level format, lint, typecheck, unit-test, and runtime-audit checks.
- [x] Define the OS-enforced sandbox, controller-only Git authority, fencing, idempotency, and adversarial security gates.
- [x] Implement pure launch, merge, and cleanup safety policies with tests.
- [x] Add least-privilege CI for the package quality suite.

## P1 - Controller

- [x] Implement the versioned run, story, agent, review, recovery, and liveness state model with guarded transitions.
- [x] Implement the SQLite repository with migrations, WAL, strict persisted-state validation, transactional revisions and events, bounded cursors, idempotency records, and fenced controller leases.
- [x] Implement the versioned, authenticated, identity-bound, sequence-checked, and bounded Unix socket protocol with private socket permissions and typed client/server adapters.
- [x] Complete controller lifecycle and recovery:
  - [x] Implement secure runtime discovery, startup, lease renewal, reconnection metadata, graceful shutdown, fenced takeover, and stale-socket recovery.
  - [x] Implement independent detached process launch, authenticated health discovery, process-start identity checks, protocol shutdown, signal handling, and fenced restart after `SIGKILL`.
  - [x] Implement physical and semantic corruption quarantine plus a durable startup recovery gate that blocks new work on interrupted agent, candidate, or merge phases.
  - [x] Reconcile gated recovery against live Git and Herdr evidence once those gateways are implemented.
- [x] Add idempotency and kill-point recovery tests for every external side-effect phase.

## P2 - Git isolation

- [x] Implement canonical, read-only repository inspection with worktree/common-dir identity, offline default-branch evidence, credential-redacted remotes, object format, and additive protected-branch patterns.
- [x] Implement deterministic Project Manager integration branch/worktree creation with exact base evidence, idempotent attachment recovery, original-checkout preservation, and disabled repository hooks/filter commands.
- [x] Implement deterministic isolated branches/worktrees per writable story from exact integration-HEAD evidence, with idempotent attachment recovery and overlap rejection.
- [x] Implement durable, fenced single-writer leases with acquire/renew/release/revoke audit history, monotonic tokens, restart validation, and hard reassignment/candidate gates.
- [x] Connect exact independent-review, review-invalidation, protected-target approval, and merge policies to registered worktrees and real Git commit/tree/ancestry evidence.
- [x] Connect no-force story cleanup to exact merge-operation ownership, integration ancestry, full tracked/untracked/ignored cleanliness, closed-agent and released-lease evidence, and atomic compare-and-delete branch removal.
- [x] Implement controller-authored candidate commits with exact branch/worktree/base evidence, released-lease gating, conflict/submodule rejection, hostile Git-config suppression, and crash-idempotent operation trailers.
- [x] Prove through the sandbox and live child E2E boundary that the controller is the sole Git mutator.
- [x] Prove with disposable-repository tests that the original checkout is never used as an agent cwd and remains unmodified.

## P3 - Roles, planning, and approvals

- [x] Implement software-development, writing-and-authorship, research, and general-delivery role packs.
- [x] Implement task-aware team composition within LOW, NORMAL, and HIGH limits.
- [x] Implement complete user-story and assignment generation.
- [ ] Implement mode-specific TUI approvals, including mandatory LOW and NORMAL model confirmation.
- [ ] Implement Project Manager tuning and supervisor messages from the parent.

## P4 - Sandboxed execution

- [x] Implement a fail-closed Bubblewrap capability doctor and launch gate with trusted executable/version checks plus live user/mount/PID/network namespace, nested-userns, read-only root/Git, writable-boundary, and environment probes.
- [x] Implement the Linux Bubblewrap command planner with read-only host root/Git metadata, masked home/runtime/temp/media mounts, disabled nested user namespaces, and explicit approved re-exposure.
- [x] Implement dedicated writable worktree and session mounts plus private temporary and read-only controller-runtime mounts.
- [x] Implement strict environment allowlisting and explicit isolated-versus-approved-host network policy.
- [x] Prove with live child probes that outside-worktree/Git/runtime/resource writes, home/runtime secret reads, parent environment leakage, and isolated-network default routes fail.

## P5 - Herdr integration

- [x] Implement protocol-17-pinned, bounded typed Herdr command/response adapters for tab, pane, layout, process, lifecycle, metadata, focus, close, text, and safely quoted terminal-run operations.
- [x] Implement the parent-tab right management-pane lifecycle with atomic shell-environment ownership tags, exact right-sibling layout validation, metadata reconciliation, duplicate/spoof refusal, and interrupted-split recovery.
- [x] Implement the crash-recoverable `Pi Agents` tab and deterministic balanced binary-split grids from 1 through 16 panes, with exact slot ownership, no-focus creation, idempotent partial completion, and geometry validation.
- [x] Implement exact pane focus through verified directional-neighbor selection plus tab focus, along with ownership-bound labels, metadata, stable shell-process detection, partial lifecycle recovery, and identity-drift refusal.
- [x] Implement bounded concurrency-safe Herdr visual/audio alerts with severity-to-sound mapping, content fingerprints, keyed cooldown deduplication, state-change delivery, retryable failures, and typed delivery evidence.

## P6 - Interactive Pi agents

- [x] Implement secure interactive Pi launch with fenced lease/revision authority, private immutable prompt artifacts, exact role/model/thinking/tool/task/session identity, dedicated Pi config/session storage, explicit single-extension loading, role-specific read-only/read-write worktree mounts, Bubblewrap/Herdr composition, and live process evidence.
- [x] Implement dormant-by-default child bridge mode with exact environment activation, private per-agent HMAC capabilities, real-socket/private-file validation, authenticated controller hello, fresh UUID connection sequencing, controller identity-response verification, shutdown and tool lockdown on authentication failure, and zero ordinary-session registrations.
- [ ] Implement structured lifecycle, operation, result, blocker, and supervisor communication.
  - [x] Define the versioned message model and bounded codec.
  - [x] Carry authenticated session-start/session-shutdown messages through the child/controller RPC boundary.
  - [x] Define the fail-closed reducer for lifecycle, progress, heartbeat, completion, and blocker messages.
  - [x] Wire the reducer into fenced durable controller commits for authenticated `agent.message` requests.
  - [x] Emit child operation-start, progress/heartbeat, and settled-completion messages from Pi lifecycle hooks.
  - [x] Emit child blocker messages and failed operation results from tool errors.
  - [x] Define durable supervisor-attention reactions for blocked/failed child messages.
  - [ ] Dispatch supervisor attention to the parent/management surface and support bounded directives.
  - [ ] Add operation progress/result/blocker/supervisor directives and round-trip tests.
- [ ] Implement disconnected-pane detection and resumable session restoration.
  - [x] Add deterministic pane-loss assessment and restoration planning.
  - [ ] Wire restoration planning into Herdr/Pi relaunch and session resume.

## P7 - Management TUI

- [ ] Implement the htop-style management dashboard.
- [ ] Implement independent scrolling and sorting for stories, todos, and agents.
- [ ] Implement color-coded run and attention states.
- [ ] Implement mouse selection and keyboard navigation that focuses agent panes.
- [ ] Implement approval, steering, pause, resume, restoration, and close-all actions.

## P8 - Parent Pi extension

- [x] Register `/agentworks` and argument forms for LOW, NORMAL, and HIGH.
- [x] Register the model-callable `agentworks` management tool.
- [ ] Implement the persistent right-side overlay todo and run-status view.
- [ ] Implement narrow-terminal fallback, hide/show, focus, and management shortcuts.
- [ ] Restore active runs when Pi restarts.

## P9 - Orchestration

- [x] Implement dependency-aware story scheduling and complexity concurrency caps.
- [ ] Implement bounded idle detection and Project Manager `.` nudges.
- [ ] Implement reviewer approval and renewed-review rules after relevant changes.
- [x] Implement Project Manager merge requests and controller-executed integration into the integration worktree.
- [x] Implement terminal run completion and safe worktree cleanup.

## P10 - Distribution and migration

- [ ] Make local `pi install /absolute/path/to/agentworks` installation pass.
- [ ] Prepare Git and npm package metadata for Pi package-list distribution.
- [ ] Document installation, updates, configuration, custom role packs, recovery, and uninstall.
- [ ] Replace `pi-herdr-subagent-panes.ts` after Agentworks passes live validation.
- [ ] Uninstall `pi-subagents` and remove its configuration only after Agentworks replacement validation.
- [ ] Judge and migrate useful concepts from the existing architect and worker definitions without preserving obsolete structure.

## P11 - End-to-end proof

- [ ] Test LOW planning and mandatory confirmation.
- [ ] Test NORMAL planning, model confirmation, implementation, review, merge, and cleanup.
- [ ] Test HIGH concurrency, process/provider/cost/disk backpressure, and hard safety boundaries.
- [ ] Test that direct child Git mutation, outside-worktree writes, secret reads, and disallowed network access fail.
- [ ] Test Herdr layouts at 1, 4, 6, 9, 12, and 16 agents.
- [ ] Test audio/visual failure alerts, stalled-agent nudges, pane loss, Pi restart, Herdr reconnect, and close-all.
- [ ] Run formatting, lint, typecheck, unit, integration, packaging, and live E2E suites green.
