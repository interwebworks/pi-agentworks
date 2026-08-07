# Agentworks Next Steps

This document translates the open work in [`BACKLOG.md`](../BACKLOG.md) into an ordered implementation and validation plan.
`BACKLOG.md` remains the canonical status surface, and an item must not be marked complete until its acceptance evidence exists.
The current shipped baseline is commit `e973a8a`, which launched a live Project Manager, advisor, and writer in one controller-owned `Pi Agents` tab beside an authenticated management dashboard.

## 1. Close management recovery blockers

### 1.1 Pin management ownership to the original parent origin

Status: Completed in `96a6699` with global operation reconciliation, persisted controller origin, and cross-origin recovery tests.

Persist the original parent workspace, tab, and pane identity for each run.
Make `ManagementPaneLifecycle.ensure()` scan globally for the run and operation ownership base before considering a split.
Reject caller-origin drift, duplicate run-owned management panes, moved parents, spoofed ownership, and ambiguous evidence.
Never create a second management pane merely because `/agentworks status` was invoked from another tab or pane.

Acceptance evidence:

- A status request from another tab finds or rejects the original management ownership without creating a duplicate.
- Duplicate base ownership fails closed.
- Restart recovery uses the persisted origin rather than the current caller environment.
- Split-before-metadata and metadata-before-dashboard interruptions converge to exactly one pane and one dashboard process.

### 1.2 Resume a launch deferred by management bootstrap failure

Status: Completed in `d645a55` with a parent-only resume action, dashboard-success gating, current-fence validation, launch-boundary checks, and concurrency coalescing.

Record that the initial orchestration tick was deferred when mandatory dashboard startup fails.
After `/agentworks status` successfully restores the dashboard, execute the deferred tick through an explicit idempotent resume operation.
Require safe run state, current controller fencing, and proof that no launch set has already started.
Do not require the user to initialize the same run again.

Acceptance evidence:

- A failed management bootstrap leaves the run durable and agentless.
- A later successful status or resume request starts exactly one initial orchestration tick.
- Repeated retries do not duplicate agents, panes, worktrees, sessions, or leases.
- A concurrent pair of resume requests still launches exactly one team.

## 2. Make launch failures recoverable

Status: Completed in `ec11afe` and hardened in `e783e10` with durable launch reservations, exact process confirmation, idempotent reconciliation, and concurrent launch coalescing.

`materializeAgentLaunch` precedes secure Pi process launch, so durable launch reservations and process-aware reconciliation now prevent a failed process start from suppressing replacement indefinitely.
The reconciliation applies to Project Managers, advisors, writers, and reviewers.
A durable launch reservation must either prove its exact live pane, process, and Pi session or transition through a guarded retry or terminal failure path.
Preserve deterministic agent identities and never silently adopt a replacement process or pane.

Acceptance evidence:

- Failure after materialization but before Pi launch can be retried safely.
- Failure after pane creation but before process readiness can be reconciled without orphaning resources.
- Terminal failed or closed agents do not incorrectly suppress a required replacement.
- Concurrent reconciliation cannot launch two processes for one agent identity.
- Kill-point tests cover every external side-effect boundary.

## 3. Complete controller and pane restoration

Status: Exact multi-pane loss, trusted dead-controller restart, and parent Pi restart slices are implemented at deterministic process and protocol-shaped Herdr boundaries.
Status recovery now assesses the controller roster against strict Herdr process and metadata evidence, requires complete durable per-agent slot evidence, reserves the complete missing set atomically under one deterministic operation identity, reconstructs every missing pane in its exact slot, and relaunches each agent through the secure launcher only when its exact recorded private Pi session file and UUID survive.
The anchor case uses five slots with `0`, `2`, and `4` surviving while `1` and `3` are restored without moving or adopting survivors.
A per-agent kill-point matrix across reservation, pane creation, binding, process launch, and confirmation converges without duplicating a tab, pane, process, session, worktree, agent, or reservation.
Concurrent and repeated restoration requests share the existing orchestration-effects serialization and coalesce to one resource set.
Missing, ambiguous, stale, mixed, partial, conflicting, duplicate, and spoofed pane, process, slot, reservation, roster, or session evidence fails closed before an unsafe relaunch.

