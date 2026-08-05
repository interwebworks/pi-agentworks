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

- [ ] Implement the versioned controller state model and transition policy.
- [ ] Implement the SQLite repository with transactional revisions and events.
- [ ] Implement the authenticated, bounded Unix socket protocol.
- [ ] Implement controller startup, independent supervision, writer lease, fencing, reconnection, shutdown, and crash recovery.
- [ ] Add idempotency and kill-point recovery tests for every external side-effect phase.

## P2 - Git isolation

- [ ] Implement repository inspection and protected/default-branch detection.
- [ ] Implement the Project Manager integration worktree lifecycle.
- [ ] Implement one branch and worktree per writable story.
- [ ] Implement writer leases and connect the tested merge, review-invalidation, and cleanup policies to real Git evidence.
- [ ] Make the controller the sole Git mutator, including candidate commits requested by agents.
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
