---
description: 'Configure consent-gated session guidance for supported coding agents and understand each hook surface.'
---

# Session hooks

Session hooks inject repository-aware Orcaops guidance when an agent session
starts. They complement installed skills: skills provide the capabilities, while
the hook reminds the agent to apply the capture lifecycle to ordinary
non-trivial work.

`session_hooks` is the top of the bootstrap preference ladder
(**static hook > state-aware hook > instruction block > manual**): the agent's
own hook mechanism injects Orcaops capture guidance at every session start, so
capture works even when instruction files are not read. It is off in the schema
default and in unattended initialization because user-level agent configuration
requires consent. Interactive `init` offers **On — fixed reminder** as the
recommended choice when the install set supports hooks. The hooks execute
`orcaops hook session-start`, which renders guidance fresh each session — the
installed entries carry no version stamp, so they never churn on a CLI
release.

`session_hooks.enabled` gates **emission** at runtime: the hook prints nothing
in a repo that has not opted in, no matter which registration invoked it.

## Machine-level registration (user configs)

`orcaops session-hooks install` registers the hook ONCE in your agents'
user-level configs (`~/.claude/settings.json`; Codex via its
`~/.codex/config.toml` — see below) so it
covers every repo on the machine, survives re-clones, and adds zero repo
footprint — the natural pairing for the invisible (personal-scope) install.
The hook stays completely silent in repos without Orcaops or without
`session_hooks.enabled`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored
when resolving the `~/.claude` and `~/.codex` locations.

Only `orcaops session-hooks install` and the interactive personal init ever
write a user config, and both are consent-gated by design: TTY-interactive
only, listing the exact absolute paths before writing, and hard-refusing
`--yes` / non-TTY / CI with zero writes. Your own entries in those files are always preserved (the same
merge rules as the project surface); `orcaops session-hooks uninstall`
restores the pre-consent state, and `orcaops session-hooks status` shows the
per-surface state. Repo-level `orcaops uninstall` never touches user configs
— it prints an advisory instead.

When a repo carries BOTH a project entry and the machine registration, the
machine invocation yields at runtime — guidance is injected exactly once. A
project-scope repo that prefers the machine registration can drop its
settings-file entries entirely with `session_hooks.entries: "none"`
(`orcaops update --session-hook-entries none`); `enabled` then gates emission
alone. Machine-level surfaces exist for Claude Code and Codex; Cursor and
OpenCode registrations are project-only.
If a machine-level invocation cannot read or parse the repo's project settings
file, it also stays silent rather than risk duplicate guidance. Doctor reports
the invalid file; until it is repaired, that repo may receive no guidance.

Codex is special (codex-cli 0.146+): its
`hooks.json` files are not read — hooks register via a `hooks` struct in
`~/.codex/config.toml`, gated by `hooks = true` under `[features]`, and the
`orcaops hook` emits the JSON envelope that build requires. Because
`config.toml` is your primary Codex config, `session-hooks install` offers a
choice: print the exact TOML snippet for you to paste (recommended — zero
write risk), or write an Orcaops marker-owned block for you, which is
append-only and refuses outright if your config already has `[features]` or
`hooks` tables it could collide with. Codex also reviews each new hook once
(hash-pinned trust) — approve the Orcaops entry when asked, or it is
silently skipped; the entry is version-free, so the approval never repeats.
Uninstall removes only a marker-owned block; a manual paste is yours and is
reported, never edited.

One caveat: a GUI-launched agent may not inherit your login shell's PATH. The
guarded entry stays silent in that case; `orcaops doctor` reports the missing
binary so you can expose its bin directory to agent-launched shells.

`ORCAOPS_HOOK_SUPPRESS` is the recursion guard used while Orcaops invokes an
agent for evaluator work. It follows the shared boolean environment convention:
unset, empty, `0`, and `false` leave hooks active; any other non-empty value
suppresses hook output. Do not export it globally unless you deliberately want
session-start guidance disabled.

## Payload modes

`session_hooks.payload` selects what the hook emits, read fresh at every
session start:

- `static` (default) — the same short capture nudge every session, rendered by
  the installed CLI (prefix-aware, never stale on disk) with **zero state
  reads**: no git call, no SQLite open. It points the agent at
  `orcaops status --json` for thread state.
- `state-aware` (**experimental**) — reads the branch's capture state and
  tailors the guidance: names the in-flight thread, flags an open or stale
  checkpoint, and recommends the next lifecycle step. Opt-in until A/B data
  shows it beats the constant reminder. Missing cache state is named as
  unknown rather than treated as proof that no thread exists; a commitless
  repo falls back to the static reminder. Other failures degrade to silence,
  never a broken session.

The mode is deliberately NOT baked into the installed hook entries — they are
byte-identical across modes — so switching arms is a config flip with no
reinstall, no settings churn, and **no session restart**:

```bash
orcaops update --session-hook-payload state-aware   # next session start picks it up
orcaops update --session-hook-payload static
```

Per-agent surfaces (project entries):

| Agent       | Surface                                                   | Notes                                                                                        |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Claude Code | entry in `.claude/settings.json`                          | `SessionStart` hook; stdout is added to the model context                                    |
| Codex CLI   | none — machine-level only (`~/.codex/config.toml`)        | shipped codex-cli never reads a project `.codex/hooks.json`                                  |
| Cursor      | entry in `.cursor/hooks.json`                             | `sessionStart` hook; hooks.json is VCS-checked and auto-reloads                              |
| OpenCode    | generated `.opencode/plugins/<prefix>-session-context.js` | **beta** — plugin injection rides `chat.message`; falls back cleanly to silence on any error |

The settings files are co-owned with you: Orcaops manages only the exact
canonical command, never deletes your
hooks or keys, and leaves unparseable files untouched with a warning. A
wrapped or otherwise customized command is yours and remains byte-untouched.
The OpenCode plugin is a normal generated file (stamped, manifest-tracked,
pruned/uninstalled like skills). GitHub Copilot, AiderDesk, and Antigravity do
not have a session-hook surface; for those, use the instruction block.

**Changed agents may require a restart; Cursor reloads automatically.**
Mid-session hook pickup is not documented for Claude Code or Codex. Teammates
without a global `orcaops` binary see no output from the guarded entry;
session-start hooks never block a session in any supported agent.

Enable with `orcaops init --session-hooks` (or pick a mode interactively);
disable with `orcaops update --no-session-hooks`, which strips the entries and
prunes the plugin. `orcaops doctor` owns the health check (`session-hooks`),
and `orcaops uninstall` strips the entries even without a manifest.
`--session-hook-payload` never enables hooks by itself — it only sets the
mode, which takes effect while hooks are enabled.
