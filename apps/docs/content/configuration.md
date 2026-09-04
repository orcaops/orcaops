---
description: 'Understand the minimal Orcaops configuration file and find the focused guides for each settings group.'
---

# Configuration

Orcaops stores project and global configuration in the worktree's
`.orcaops/config.json`, and personal configuration once per repository in the
git common directory (`$(git rev-parse --git-common-dir)/orcaops/config.json`),
where every linked worktree reads it. A worktree that carries a valid project
config uses that instead. Most users change settings through
`orcaops configure`, an interactive menu that previews the pending diff and
reconciles every managed install surface when you apply it; every command
names the file it actually read when something is wrong with it.

The CLI owns the file's `schema_version` metadata; do not edit that field by
hand. If an older CLI encounters configuration written by a newer unsupported
version, it refuses to modify it rather than attempting a downgrade.

Use `orcaops init --force` to reconcile Orcaops-managed files while preserving
a valid current configuration. Flags passed to that run override only their
corresponding settings. Use `orcaops init --force --reset-config` when you
explicitly want to replace the configuration with current defaults. Resetting
configuration leaves captured artifacts and cache data in place; under personal
scope the reset changes settings for every linked worktree of the repository.

## Configuration file structure

`orcaops init` writes a minimal config: the CLI-managed `schema_version`, the
install and bootstrap settings, and only the other keys that differ from their
defaults. A fresh unattended personal init, which cannot consent to hooks or
instruction-file changes, produces roughly:

```json
{
  "schema_version": 6,
  "install": {
    "agents": ["claude-code"],
    "scope": "personal"
  },
  "bootstrap": "manual"
}
```

The schema number appears here because it is present in the generated file, not
because it is a setting you choose or migrate manually.

Interactive initialization records the choices you make—for example,
`session_hooks.enabled: true` when you accept the recommended session reminder.
Everything else (naming prefix, evaluators, digest, cache, artifacts, garbage
collection, …) rides schema defaults until you change it. `orcaops update` and
`orcaops configure` persist per-key deltas, so the file stays minimal and
portable across CLI versions. That matters at team-adoption time: the document
you commit pins your choices, not a snapshot of every default the installing CLI
happened to ship with.

## Configuration guides

The settings are grouped by the job they control:

| Guide                                         | Covers                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent integrations](./agent-integrations.md) | Selected agents, personal/project/global scope, generated files, naming, bootstrap instructions, workflow hints, and install manifests. |
| [Session hooks](./session-hooks.md)           | State-aware session guidance, supported hook surfaces, machine-level registration, consent, and troubleshooting.                        |
| [Capture and data](./data-configuration.md)   | Archive, LLM selection, secret scrubbing, review limits, usage capture, and environment variables.                                      |
| [Evaluators](./evaluators.md)                 | Pack installation, authoring, enablement, trust, engine selection, and updates.                                                         |

Use `orcaops configure` for ordinary changes. The detailed pages explain the
stored fields and boundaries for team policy, automation, and troubleshooting.
