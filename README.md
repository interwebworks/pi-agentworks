# Agentworks

Agentworks is a Pi package for running real, interactive, role-specific Pi agent teams in Herdr panes.
It creates task-appropriate teams, gives every writable assignment an isolated Git worktree, and coordinates planning, review, integration, recovery, and cleanup through a durable local controller.

> Agentworks is under active development and is not ready to replace an existing subagent package yet.

## Intended installation

Local development installation will use Pi's package mechanism:

```bash
pi install /home/user/Development/agentworks
```

The same package manifest is designed for future Git or npm installation:

```bash
pi install git:github.com/OWNER/agentworks@VERSION
pi install npm:agentworks@VERSION
```

## Intended usage

```text
/agentworks
/agentworks LOW Write a release announcement
/agentworks NORMAL Implement the approved authentication feature
/agentworks HIGH Research and produce a cited technical report
```

Users can also ask naturally for an Agentworks team.
The parent Pi model will receive an `agentworks` tool for launch and management actions.

## Complexity modes

| Mode   | Maximum agents | Approval behavior                                                                         |
| ------ | -------------: | ----------------------------------------------------------------------------------------- |
| LOW    |              4 | Confirm every material design decision and every model assignment.                        |
| NORMAL |              8 | Confirm the plan, team, architecture, stories, integration target, and model assignments. |
| HIGH   |             16 | Operate autonomously inside immutable Git and security protections.                       |

The maximum includes the Project Manager and reviewers.

## Documentation

- [Product specification](PRODUCT_SPEC.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
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

## Current status

The product contract and architecture are established.
Implementation progress is tracked only in [BACKLOG.md](BACKLOG.md).
Do not uninstall `pi-subagents` or the existing Herdr mirror until the replacement passes live validation.
