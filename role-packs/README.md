# Agentworks Role Packs

Role packs are data-only directories containing one strict `pack.json` manifest and referenced Markdown system-prompt files.
Built-in packs live here.
User packs live under the Agentworks user configuration directory.
Project packs are loaded only from trusted projects and only with the approval required by the active complexity mode.

A pack has this shape:

```text
role-packs/example/
├── pack.json
└── prompts/
    └── analyst.md
```

Manifest and prompt paths cannot be symbolic links.
Prompt paths must remain inside the pack directory.
Unknown manifest fields are rejected.
Role tools, write policy, network requirements, controller actions, and prompt sizes are validated before a pack becomes selectable.

Child Pi extension discovery is disabled.
Therefore role tools are limited to Pi's built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools.
A pack declaring an unavailable extension tool is rejected before launch.
Every built-in role includes `bash` so it can run diagnostic and validation commands.
Read-only roles remain filesystem read-only even when they can run shell commands.

Controller actions are limited to implemented authenticated child-bridge operations: `report-status`, `contact-manager`, `submit-work`, and `submit-review`.
A role cannot advertise a controller action that the child bridge cannot actually perform.
Reviewer roles are always read-only.
The controller remains the sole Git mutator regardless of role-pack content.