SQLite schema v5 now binds one immutable HMAC-authenticated, credential-free controller composition to each initialized run.
The evidence records the exact provider, model, thinking level, Herdr workspace, host-network policy, controller lease policy, controller home, and canonical Herdr, Pi, Node, package, controller-entry, and child-bridge paths.
Status compares any supplied caller runtime against that evidence and never reconstructs restart authority from the current caller environment.
A dead-controller status path opens and validates the database, verifies the authenticated composition, requires an expired or released controller lease, rejects active or indeterminate socket state, validates the recorded process-start identity, requires a ready startup-recovery assessment, and only then calls `DetachedControllerSupervisor.ensureRunning()` with the persisted composition and environment inheritance disabled.
The restarted controller verifies the same authenticated composition before opening its socket, and production pane restoration remains lazy until status requests it.
Process tests cover SIGKILL, pre-expiry refusal, one fenced restart, exact surviving pane/process/session/worktree/agent evidence, repeated status idempotency, caller drift, missing or unauthenticated composition, a live competing process identity, an active orphan socket, physical database corruption, and incomplete startup recovery evidence.

A process-level parent Pi restart test now launches through the model-callable extension tool, disposes the original extension session and background-work registration, constructs a fresh extension and discovered gateway with the same authenticated runtime identity, and issues status first against the still-active controller and then against the `SIGKILL`ed controller after lease expiry.
The fresh surface restores its session-bound background-work item for the unclosed agent, reuses the original management origin, restarts exactly one fenced controller, and preserves the one run, story, controller composition, agent, launch, management pane/dashboard, agent pane process, Pi session file, and two expected Git worktrees without a restoration reservation or capacity increase.
Caller-runtime drift and pre-expiry takeover remain refused before management mutation.
This is deterministic process-level evidence with a protocol-shaped fake Herdr agent-pane boundary and an injected idempotent management lifecycle, not a real live Herdr UI E2E claim.
The deterministic multi-pane boundary uses a protocol-shaped fake Herdr implementation rather than a live UI.
Real Herdr restart and live multi-pane-loss E2E remain unclaimed.
SQLite schema v7 persists the stable Herdr slot on new launch records, backfills agents that already had a durable restoration record, and enforces collisions transactionally only across unclosed agents so a verified closed agent's slot can be reused.
Older launch records without durable slot evidence remain usable for no-op status reads, but restoration fails closed until exact slot authority exists rather than inferring an ambiguous multi-pane mapping.

Acceptance evidence:

- Missing slots `1` and `3` from a five-pane grid with surviving slots `0`, `2`, and `4` restore together without moving or adopting survivors.
- Controller restart does not create duplicate tabs, panes, dashboard processes, worktrees, sessions, or agents.
- Parent Pi restart reconnects to active runs and restores the management surface.
- Herdr reconnect and interrupted split recovery preserve operation and slot identities.
- Exact session reuse is demonstrated rather than inferred.

## 4. Enforce one global active-agent limit

Status: Completed in `52beb43` and `628c2c0` with deterministic orchestration admission, serialized tick reloads, and an atomic SQLite materialization guard.

Replace role-local or story-local counting with a controller-authoritative active-agent budget.
Count Project Managers, advisors, writers, reviewers, and any future active role against the same run-level limit.
Reserve capacity explicitly and atomically before launch effects.
Release capacity only after durable terminal-state and process evidence permit it.

Acceptance evidence:

- Multi-story scheduling never exceeds the configured global limit.
- Advisor and reviewer launches cannot bypass the limit.
- Concurrent ticks cannot over-reserve capacity.
- Recovery reconstructs usage from durable state and live evidence without widening the limit.

## 5. Finish the full orchestration lifecycle

Add repeated or event-driven orchestration ticks rather than relying on one initial tick.
Support multiple durable stories with dependency-aware scheduling.
Launch reviewers after candidate creation, require exact candidate and integration evidence, and invalidate reviews after relevant changes.
Exercise controller-owned merge, cleanup, and terminal run completion through the production composition.
Keep Project Manager, reviewer, and worker authority boundaries explicit.

Acceptance evidence:

- A multi-story run progresses from planning through writer execution, review, merge, cleanup, and completion.
- Independent stories can run concurrently within the global active-agent limit.
- Dependent stories remain blocked until their prerequisites are integrated.
- Reviewers inspect exact candidate heads and cannot approve stale revisions.
- Failed reviews return work through a bounded, durable retry path.
- Original checkouts remain untouched throughout the run.

## 6. Expand live Herdr validation

Run installed-package E2E tests from `/home/user/.pi/agent/git/github.com/interwebworks/pi-agentworks`, not only from the development checkout.
Validate incremental grid growth and restart recovery at 1, 4, 6, 9, 12, and 16 agent panes.
Inspect the UI for balanced tiling, readable labels, correct focus behavior, stable management placement, and visual defects.

Acceptance evidence:

- Each required grid size has recorded live layout, ownership, process, and geometry evidence.
- Incremental growth preserves existing pane identities and sessions.
- Restart recovery preserves the same tab and operation identity.
- No duplicate, overlapping, off-screen, mislabeled, or incorrectly focused panes appear.

## 7. Complete management and parent controls

