# Agentworks

Agentworks is a Pi package that runs role-aware, interactive Pi agent teams in Herdr panes.
Each writable assignment gets its own isolated Git worktree, and the controller — a separately supervised local process — is the sole Git mutator: agents never merge, force-push, or touch the original checkout themselves.

> Agentworks is under active development and is not ready to replace an existing subagent package yet.

## Requirements

- Node.js 24 or newer (the controller uses the built-in `node:sqlite` module).
- Linux with [Bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) installed. Agentworks fails closed if a trusted `bwrap` cannot be found — there is no unsandboxed fallback.
- [Herdr](https://herdr.dev) for the management pane and per-agent panes.
- Git.
- Pi itself — Agentworks is a Pi package, installed and loaded through Pi's package mechanism, not a standalone CLI.

## Installation

Local development installation uses Pi's package mechanism:

```bash
pi install /home/user/Development/agentworks
```

Use an absolute path. This local installation path has been verified in a disposable Pi project. The canonical GitHub repository can also be installed directly; npm installation will be available after the first npm publication:

```bash
pi install git:github.com/interwebworks/pi-agentworks@VERSION
pi install npm:pi-agentworks@VERSION
```

**Current status of the installed package:** the package loads and registers the `/agentworks` command and model-callable `agentworks` tool (see `src/extension/index.ts`).
Parent sessions use a private default runtime root under `~/.pi/agent/agentworks/runtime`; `AGENTWORKS_RUNTIME_ROOT` remains available for explicit overrides.
Status requests use the authenticated controller read gateway and launch creates a durable planning run through the authenticated controller.
In a Herdr/Pi session, HIGH launches create a fail-closed right-side management dashboard and start the composed Project Manager, advisor, and story writer in one `Pi Agents` tab.
Missing model, workspace, origin-pane, or dashboard evidence is reported as an error rather than an apparent launch.
Every built-in role declares `networkAccess: required` because a Pi child must reach its configured model provider.
A custom role may declare `networkAccess: disabled` only when it runs against an offline provider; otherwise model turns fail before the agent can perform work.
Each private child configuration receives only the selected provider credential.
Completion and live Herdr restart/reconnect validation remain deployment checks;
the parent approval, steering, pause/resume, focus, close, idle-supervision, and
renewed-review controller paths are implemented and covered at the state boundary.
See [Project status](#project-status--roadmap) below.

## Configuration

### Complexity modes

Invoke a mode explicitly with `/agentworks LOW|NORMAL|HIGH <task>`, or let the default apply. Each mode is a fixed policy (`src/domain/complexity.ts`):

| Mode   | Maximum agents | Approval policy                | Requires plan confirmation | Requires model confirmation | Autonomous scheduling |
| ------ | -------------: | ------------------------------ | :------------------------: | :-------------------------: | :-------------------: |
| LOW    |              4 | `every-material-decision`      |            yes             |             yes             |          no           |
| NORMAL |              8 | `plan-and-material-deviations` |            yes             |             yes             |          no           |
| HIGH   |             16 | `autonomous-with-hard-guards`  |             no             |             no              |          yes          |

The agent maximum includes the Project Manager and any reviewer roles; the controller and dashboard processes are not agents and do not count against it.

- **LOW** assumes weak agent reasoning. It confirms domain, team, architecture, technology, stories, acceptance criteria, branches, models, and every material design decision before proceeding.
- **NORMAL** assumes capable reasoning under supervision. It confirms the overall plan, team, architecture, technologies, stories, integration target, and model assignments, and agents must escalate material deviations and blockers.
- **HIGH** assumes strong autonomous reasoning. It can proceed without routine confirmation inside immutable security and branch protections, and only notifies the user for material decisions and failures.

### Approval checkpoints

Approval behavior is mode-specific and always gated at the domain layer (`src/domain/approval-policy.ts`), not left to agent judgment:

- LOW and NORMAL both require confirming the plan and the model assigned to each role before work starts.
- LOW additionally requires confirmation of every material design decision as the run proceeds.
- HIGH skips routine confirmation but keeps hard guards active for destructive Git operations, secret access, writes outside an agent's assigned worktree, protected branches, and unsafe cleanup — these guards do not relax in any mode.

## Custom role packs

Role packs are data-only directories: one strict `pack.json` manifest plus the Markdown prompt files it references. No code ships inside a pack.

```text
role-packs/example/
├── pack.json
└── prompts/
    └── analyst.md
```

### Manifest shape

A manifest (validated by `src/domain/role-pack.ts`) declares:

- `schemaVersion` (must be `1`), `id`, `name`, `description`, `domains`, `requiresPacks`.
- One or more `roles`, each with: `id`, `label`, `description`, `authority` (`project-manager` | `reviewer` | `worker` | `advisor`), `required`, `taskKinds`, `responsibilities`, `promptFile`, `tools`, `controllerActions`, `writePolicy` (`read-only` | `story-writer`), `networkAccess` (`disabled` | `required`), and optional `defaultModel` / `defaultThinking`.

Unknown manifest fields are rejected outright. Manifest and prompt files cannot be symbolic links, and prompt paths must resolve inside the pack directory.

### Safety rules enforced at load time

- **Reviewer roles are always read-only** — a reviewer with `writePolicy: "story-writer"` or a `write`/`edit` tool fails validation.
- **Project Manager-only controller actions cannot be granted to ordinary roles.** Actions like `manage-backlog`, `assign-task`, `steer-agent`, `request-merge`, and `request-cleanup` are rejected on any role whose `authority` isn't `project-manager`.
- **The controller remains the sole Git mutator regardless of role-pack content.** No role, tool, or controller action can perform a Git write directly — every Git mutation is routed through the controller's own candidate-commit, merge, and cleanup policies.

### Discovery precedence and trust gate

Packs are discovered from three roots and merged by `src/infrastructure/role-packs/file-role-pack-repository.ts`:

1. **builtin** — the packs shipped in this repository's `role-packs/` directory (`general-delivery`, `research`, `software-development`, `writing-and-authorship`).
2. **user** — packs under the Agentworks user configuration directory.
3. **project** — packs discovered inside the current project, loaded **only from trusted projects** and only with the approval required by the active complexity mode.

When the same pack `id` appears at more than one scope, the higher-precedence scope wins in this order: project overrides user, user overrides builtin. Duplicate pack IDs discovered at the _same_ scope are rejected as a diagnostic rather than silently picking one. Untrusted projects never have their packs loaded, regardless of complexity mode.

See `role-packs/README.md` for the on-disk contract and the four built-in packs under `role-packs/*/pack.json` for worked examples.

## Recovery

On startup, the controller runs a durable recovery gate (`src/domain/recovery.ts`) before it accepts new work:

1. It first checks persisted controller state for any agent left in `launching`, `working`, or `reviewing`, any story left `awaiting-candidate` or `merging`, or any terminal run that still shows an active agent — any of these blocks new work by default (`reconciliation-required`).
2. It then reconciles each flagged reason against **live evidence** from Git and Herdr — whether a candidate commit or merge commit actually landed, and whether the agent's Herdr pane is still alive. Reconciliation can only make the gate _more_ permissive: a reason resolves only when live evidence proves the phase completed or the entity is gone. Missing or ambiguous evidence is always treated as `unresolved` and keeps the gate closed — it is never assumed safe.
3. The run becomes `ready` only once every flagged reason reconciles to `resolved`.

Separately, the controller detects physical and semantic database corruption at startup and quarantines the corrupt database file rather than starting against unreliable state.

## Uninstall

Remove the package the same way any Pi package is removed — through Pi's package mechanism (consult `pi uninstall` in your installed Pi version). Agentworks does not modify Pi's installed source, so removing the package is reversible and leaves no changes behind in Pi itself.

Do not uninstall `pi-subagents` or the existing Herdr mirror (`pi-herdr-subagent-panes.ts`) until Agentworks passes live end-to-end validation — see [Project status](#project-status--roadmap).

## Project status / roadmap

Implementation progress is tracked canonically in [BACKLOG.md](BACKLOG.md); this is a short honest summary, current as of this writing. P0 through most of P6 are implemented and tested (complexity/task contracts, role-pack loading, controller state/persistence/protocol/recovery, Git isolation and worktree lifecycle, role packs and team composition, the Bubblewrap sandbox, and Herdr tab/pane/layout/alert adapters). Not yet implemented:

- **Mode-specific TUI approvals** and Project Manager tuning/supervisor messages from the parent (P3).
- **Structured agent lifecycle/operation/result/blocker communication** and disconnected-pane detection with resumable session restoration (P6) are implemented at the authenticated controller boundary; installed live restart/reconnect proof remains.
- **Advanced management controls** - authenticated approval/steering/pause/resume/focus/close actions are implemented; independent scrolling/sorting, colorized presentation, mouse/keyboard navigation, and the persistent overlay remain (P7).
- **The parent Pi extension's real behavior** — status uses the authenticated controller read gateway and launch creates a durable planning run under the private default runtime root (or `AGENTWORKS_RUNTIME_ROOT` when explicitly configured). Herdr/Pi sessions with the required environment now enable the production orchestration provider and request the first HIGH tick; the persistent right-side overlay, narrow-terminal fallback, run restoration, and full child lifecycle remain under validation (P8).
- **Orchestration** — dependency-aware scheduling, concurrency caps, controller-side writer/reviewer launches, reviewed merge requests, run completion, safe cleanup, bounded idle nudges, and fresh writer/reviewer attempts after rejected review are implemented in the core and covered by tests (P9).
- **Distribution polish** — this document plus package metadata (P10, in progress), replacing `pi-herdr-subagent-panes.ts` and retiring `pi-subagents` only after live validation, and migrating any still-useful concepts from the prior architect/worker definitions.
- **Live end-to-end proof** — LOW/NORMAL/HIGH scenario tests, sandbox-escape negative tests, Herdr layout tests at 1/4/6/9/12/16 agents, and a fully green formatting/lint/typecheck/unit/integration/packaging/E2E suite (P11).

## Documentation

- [Product specification](PRODUCT_SPEC.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Role packs](role-packs/README.md)
- [Canonical backlog](BACKLOG.md)

## Development

```bash
npm install
npm run quality
```

Node.js 24 or newer is required because the controller uses the built-in `node:sqlite` module.
Runtime dependencies remain minimal and Pi-provided packages are declared as peers.

## Security posture

Agentworks launches processes with explicit argument arrays and role-specific tool permissions.
It does not forward sensitive environment variables by default.
It requires an OS-enforced child sandbox and does not mistake prompts, tool lists, or cwd for security boundaries.
It never runs an agent in the repository's original checkout.
The controller is the sole Git mutator, and agent sandboxes receive read-only Git metadata.
It does not delete a worktree until review, merge, cleanliness, and ancestry checks all pass.
It does not merge into a default or protected branch without explicit user approval.
