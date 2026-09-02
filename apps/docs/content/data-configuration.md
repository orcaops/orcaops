---
description: 'Configure archives, LLM tools, secret scrubbing, review limits, usage capture, and environment overrides.'
---

# Capture and data configuration

These settings control local history, model-backed workflows, secret protection,
review evidence, usage attribution, and process-level overrides. See
[Local data](./local-data.md) for the plain-language storage and Cloud boundary.

## Durable archive

`archive.enabled` defaults to `true`. Captured history is mirrored into the
user's Orcaops data directory so it survives deletion of the current worktree.
Interactive, non-interactive, and `--yes` initialization all use this durable
default.

Set `archive.enabled` to `false` or run `orcaops archive disable` to stop
mirroring for a worktree. Disabling retains data already archived;
`orcaops archive prune` is the explicit deletion path. Set
`archive.redact_secrets` to `true` when the archive copy should redact
secret-shaped strings instead of preserving byte-identical payloads. It
defaults to `false`, so the mirror holds event text as written — outside the
repository, outside `.gitignore`, and surviving deletion of the worktree. That
default is deliberate: the mirror is what a cold-start `orcaops resume` restores
from in a fresh checkout, and a redacted mirror restores redacted text.
`orcaops doctor` reports which of the two postures a repository is in.

Use `orcaops archive enable` to enable mirroring and backfill existing local
history. A retained archive directory after disabling is informational rather
than configuration drift; `orcaops doctor` reports its path and the choices to
re-enable mirroring or reclaim the space.

## LLM settings

Orcaops delegates LLM work to local CLI tools instead of storing API keys directly.

The most important field is `llm.tool`:

- `auto` chooses an available local tool.
- `claude` uses the Claude CLI.
- `codex` uses the Codex CLI.
- `none` disables LLM-backed evaluator work.

The global `llm.model` is a fallback for evaluators whose pack and per-evaluator
configuration do not select a model. `null` passes no `--model` flag. The
remaining global fields control effort and the per-call cost limit. Evaluator
timeouts do not use a global setting: they resolve from the per-evaluator user
override, then the pack spec, then the pack-manifest default.

Per-evaluator provider, model, and timeout overrides live in
`.orcaops/evaluators.yaml`; see [Evaluators](./evaluators.md). A user override
wins the pack author's value for these operational fields only.

## Secret protection and scrubbing

Orcaops checks agent-authored content for recognizable credentials before a
local capture write or a Cloud-bound operation. The scanned surface includes
lifecycle narrative, assembled plan fields such as derived branch metadata,
resolved local and approved Cloud source plans, and authored fields sent by plan
upload and review commands.

A **refuse-tier** credential—a vendor prefix, a PEM block, or a `key=value`
whose value carries credential shape—stops the operation before a write,
snapshot, content hash, or anything authored reaching the network. A Cloud-bound
command may still complete a capability handshake first; nothing you wrote is
part of it. Other recognized shapes, such as a JWT or an `Authorization:`
header, do not block. Successful JSON responses include
an optional `secret_warnings` array, and human-readable commands print the same
warnings to stderr. Each warning contains only its field path, matched pattern
names, and any bounded key prefix; it never includes the detected value, match
offset, or match length. Warn-tier findings are ephemeral: they are not stored
in artifact events, evaluator history, or the digest. Output-time redaction
remains a separate backstop.

Local source plans are scanned before their hash is minted. Approved Cloud plan
content is scanned without changing its approved bytes. If an approved pin is
refused, either add the exact detected value to `redact.allow` after confirming
it is dead, or correct, re-upload, re-approve, and pull the Cloud plan. The same
existing configuration keys apply across every scan surface; this behavior
introduces no separate secret-check setting.

```json
{
  "capture": {
    "exclude": [],
    "exclude_builtins": true
  },
  "redact": {
    "allow": []
  }
}
```

`capture.exclude` adds glob patterns to a built-in set of credential-bearing
filenames (`.env*`, key material, credential JSON) whose matching **untracked**
files are kept out of snapshot trees. Additions never narrow the built-in set —
`exclude_builtins: false` is the one, deliberate way to do that. Note that
`**/.env.*` matches `.env.example` too: a template is trivially re-derivable and
its absence from a snapshot tree costs nothing.

