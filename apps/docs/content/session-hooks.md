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
user-level configs (`~/.claude/settings.json`; Codex via
`~/.codex/hooks.json` or `~/.codex/config.toml` — see below) so it
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

Codex reads hooks from two places: `~/.codex/hooks.json` and the `hooks`
tables in `~/.codex/config.toml`. Orcaops registers in exactly ONE of them, so
your Codex layer keeps a single representation:

- **`hooks.json`** when that file already exists (some editor and agent-wrapper
  tools install their own hooks there), or when neither representation is in
  use. This is the
  same JSON merge Claude Code gets: Orcaops adds one `SessionStart` group and
  preserves every other event and entry byte-for-byte. Our group goes first,
  because a tool that rewrites the file re-appends its own groups and would
  otherwise reshuffle ours on every write.
- **`config.toml`** when you already keep your own hooks there, or when the
  installed Codex cannot be shown to read the sidecar — Orcaops requires a
  build it has measured loading a `hooks.json` hook (codex-cli 0.146.0), and an
  unreadable `codex --version` counts as unproven. The consent screen says
  which of those applied.

`orcaops session-hooks install --representation hooks-json|config-toml`
overrides the choice; overriding a failed version gate is warned about,
because a build that does not read the file you picked runs no hook at all.

No feature flag is needed either way: hooks are on by default since codex-cli
0.124, so the registration is one `SessionStart` group and nothing else (the
`orcaops hook` emits the JSON envelope Codex requires).

Because `config.toml` is your primary Codex config, the `config.toml` path
offers a choice: write an Orcaops marker-owned block for you (recommended), or
print the exact TOML snippet for you to paste. Managed mode appends that one
table between marker comments and never edits anything else — your
`[features]` table, your own hooks, and the trust tables Codex writes are left
byte-identical, even when Codex places them inside the markers. A manual paste
is detected by content, so status reports it as installed. Managed mode
refuses, and writes nothing, when the file is not valid TOML outside the
Orcaops block, when `hooks.SessionStart` already has a shape it cannot append
to, or when the block holds lines it cannot prove are its own. The `hooks.json`
path has no such chooser — consent already named the file, and Orcaops never
deletes another tool's `hooks.json`, strips only its own entry, and leaves a
file it cannot parse untouched.

**Migration.** A machine that carries the registration in both files (an older
Orcaops wrote `config.toml` beside a sidecar another tool owns) is migrated by
the next `orcaops session-hooks install` — never by `update` or `doctor --fix`,
because only install is consent-gated. The group moves into `hooks.json`, the
approval you already gave Codex is carried across so you are not asked again,
and the `config.toml` block is then removed. If the approval cannot be moved,
or the removal is refused (a hand-pasted entry, malformed markers, a file that
stopped parsing), both stay registered and Orcaops names the `config.toml` to
clean up yourself; re-running install retries the move. `orcaops doctor` then
warns about the leftover block — the hook itself is registered and working.
While both files really do register hooks, Codex prints an informational
"loading hooks from both" line at startup — both sets run, and Orcaops says so
after install, in `session-hooks status`, and in `doctor`.
After a migration only one file registers, so that line and the note go away.

Codex reviews each new or changed hook once (hash-pinned trust) — approve the
Orcaops entry when asked, or it is silently skipped (`codex exec` skips an
unapproved hook without a message). The entry is version-free, so the approval
never repeats. Codex records that approval in `config.toml` whatever file the
hook came from, and keys it by the hook's position in that file — so inserting
our group ahead of the hooks already in a `hooks.json` moves the keys of their
approvals. Orcaops relocates every approval the insertion disturbs, in the same
edit that carries its own: those hooks keep working and are not re-approved. An
approval whose new key is already held by a different live approval cannot be
moved — the install output names it, and Codex asks about that one hook once.
An approval left behind by a group the reconcile removed (a stale entry of ours
from an older release) is retired with it.