Implement approvals, steering, supervisor directives, pause, resume, restoration, close-all, scrolling, sorting, keyboard navigation, mouse selection, and pane focus.
Route every mutating action through authenticated controller commands with current fencing and bounded payloads.
Keep dashboard polling read-only and use separate authenticated identities for mutations.
Add LOW and NORMAL confirmation flows before those modes can launch production agents.

Acceptance evidence:

- Every action has authorization, state-transition, idempotency, and round-trip tests.
- Invalid or stale actions fail closed and render a useful explanation.
- Narrow terminals remain usable.
- Close-all proves safe process shutdown and controller-owned cleanup.

## 8. Replace temporary host networking

Design a narrow mediated model-egress path that permits only the selected model provider connection.
Return child task tools to an isolated network namespace.
Do not expose controller credentials, unrelated provider credentials, or host network access to the child environment.

Acceptance evidence:

- Authenticated model calls succeed through the mediator.
- Arbitrary child network access fails.
- Only the selected provider credential is available to the mediator.
- Filesystem, environment, controller-runtime, and Git isolation remain intact.

## 9. Reuse selected `pi-subagents` components

Status: Completed for the compatible public surface in `914c720` with an exact `pi-subagents@0.38.0` production dependency and session-bound registration through the public `pi-subagents/background-work` export.
Agentworks continues to own all execution, controller, Git, sandbox, Herdr, and recovery authority.
The capability-ceiling API is deferred because its registry constrains pi-subagents execution rather than Agentworks child launches, so registering it here would duplicate policy and unexpectedly constrain unrelated delegation without strengthening Agentworks.
The preflight API is deferred because its agent discovery, role, skill, model-fallback, extension, artifact, and launch-contract semantics conflict with the current Agentworks role-pack and secure-launch boundaries.

Adopt `pi-subagents` only through stable public exports or attributed vendoring under its MIT license.
Keep Agentworks authoritative for controller state, Git, worktrees, leases, fencing, Herdr ownership, sandboxing, and recovery.
Never silently fall back to ordinary `pi-subagents` execution for an Agentworks run.

Recommended order:

1. Register Agentworks runs through `pi-subagents/background-work` for shared Pi background-work visibility.
2. Evaluate `pi-subagents/capability-ceiling` as an additional deny-only launch gate that cannot widen Agentworks authority.
3. Evaluate `pi-subagents/preflight` for model fallback, tool, skill, and launch-contract validation where it does not conflict with role-pack authority.
4. Reuse or adapt delegation budgets, acceptance evidence, structured results, usage accounting, and lifecycle artifact patterns.
5. Avoid internal `src/...` imports unless the code is vendored with attribution or upstream exposes a stable API.

Acceptance evidence:

- The dependency is pinned and production packaging includes every runtime requirement.
- Capability-ceiling remains disconnected because it governs pi-subagents execution and therefore cannot alter Agentworks authority.
- Preflight remains disconnected because its discovery and launch semantics conflict with Agentworks controller evidence.
- Package upgrades are covered by compatibility tests.
- Removing or disabling `pi-subagents` cannot bypass Agentworks safety policy.

## 10. Release only after replacement proof

Finish installation, update, configuration, custom role-pack, recovery, and uninstall documentation.
Run formatting, lint, typecheck, unit, integration, packaging, runtime audit, and installed-package live E2E validation.
Publish `pi-agentworks` to npm and create a release tag only after all release-blocking recovery and lifecycle evidence is green.
Do not remove `pi-subagents` or the legacy Herdr pane extension until Agentworks demonstrates equivalent or stronger behavior for the required workflows.

## Immediate execution order

1. [x] Fix management-origin ownership and add cross-tab duplicate-prevention tests.
2. [x] Implement deferred-first-tick resume after successful dashboard recovery.
3. [x] Reconcile durable `launching` agents after failed process launch.
4. [ ] Complete controller and pane restoration.
   - [x] Restore one exact missing slot with exact on-disk Pi session reuse and crash-idempotent reservations.
   - [x] Add trusted status-triggered dead-controller restart with authenticated exact-composition rebuilding.
   - [x] Prove fresh parent Pi extension and gateway recovery at the process boundary.
   - [x] Restore multiple exact missing slots through one atomic reservation set and a multi-agent kill-point matrix.
   - [ ] Run real Herdr restart and multi-pane-loss E2E proof.
5. [x] Enforce the global active-agent budget.
6. [ ] Complete repeated multi-story reviewer, merge, cleanup, and completion flow.
7. [ ] Run the large-grid and restart E2E matrix.
8. [ ] Add advanced management controls and LOW/NORMAL confirmations.
9. [x] Integrate safe `pi-subagents` public components.
10. [ ] Replace host networking, complete documentation, publish, and tag.