`redact.allow` holds **exact literal strings** that must not cause a refusal.
It exists for a published example credential, or a synthetic fixture you have
read and judged dead — the cases where "rewrite the narrative" is not available
because there is nothing to rewrite.

It is narrow on purpose:

- An entry matches the **exact detected string**, never a pattern, a field or a
  path. It cannot widen to cover something nobody vetted.
- Under `install.scope` `project` or `global` it lives in committable config,
  so an entry lands in a tracked file and shows up in the diff a reviewer
  reads — louder than the refusal it bypasses. Nothing at runtime checks that
  the file is committed or clean, so this is reviewability rather than a
  restriction on who may add one. Under `personal` scope — the scope a fresh
  `orcaops init` writes — `.git/info/exclude` hides the whole `.orcaops/` store
  and Orcaops writes no tracked file at all, so an entry made there reaches no
  reviewer; only the exact-string rule above still constrains it.
- Globs and regex are not accepted. A pattern entry would be an agent-reachable
  bypass, and evaluating user regex over every payload string would create a
  denial-of-service risk.

An allowed string is dropped from refusal and warning reports entirely, because
you have already looked at it.

## Diff size caps

There are **two configurable collection caps** plus a fixed forensic transport
ceiling. They are not interchangeable.

```json
{
  "diff_fingerprint": {
    "enabled": true,
    "max_diff_bytes": 2000000
  },
  "review": {
    "max_diff_bytes": 10000000,
    "include_untracked": [],
    "stub_paths": ["fixtures/corpora/**"]
  }
}
```

`diff_fingerprint.max_diff_bytes` (default 2 MB) caps the diff captured into a
**checkpoint's fingerprint manifest** at close. This value is recorded inside the
manifest and hashed into its `manifest_hash`. Treat it as durable: it is not a
performance knob, and there is no reason to reach for it.

`review.max_diff_bytes` (default 10 MB) caps the **live `base → pinned` review
diff** that `orcaops review` collects, attributes, and writes to
`.orcaops/reviews/<slug>/diff.patch`. It touches no durable identity, so this is
the collection cap to adjust when a very large branch outgrows the default.

The Task Review forensic lane also has a fixed 2 MB transport ceiling for the
eligible diff it serves to the reviewer. Raising `review.max_diff_bytes` cannot
raise that separate ceiling. Narrow the review scope for an ordinary oversized
change. When the bulk is committed generated fixtures, evaluation corpora, or
similar reviewable-but-low-value material, add explicit repo-relative globs to
`review.stub_paths`. Matching files are held out of the verbatim forensic
payload and disclosed as loud stubs with their path, added/deleted rows, byte
size, and `review.stub_paths` reason. Their bytes do not count against the
forensic transport ceiling.

`review.stub_paths` is an explicit human policy, not an importance heuristic.
Do not use it to hide ordinary implementation code. It also differs from
`capture.exclude`: excluded content is withheld as a security boundary, while a
review stub remains visible in the changed-file inventory and disclosure.

Review trees include tracked modifications and deletions by default. Non-ignored
untracked files are excluded and disclosed so a local transcript, export, or
archive cannot silently become review evidence or consume the cap. Add an exact
repo-relative file path to `review.include_untracked` only when it is intentional
source evidence. Ignored/generated paths are never admitted through this opt-in;
rejected entries are disclosed separately.

### Why 10 MB, and not more

The review cap is an **interactivity budget, not a storage budget**. A retained
production benchmark exercises a slightly larger 10 MiB surface, providing
headroom over the default 10 MB cap. It requires ratio-based headroom for
indexing, layout, initial render, and interaction while also bounding mounted
nodes.
Functional mounted suites assert state and navigation rather than machine timing.
Raise the cap only with new benchmark evidence and meaningful headroom; a larger
byte allowance is not automatically a more usable review.

### Truncation

Past either cap the diff is truncated. A truncated _review_ diff is rebuilt from
complete path-scoped hunks with a protected tracked-file pass and fair per-file
rounds. A giant early path therefore cannot silently crowd every later product
file out of the review. The stored patch always parses, and the floor names every
incomplete path with retained/total row counts and known omitted bytes. Coverage
remains visibly degraded, and routines that require a complete diff refuse to
start until the full eligible evidence fits.

## Usage capture per agent

