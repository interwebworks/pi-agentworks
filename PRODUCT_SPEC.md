# Agentworks Product Specification

## Product statement

Agentworks is a Pi package that creates real, interactive, role-specific Pi agents inside Herdr panes.
It assembles a task-appropriate team for software development, writing and authorship, research, and other project-delivery work.
Every worker receives fresh context, a role-specific system prompt, and a complete task specification that removes avoidable ambiguity.

## Invocation

Users can open the workflow with `/agentworks` or invoke `/agentworks LOW|NORMAL|HIGH <task>`.
The package also registers an `agentworks` tool so the parent Pi model can launch and manage a run when the user requests agent work in natural language.
Before it creates controller state or opens the management pane, Agentworks invokes the selected parent model as the sole preflight planner with bounded read-only repository inspection tools and requires a validated structured story plan.
The parent can inspect, tune, steer, pause, resume, approve, reject, focus, detach, and close runs.

## Complexity modes

LOW assumes weak agent reasoning.
It permits at most four agents and requires confirmation of domain, team, architecture, technology, stories, acceptance criteria, branches, models, and every material design decision.

NORMAL assumes capable reasoning with supervision.
It permits at most eight agents and requires confirmation of the overall plan, team, architecture, technologies, stories, integration target, and model assignments.
Agents must escalate material deviations and blockers.

HIGH assumes strong autonomous reasoning.
It permits at most sixteen agents and can proceed without routine confirmation inside immutable security and branch protections.
The user receives notifications for material decisions and failures.

The agent limit includes the Project Manager and reviewer agents.
The controller and dashboard processes are not agents.

## Team and roles

Role definitions are supplied by extensible domain packs.
Initial packs cover software development, writing and authorship, research, and general project delivery.
Each role defines its purpose, system prompt, default tools, write authority, review duties, model preferences, and reporting contract.
Agentworks selects only roles germane to the requested work.
Users can install additional packs without changing Agentworks source.

Every team includes a Project Manager.
The Project Manager converts the request into precise user stories, assigns work, monitors dependencies, steers stalled agents, coordinates review, requests controller-executed integration of approved branches, and reports decisions.
The parent Pi session can tune the Project Manager during a run.

## Task contract

An agent cannot start until its assignment includes a fully prepared task specification.
The specification includes a user story, objective, acceptance criteria, branch name, base branch, worktree path, in-scope and out-of-scope behavior, technology choices, constraints, dependencies, deliverables, validation commands, tool permissions, and escalation conditions.
Assignments must be explicit enough for a junior contributor to execute without inventing product or architecture decisions.

## Git isolation and integration

Agentworks never runs an agent in the repository's original working directory.
The Project Manager receives an integration branch in a dedicated worktree.
Every independently writable story receives its own branch and worktree.
Only one writing agent owns a story worktree at a time.
Read-only specialists may inspect a story worktree.

A reviewer must approve a completed story before integration.
The Project Manager requests integration of approved story branches.
The controller is the sole Git mutator and performs candidate commits, approved merges into the integration worktree, and verified cleanup.
Agentworks verifies the merge and a clean story worktree before removing that worktree.
Blocked, failed, conflicted, dirty, or unmerged worktrees remain intact and trigger an alert.
Agentworks never force-pushes, discards unmerged work, or merges into the default or a protected branch without explicit user approval.

## Herdr experience

The parent Herdr tab receives a vertically oriented management pane on the right.
A dedicated tab named `Pi Agents` contains each interactive Pi agent in its own pane.
Agent panes form a balanced grid from one pane through sixteen panes.
Four agents use a 2x2 grid, six use a 2x3 grid, and sixteen use a 4x4 grid.
Completed panes remain open until the user closes the run.

The management interface follows an htop-style layout.
It shows run metadata, user stories, dependency-aware todos, agents, status, current operation, branch, worktree, decisions, approval requests, and communications.
The todo and agent sections scroll and sort independently.
Selecting an agent focuses its Herdr pane.
Mouse operation is supported with keyboard navigation as a reliable fallback.
State colors and Herdr audio notifications identify working, waiting, blocked, failed, review, merged, and completed states.

## Parent Pi experience

While a run is active, Pi shows a persistent right-side Agentworks overlay containing the todo list and compact run status.
The overlay can be focused, hidden, restored, and used to manage the run.
It remains useful after a Herdr client disconnects or an agent tab must be restored.
On narrow terminals, Agentworks shows a compact non-obstructive status and provides a command to open the full overlay.

Pi's extension API does not provide a docked reflowing sidebar.
Agentworks therefore uses Pi's supported non-capturing right-side overlay rather than modifying Pi core.

## Controller and recovery

A separately supervised local controller owns the authoritative state in SQLite and exposes an authenticated Unix socket.
It uses a writer lease, fencing token, expected revisions, and idempotency keys so stale or duplicate requests cannot repeat external effects.
The management pane and Pi overlay are authoritative views of controller state.
Parent, Project Manager, and worker processes report through the controller rather than scraping terminal text.

Runs survive parent Pi restarts and Herdr client disconnects.
A missing or closed agent pane is marked disconnected and alerts the user.
When recovery metadata and the Pi session remain valid, Agentworks can recreate the pane and resume the agent.
Closing a tab is not silently treated as successful completion.

The Project Manager monitors incomplete agents.
When an agent becomes idle without completing its assignment, the manager sends a `.` prompt as a liveness nudge.
Nudges are bounded and followed by escalation rather than an infinite prompt loop.

## Security requirements

Roles receive strict tool allowlists, but prompts, tools, and cwd are not treated as a sandbox.
Every child runs inside an approved OS-enforced sandbox that mounts the host root and Git metadata read-only while exposing only the assigned worktree and dedicated runtime paths as writable.
The first production sandbox is Linux Bubblewrap, and Agentworks fails closed when it is unavailable.
Read-only roles cannot write.
Writers can modify only their assigned worktree.
Sensitive environment variables are not forwarded by default.
Network access is available only to roles that require it.
Hard protections remain active in HIGH mode for destructive Git operations, secret access, writes outside assigned scope, protected branches, and unsafe cleanup.

Project-provided role packs and configuration are loaded only from trusted projects and require the approval appropriate to the selected complexity mode.
Controller sockets and state files use user-only permissions.
All subprocess launches use argument arrays rather than shell interpolation unless an audited shell boundary is unavoidable.

## Distribution

Agentworks is a standard Pi package with a `pi` manifest.
It supports local installation with `pi install /absolute/path/to/agentworks` and future Git or npm distribution through the same Pi package mechanism.
It includes reversible installation and migration documentation.
It does not modify Pi's installed source.
