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

Project Manager-only controller actions cannot be granted to ordinary roles.
Reviewer roles are always read-only.
The controller remains the sole Git mutator regardless of role-pack content.