Capture verbs stamp the coding agent's own token usage (tokens only — USD is
priced by the cloud) by reading the agent's local session data. Claude Code,
Codex CLI, OpenCode, and GitHub Copilot have usage sources; Cursor and
AiderDesk do not (no reliable per-session local token data). When no active
session resolves, stamping is a silent no-op.

GitHub Copilot needs one-time setup: its OpenTelemetry file export is **off by
default**, and sessions that ran without it leave no local usage data. Enable
it before starting (or resuming) Copilot sessions:

```bash
export COPILOT_OTEL_ENABLED=true
export COPILOT_OTEL_EXPORTER_TYPE=file
mkdir -p "$HOME/.copilot/otel"
export COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/otel/copilot-otel-$(date +%Y%m%d-%H%M%S).jsonl"
```

Codex CLI and OpenCode need no setup — their session logs always exist — but
neither exposes a session id to shell commands. Usage stamping first uses direct
session evidence from the current environment, then uses the runtime-resolved
invoking agent as a hint when matching the repo directory against recently active
sessions. It never reads a static repo-level agent identity.

## Environment variables

Orcaops reads supported user overrides and sets a separate evaluator subprocess
protocol. The Orcaops Cloud target is fixed for the public product; endpoint and
transport test controls are not user configuration.

### Supported user overrides

| Variable                   | Effect                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORCAOPS_ROOT`             | Overrides project-root discovery, equivalent to passing `--root`.                                                                               |
| `ORCAOPS_TOKEN`            | Provides a cloud credential from the environment (read-only store; no refresh). See [authentication](./authentication.md).                      |
| `ORCAOPS_CREDENTIAL_STORE` | Selects the OS keychain credential store when set to `keyring`.                                                                                 |
| `ORCAOPS_CONFIG_HOME`      | Overrides the config/credentials directory (default: XDG config dir, e.g. `~/.config/orcaops`).                                                 |
| `ORCAOPS_DATA_DIR`         | Overrides the archive data root (default: XDG data dir, else `~/.orcaops`).                                                                     |
| `ORCAOPS_GLOBAL_ROOT`      | Overrides the global state root (default `~/.orcaops`).                                                                                         |
| `ORCAOPS_INVOKED_BY_AGENT` | Provides the capture-attribution fallback when `--invoked-by-agent` is not passed.                                                              |
| `ORCAOPS_DISABLE_DRAIN`    | Disables the automatic cloud push drain when set to `1`.                                                                                        |
| `ORCAOPS_HOOK_SUPPRESS`    | Suppresses session-start hook output for any non-empty value except `0`/`false`. Orcaops sets it to prevent recursion around agent invocations. |
| `ORCAOPS_WATCH_BIN`        | Overrides the path to Orcaops Watch when it is not the sibling of the CLI.                                                                      |
| `ORCAOPS_WATCH_BUN`        | Overrides the path to the Bun runtime used by the watch launcher.                                                                               |
| `ORCAOPS_WATCH_NODE`       | Overrides the path to the Node runtime used by the watch data sidecars.                                                                         |
| `ORCAOPS_CLAUDE_PATH`      | Overrides the path to the `claude` CLI used by LLM evaluators and review lanes.                                                                 |
| `ORCAOPS_CODEX_PATH`       | Overrides the path to the `codex` CLI used by LLM evaluators and review lanes.                                                                  |

### Evaluator subprocess protocol

Set **by Orcaops** in the environment of evaluator subprocesses; not user
configuration.

| Variable                | Effect                                                           |
| ----------------------- | ---------------------------------------------------------------- |
| `ORCAOPS_INPUT_PATH`    | Path the evaluator reads its request payload from.               |
| `ORCAOPS_CONTEXT_PATH`  | Path the evaluator reads its repository context data from.       |
| `ORCAOPS_RUN_ID`        | This evaluator run's id.                                         |
| `ORCAOPS_PHASE`         | Lifecycle phase the run fires at (e.g. `checkpoint-close`).      |
| `ORCAOPS_ARTIFACT_ID`   | Artifact the run evaluates.                                      |
| `ORCAOPS_REPO_ROOT`     | Absolute repository root.                                        |
| `ORCAOPS_PACKAGE_ROOT`  | Absolute root of the evaluator's pack.                           |
| `ORCAOPS_EVALUATOR_REF` | The resolved `<pack>/<evaluator>` ref.                           |
| `ORCAOPS_CHECKPOINT_N`  | Checkpoint number, present only for checkpoint-phase evaluators. |
