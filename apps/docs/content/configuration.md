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
hand, with one exception described under
[background knowledge processing](#background-knowledge-processing). If an older CLI encounters configuration written by a newer unsupported
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
because it is a setting you choose or migrate manually. Orcaops stamps a file
with the oldest version whose CLIs can read everything in it. A new file gets
`6`, because nothing in it needs more, so teammates on an earlier release can
still load a committed config. Files stamped `5`, `6`, `7`, or `8` all load to the
same settings, with the ones a file predates filled from defaults, and Orcaops
never rewrites a file because it loaded it. Changing another setting leaves the
stamp alone. The stamp moves to at least `7` when a write adds
`workflow.commit_inside_window` or `workflow.routing`, and to `8` when it adds
`knowledge_processing`, including its `tool_access` field; see
[Background knowledge processing](#background-knowledge-processing).

`bootstrap` is `manual`
here because personal scope owns no instruction file. Under project or global
scope, unattended initialization writes `"bootstrap": "managed"` unless enabled
session hooks already cover every selected agent, or the repository already has
an `AGENTS.md` or `CLAUDE.md` of its own — one that exists and carries no
orcaops block; a file already carrying a block stays managed — see
[Bootstrap](./agent-integrations.md#bootstrap).

Two `workflow` keys shape what the bootstrap surfaces say, and both ride their
defaults until you set them:

```json
{
  "schema_version": 7,
  "workflow": {
    "commit_inside_window": false,
    "routing": { "suppress": ["seed"] }
  }
}
```

`commit_inside_window` (default `true`) carries the "run tests and commit inside
the window" clause in the checkpoint guidance; `routing.suppress` drops the
read-intent line for the named skills. Both arrived in schema version 7, so a
config carrying either is refused by any CLI older than that — on the version,
with a message saying to upgrade, rather than on a key its author never typed.

`orcaops doctor` reports on the result: `session-hooks` names any installed
agent left with no bootstrap surface at all, `session-hook-payload` warns when
the text injected at every session start passes 6000 characters, and
`workflow-hints` names every declared reminder that renders on neither surface,
and why.

Interactive initialization records the choices you make—for example,
`session_hooks.enabled: true` when you accept the recommended session reminder.
Everything else (naming prefix, evaluators, digest, cache, artifacts, garbage
collection, …) rides schema defaults until you change it. `orcaops update` and
`orcaops configure` persist per-key deltas, so the file stays minimal and
portable across CLI versions. That matters at team-adoption time: the document
you commit pins your choices, not a snapshot of every default the installing CLI
happened to ship with.

## Background knowledge processing

The `knowledge_processing` section holds the settings for interpreting captured
content with a model in the background. It is off by default, for a new install
and for a configuration written by an earlier version. While it is off, Orcaops
sends nothing to a model for this purpose and spends nothing on it.

Turning it on takes two separate things. `enabled: true` chooses the settings
below; it is not consent. Sending captured content to a provider also needs a
consent grant that is stored on your machine, outside the repository, and is
tied to the project, provider, and tool-access policy. A committed `enabled: true` therefore
starts nothing on a teammate's machine, and neither does an installed provider,
`llm.tool: auto`, or an evaluator trust grant. `llm.tool: none` keeps knowledge
processing off even when it is enabled here.

`orcaops knowledge enable` does both halves in one sitting: it shows what would
be sent, records your consent for exactly that, and then sets `enabled: true`
in the file that governs this checkout. `orcaops knowledge status` reports what
is in force and what is queued, `orcaops knowledge pause --reason <text>` and
`orcaops knowledge resume` hold and lift a project-wide stop that outlives any
worker, `orcaops knowledge retry` makes a waiting job due now, and `orcaops
knowledge reopen <job>` gives a job that gave up a fresh attempt allowance at a
terminal. `orcaops doctor` says which state processing is in and what to run
about it.

Captures queue a job for interpretation as they are saved, whatever this
section says, so turning processing on later loses nothing and turning it off
throws nothing away. While `enabled` is false here, a capture starts no worker
at all. While it is true, a capture starts one afterwards — never on the
capture's own path — and these settings are what it runs under; it sends nothing
to a provider without a consent grant covering the job, and stops instead.
`orcaops knowledge enable`, `resume` and `retry` start one too, because each of
them frees work that was waiting. One worker at a time holds the project's
processing lease, and `idle_exit_ms` is how long it waits for more work before
exiting. See the
[command reference](./command-reference.md#background-knowledge-processing), and
[What Orcaops enforces, and what it only observes](./local-data.md#what-orcaops-enforces-and-what-it-only-observes)
for which of these limits refuses and which is only reported.

`ORCAOPS_KNOWLEDGE_WORKER_START` is a developer and CI switch, not a setting of
this feature: set it to `0` in an environment and nothing starts a worker there,
whatever the configuration and the consent say. Orcaops' own test suite sets it,
because those tests run commands inside the test process. Nothing in a normal
installation needs it, and it turns nothing else off: captures still queue, and
`orcaops knowledge status` still reports what is waiting.

| Setting                 | Default     | Meaning                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`               | `false`     | Whether the settings are in force. Consent is granted separately.                                                                                                                                                                                                                                                                                                                     |
| `tool_access`           | `"none"`    | `none` requires every tool to be withheld. `codex_restricted` explicitly selects the weaker, restricted Codex policy and requires matching local consent. It is valid only with `codex`.                                                                                                                                                                                              |
| `provider`              | `"inherit"` | `inherit` uses the provider `llm.tool` resolves to. `claude` or `codex` selects that provider, and no other provider is ever used in its place. See below for what each can run.                                                                                                                                                                                                      |
| `model`                 | `"inherit"` | `inherit` uses `llm.model` when it was configured for the same provider, and otherwise the provider's own default. `provider_default` always leaves the choice to the provider, whatever `llm.model` says. Any other value is a model id passed exactly as written; `none`, `default`, `auto`, and other spellings of the two setting words are refused instead of being sent as one. |
| `effort`                | `"inherit"` | `inherit` uses `llm.effort` where the provider has an effort setting. An explicit `low`, `medium`, `high`, `xhigh`, or `max` on a provider without one pauses processing.                                                                                                                                                                                                             |
| `timeout_ms`            | `300000`    | Time allowed for one call, 10000 to 3600000. Part of the window, about 1.6 seconds today, is reserved for stopping the provider.                                                                                                                                                                                                                                                      |
| `max_attempts`          | `3`         | Total attempts for one job, counting failed and uncertain calls, 1 to 10.                                                                                                                                                                                                                                                                                                             |
| `max_calls_per_hour`    | `60`        | Calls per hour for the local project database, counting retries, 1 to 3600.                                                                                                                                                                                                                                                                                                           |
| `max_input_bytes`       | `131072`    | Prepared input sent with one call, 1024 to 8388608 bytes. This is not a token limit.                                                                                                                                                                                                                                                                                                  |
| `max_output_bytes`      | `65536`     | Response bytes kept from one call, 1024 to 8388608. A longer response fails the attempt.                                                                                                                                                                                                                                                                                              |
| `max_output_tokens`     | unset       | Optional generation limit, 1 to 1000000. Processing pauses when the provider cannot enforce it.                                                                                                                                                                                                                                                                                       |
| `max_cost_usd_per_call` | `"inherit"` | `inherit` passes `llm.default_max_cost_usd` to a provider that accepts a per-call amount. `none` passes no amount. A number asks for a hard ceiling, and processing pauses when the provider cannot hold one.                                                                                                                                                                         |
| `max_cost_usd_per_day`  | unset       | Optional daily budget for the local project database. It is enforced by reserving each call's hard ceiling before the call is sent, so processing pauses when the provider cannot hold a per-call ceiling.                                                                                                                                                                            |
| `idle_exit_ms`          | `30000`     | How long the background worker waits with nothing to do before it exits, 1000 to 3600000.                                                                                                                                                                                                                                                                                             |

**`max_input_bytes` has a floor, and the schema minimum is far below it.** A call
sends the interpretation instructions and the answer schema before it sends any
of the capture, and a quarter of the cap is always reserved for related
knowledge — the records already in the project that the capture may be about —
plus a little framing around each of them, whether or not any is found. So the
smallest cap that interprets anything at all is **46986 bytes** on `claude`.
Below it every capture is a size-limit condition whatever its length, so
knowledge processing pauses and names that figure; the schema still accepts
`1024`, so a configuration written before this loads unchanged and pauses
instead of failing. The floor moves with the instructions and the answer schema,
which is why the pause message computes it rather than quoting a number from
here.

**The floor does not guarantee that every capture fits.** Above the floor, what
is left for captured text is the cap less the overhead and the reservation.
Field framing and chunk boundaries also take room, so there is no fixed capture
length at which splitting becomes possible. A capture that cannot fit within
the 64-chunk limit is refused rather than partly sent. Processing makes one call
per chunk, bounded by `max_attempts`. A capture that needs more calls than the job
has attempts left is parked on `size_limit` with nothing sent, and
`orcaops knowledge retry` takes it again once the cap or the allowance is
raised.

There is no concurrency setting: one call runs at a time for a project database.

The default `tool_access: none` policy requires every tool to be withheld.
`claude` supports it; `codex` does not and pauses under that policy. Codex can
run only with the explicit `codex_restricted` policy and consent for its
different guarantees. Selecting that policy for Claude is refused.

On `claude`, an inherited per-call amount is best effort, because
the provider stops a call only after the amount is exceeded, so one response can
cost more. For the same reason a numeric `max_cost_usd_per_call` and any
`max_cost_usd_per_day` pause the workload on `claude`: neither could be kept as
a hard limit. To run on `claude`, leave `max_cost_usd_per_call` at `inherit` or
set it to `none`, and leave `max_cost_usd_per_day` unset.

A call-count limit is not a dollar limit. When no dollar setting applies, none
is reported, and `max_calls_per_hour` is never presented as a budget. An
inherited per-call amount is a hard cap only on a provider that can hold one;
anywhere else it is best effort and is never described as a cap.
These settings cover knowledge processing on this machine's project database.
They do not cover evaluator calls, other agent sessions, other clones, or other
machines.

A well-formed setting that the selected provider cannot honor pauses knowledge
processing; it never makes a capture fail. A malformed value is a configuration error like any other. `null` is not
accepted anywhere in this section, because `inherit`, `none`, and an unset key
mean different things.

The section needs `schema_version` 8. The stamp moves to 8 in the same write
that first adds the section, so an older CLI that reads the file asks to be
upgraded instead of reporting a setting it does not know. Under project scope
the file is committed: once it carries the section, teammates on an older CLI
must upgrade before Orcaops loads their configuration. Personal scope keeps the
file out of the repository. If you add the section by hand to a file stamped `5`,
`6`, or `7`, Orcaops refuses the file until you set `schema_version` to `8` yourself.

### Restricted Codex configuration

The optional `tool_access` field requires `schema_version: 8`, like the rest
of the section. Omitting it keeps the strict `none` default.

For example, select a model explicitly and leave hard dollar and output-token
limits unset:

```json
{
  "schema_version": 8,
  "llm": { "tool": "codex" },
  "knowledge_processing": {
    "enabled": false,
    "provider": "codex",
    "tool_access": "codex_restricted",
    "model": "gpt-5.6-terra",
    "effort": "medium",
    "max_attempts": 1,
    "max_cost_usd_per_call": "none"
  }
}
```

Use the exact model ID available to your Codex account; Orcaops never replaces
an unavailable model with another. `model: inherit` instead uses `llm.model`
when it belongs to Codex. This example starts disabled: run
`orcaops knowledge enable` in your terminal to review the restricted-policy
disclosure, grant consent, and enable the worker.

Restricted processing currently requires Codex CLI `0.154.0` or newer. It reuses your
Codex login but ignores user config and execution rules for each call, supplies
its own permission profile, and runs outside the repository. Supported
tool-category switches are disabled, but this is not an all-tools-off promise.
Global `AGENTS.md` or `AGENTS.override.md` instructions may also be sent, because
this CLI version loads them despite ignoring user configuration. Their presence
does not block processing; the consent disclosure names this extra context.
Orcaops does not change those files or your login. `max_input_bytes` covers only
Orcaops' prepared content, not Codex's built-in or global instructions.
See [Restricted Codex processing](./project-knowledge-reference.md#restricted-codex-processing).
Token counts are reported when available; dollar cost remains unknown.
An inherited dollar setting that cannot be applied is reported as dropped,
not as an enforced limit.

For Codex, `max_calls_per_hour` counts worker attempts, not underlying provider
requests. The adapter disables request and stream retries, but Codex can still
send a continuation request after a built-in tool attempt. One worker attempt
is therefore not necessarily one model request or one charge.

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