Uninstall removes only what Orcaops owns: its own `hooks.json` entry (your
file, and every other tool's entry in it, survives) or a marker-owned
`config.toml` block. A manual paste is yours and is reported, never edited.

One caveat: a GUI-launched agent may not inherit your login shell's PATH. The
guarded entry stays silent in that case; `orcaops doctor` reports the missing
binary so you can expose its bin directory to agent-launched shells.

`ORCAOPS_HOOK_SUPPRESS` is the recursion guard used while Orcaops invokes an
agent for evaluator work. It follows the shared boolean environment convention:
unset, empty, `0`, and `false` leave hooks active; any other non-empty value
suppresses hook output. Do not export it globally unless you deliberately want
session-start guidance disabled.

## Detecting a lost registration

Machine hooks live in files Orcaops shares with the agent — and with any other
tool that writes them. If one of those writers rewrites the file and drops the
Orcaops entry, the hook cannot report its own absence: it is simply never
invoked again, and sessions go quiet without an error.

`orcaops doctor` and `orcaops session-hooks status` both answer the same
question, from the same inspection: **does this repository depend on a machine
registration that is not there?**

### What is required of whom

A machine registration is required for an agent when hooks are enabled, the
agent is in the install set, the agent has a machine-level surface, and
configuration does not select a project hook entry for it. In practice:

| Situation                      | Who needs a machine registration                        |
| ------------------------------ | ------------------------------------------------------- |
| Project scope, project entries | Codex (it has no project surface); Claude Code does not |
| Project scope, `entries: none` | every machine-capable agent in the install set          |
| Personal or global scope       | every machine-capable agent in the install set          |
| `session_hooks.enabled: false` | nobody                                                  |

Scope decides where integrations are **installed**, not whether the hook
fires. A repository under global or personal scope with hooks enabled still
emits guidance, carried by the machine registration.

### What counts as covered

Coverage is deliberately strict, and separate from ownership. An entry
verifies coverage only when it is the exact canonical command, in the expected
event, as a `command` hook, under a matcher that includes every session-start
alternative Orcaops registers for. A broader matcher of your own still covers.

These do **not** count, even though the command text is present:

- the command in an unrelated field, or under a different event;
- a hook whose `type` is missing or is not `command`;
- a matcher that cannot fire for the sessions the hook targets;
- a registration under a former `CODEX_HOME` or `CLAUDE_CONFIG_DIR` — it stays
  visible for diagnosis and uninstall, but cannot cover the agent today.

Ownership stays deliberately broader than coverage, which is why a stale or
hand-edited variant of the Orcaops line is still repaired and removed by
`session-hooks install` / `uninstall` even when it no longer counts as covered.

Codex has two candidate files and loads both, so a registration in either one
covers it. Its `features.hooks` setting (and the retired `codex_hooks` alias,
which `hooks` overrides) disables **every** Codex hook — so with that set to
false, a canonical registration in `hooks.json` is reported broken, and the
remedy is to enable the setting, not to reinstall.

### What the states mean

| State          | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `covered`      | a verified registration exists at a current candidate path        |
| `missing`      | every current candidate is confirmed to lack a valid registration |
| `broken`       | something is registered, or explicitly disabled, and will not run |
| `unknown`      | a candidate could not be inspected, or holds a customized command |
| `not-required` | this agent does not depend on a machine registration here         |

`unknown` is never reported as a removal. A file that could not be read, or a
customized command whose behavior cannot be verified, is a question — not
evidence that anything was deleted. A recorded registration that is gone is
described as missing; an unmet dependency with no record behind it is reported
as an unmet dependency, without claiming anything was removed or corrupted.

### Recovery

Detection never writes your agent configuration. Repair is the explicit,
consented command:

```bash
orcaops session-hooks install --agents codex         # or claude-code
orcaops session-hooks status                          # confirm coverage
```

Existing agent sessions may need restarting afterwards, as the install
command's own notice says. If the reported state is `unknown` because a
customized command is present, review that entry yourself first: installing
alongside it adds a second canonical entry and may duplicate guidance.

If you would rather not run machine hooks at all, `orcaops update
--no-session-hooks` disables them — note that this affects every agent
governed by that repository configuration, including personal siblings.

### Limits worth knowing

- Diagnostics verify **registration**, not execution. They cannot prove a
  running agent has reloaded its configuration or will inject the guidance.
- Detection is on demand. Someone who runs neither `doctor` nor `session-hooks
status` gets no proactive alert; there is no background monitoring, polling,
  or automatic restoration.
- Orcaops does not attribute a lost entry to any particular application. A
  shared file was rewritten; which writer did it is not something the record
  can establish.
- `orcaops session-hooks status` outside a configured repository still lists
  the machine inventory, and reports the repository as unconfigured rather
  than implying nothing is required.

## Payload modes

`session_hooks.payload` selects what the hook emits, read fresh at every
session start:

- `static` (default) — the same capture nudge every session, rendered by the
  installed CLI (never stale on disk) with **zero project-state reads**: no git
  call, no SQLite open. It points the agent at `orcaops status --json` for
  thread state. "Static" means it reads no capture state, not that it is a
  constant: the payload is rendered from your configuration, so the scope, the
  install set, the enabled skills, `workflow.hints`,
  `workflow.commit_inside_window` and `workflow.routing.suppress` all shape it.
  When no managed block is carrying skill routing, the payload carries the
  phrasing-to-skill routing too, which is what makes a hooks-only repository
  work; where the block already carries it, the hook stays short.
- `state-aware` (**experimental**) — reads the branch's capture state and
  tailors the guidance: names the in-flight thread, flags an open or stale
  checkpoint, and recommends the next lifecycle step. Opt-in until A/B data
  shows it beats the constant reminder. Missing cache state is named as
  unknown rather than treated as proof that no thread exists; a commitless
  repo falls back to the static reminder. Other failures degrade to silence,
  never a broken session. It _prepends_ that state to the same closing rows
  every payload shares, rather than replacing them, so the pointer at
  `orcaops status --json` still appears below a thread the payload has already
  named. The shared tail is deliberate: a branch that rendered its own was how
  the hook once came to carry the lifecycle and nothing else.

The mode is deliberately NOT baked into the installed hook entries — they are
byte-identical across modes — so switching arms is a config flip with no
reinstall, no settings churn, and **no session restart**:

```bash
orcaops update --session-hook-payload state-aware   # next session start picks it up
orcaops update --session-hook-payload static
```

Per-agent surfaces (project entries):

| Agent       | Surface                                                                     | Notes                                                                                                                         |
| ----------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | entry in `.claude/settings.json`                                            | `SessionStart` hook; stdout is added to the model context                                                                     |
| Codex CLI   | none — machine-level only (`~/.codex/hooks.json` or `~/.codex/config.toml`) | one `SessionStart` group in whichever file Orcaops registered in, no feature flag; Orcaops writes no project-level Codex file |
| Cursor      | entry in `.cursor/hooks.json`                                               | `sessionStart` hook; hooks.json is VCS-checked and auto-reloads                                                               |
| OpenCode    | generated `.opencode/plugins/<prefix>-session-context.js`                   | **beta** — plugin injection rides `chat.message`; falls back cleanly to silence on any error                                  |

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
prunes the plugin. `orcaops doctor` owns the health checks: `session-hooks` for
the surfaces, and `session-hook-payload`, which warns once the rendered payload
passes 6000 characters — a long `workflow.hints.custom` is the usual cause, and
nothing is ever truncated. `orcaops uninstall` strips the entries even without
a manifest.
`--session-hook-payload` never enables hooks by itself — it only sets the
mode, which takes effect while hooks are enabled.
