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
- [ ] Complete controller lifecycle and recovery:
  - [x] Implement secure runtime discovery, startup, lease renewal, reconnection metadata, graceful shutdown, fenced takeover, and stale-socket recovery.
  - [x] Implement independent detached process launch, authenticated health discovery, process-start identity checks, protocol shutdown, signal handling, and fenced restart after `SIGKILL`.
  - [x] Implement physical and semantic corruption quarantine plus a durable startup recovery gate that blocks new work on interrupted agent, candidate, or merge phases.
  - [ ] Reconcile gated recovery against live Git and Herdr evidence once those gateways are implemented.
- [ ] Add idempotency and kill-point recovery tests for every external side-effect phase.

## P2 - Git isolation

- [x] Implement canonical, read-only repository inspection with worktree/common-dir identity, offline default-branch evidence, credential-redacted remotes, object format, and additive protected-branch patterns.
- [x] Implement deterministic Project Manager integration branch/worktree creation with exact base evidence, idempotent attachment recovery, original-checkout preservation, and disabled repository hooks/filter commands.
- [x] Implement deterministic isolated branches/worktrees per writable story from exact integration-HEAD evidence, with idempotent attachment recovery and overlap rejection.
- [x] Implement durable, fenced single-writer leases with acquire/renew/release/revoke audit history, monotonic tokens, restart validation, and hard reassignment/candidate gates.
- [ ] Connect the tested merge, review-invalidation, and cleanup policies to real Git evidence.
- [x] Implement controller-authored candidate commits with exact branch/worktree/base evidence, released-lease gating, conflict/submodule rejection, hostile Git-config suppression, and crash-idempotent operation trailers.
- [ ] Prove through the sandbox and live child E2E boundary that the controller is the sole Git mutator.
- [ ] Prove with disposable-repository tests that the original checkout is never used as an agent cwd and remains unmodified.

## P3 - Roles, planning, and approvals

- [ ] Implement software-development, writing-and-authorship, research, and general-delivery role packs.
- [ ] Implement task-aware team composition within LOW, NORMAL, and HIGH limits.
- [ ] Implement complete user-story and assignment generation.
- [ ] Implement mode-specific TUI approvals, including mandatory LOW and NORMAL model confirmation.
- [ ] Implement Project Manager tuning and supervisor messages from the parent.

## P4 - Sandboxed execution

- [ ] Implement a sandbox capability doctor and fail-closed launch gate.
- [ ] Implement the Linux Bubblewrap adapter with read-only host root and Git metadata.
- [ ] Implement dedicated writable worktree, session, runtime, and temporary mounts.
- [ ] Implement environment allowlisting and per-role network isolation.
- [ ] Prove that child writes outside the assigned worktree and disallowed network access fail.

## P5 - Herdr integration

- [ ] Implement typed Herdr command and response adapters.
- [ ] Implement the parent-tab right management-pane lifecycle.
- [ ] Implement the `Pi Agents` tab and deterministic grids from 1 through 16 panes.
- [ ] Implement pane focus, labels, metadata, process detection, and recovery.
- [ ] Implement deduplicated Herdr visual and audio alerts.

## P6 - Interactive Pi agents

- [ ] Implement secure interactive Pi launch with role prompt, model, tools, task, worktree, and session identity.
- [ ] Implement dormant-by-default child bridge mode.
- [ ] Implement structured lifecycle, operation, result, blocker, and supervisor communication.
- [ ] Implement disconnected-pane detection and resumable session restoration.

## P7 - Management TUI

- [ ] Implement the htop-style management dashboard.
- [ ] Implement independent scrolling and sorting for stories, todos, and agents.
- [ ] Implement color-coded run and attention states.
- [ ] Implement mouse selection and keyboard navigation that focuses agent panes.
- [ ] Implement approval, steering, pause, resume, restoration, and close-all actions.

## P8 - Parent Pi extension

- [ ] Register `/agentworks` and argument forms for LOW, NORMAL, and HIGH.
- [ ] Register the model-callable `agentworks` management tool.
- [ ] Implement the persistent right-side overlay todo and run-status view.
- [ ] Implement narrow-terminal fallback, hide/show, focus, and management shortcuts.
- [ ] Restore active runs when Pi restarts.

## P9 - Orchestration

- [ ] Implement dependency-aware story scheduling and complexity concurrency caps.
- [ ] Implement bounded idle detection and Project Manager `.` nudges.
- [ ] Implement reviewer approval and renewed-review rules after relevant changes.
- [ ] Implement Project Manager merge requests and controller-executed integration into the integration worktree.
- [ ] Implement terminal run completion and safe worktree cleanup.

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
