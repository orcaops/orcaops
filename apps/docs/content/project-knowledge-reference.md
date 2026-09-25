---
description: 'Technical details for project knowledge processing, consent, coverage, and recovery.'
---

# Project knowledge reference

For setup steps and everyday use, start with [Project knowledge](./project-knowledge.md).

Orcaops keeps the plans, decisions, requirements, evidence, corrections, and
open questions recorded across tasks in the project's local history. Those raw
captures remain searchable without a model. Optional background processing can
interpret and connect eligible new captures after they are saved, but it is not
required for capture, search, or deterministic lookup.

This guide collects the boundaries that matter when you turn that processing
on. The linked reference pages remain the source for every setting and command.

## Configuration and consent are separate

Background processing is off by default. Setting
`knowledge_processing.enabled: true` selects a workload configuration; it does
not authorize sending captured content anywhere. Dispatch also requires a
user-local consent grant for this project, provider, tool-access policy, processor contract, and
source scope. Repository configuration, synced records, agents, and evaluator
trust grants cannot supply it.

Run `orcaops knowledge enable` in an interactive terminal to review the terms,
record the grant, and turn the setting on. There is no non-interactive consent
flag. `orcaops knowledge disable` turns the setting off but retains the grant;
`orcaops knowledge revoke` withdraws the grant but does not rewrite the
configuration. Run both when you want both states changed.

See [Background knowledge processing](./configuration.md#background-knowledge-processing)
for the configuration schema, providers, and defaults.

## The disclosure before consent

Before asking, `orcaops knowledge enable` shows:

- the provider and effective model;
- that prepared plans, checkpoints, summaries, recorded reasoning, and allowed
  related project history may be sent;
- the tool-access policy: either no tools, or the separately approved restricted
  Codex mode described below;
- every effective call, attempt, byte, token, and dollar limit, including when
  no dollar limit applies or an amount is only best effort; and
- whether already-admitted captures are included, how many jobs are waiting,
  and that the terms cover this machine's project database rather than other
  clones or machines.

The grant records those same terms. Captures already waiting are excluded unless
you explicitly include the backlog; consent for future captures does not silently
expand to cover them.

## Provider executables

Knowledge processing and its availability checks resolve both Codex and Claude
Code to a native executable or the declared entrypoint of their official npm
package (`@openai/codex` or `@anthropic-ai/claude-code`). Symlinks are resolved;
npm/pnpm shims on `PATH` are bypassed using adjacent package metadata. JavaScript
entrypoints use Orcaops' Node runtime.

Other launcher scripts on `PATH` are skipped, regardless of which product created
them. This keeps launchers from injecting arguments such as hook-enabling flags.
If you set `ORCAOPS_CODEX_PATH` or `ORCAOPS_CLAUDE_PATH`, select the underlying
native CLI or official npm entrypoint; an unsupported explicit override is refused.
Wrapper-added authentication or environment settings must already be available
in the worker's environment. If no supported entrypoint is found, processing
reports a configuration problem before starting a model call.

This checks installation layout and executable format, not publisher authenticity.
The installed provider remains trusted, including any native executable that
itself acts as a wrapper.

## Restricted Codex processing

Codex requires an explicit `knowledge_processing.tool_access: codex_restricted`
setting and consent for that policy. It does not satisfy the default `none`
policy, which continues to require every tool to be withheld. Changing the
policy requires matching consent; an existing no-tool grant does not cover it.

This mode uses your installed Codex CLI and its existing login. Each call runs
in a disposable directory outside the repository, ignores user configuration
and execution rules, and applies a deny-by-default filesystem profile with only
Codex's minimal runtime reads. Command network access is disabled, and supported
switches disable shell execution, web search, connectors, plugins, hooks,
browser/computer use and subagents. Model and effort come from Orcaops settings,
not your Codex configuration file.

Codex also loads global `AGENTS.md` or `AGENTS.override.md` independently of its
config file. Those instructions may be sent along with your captures; their
presence does not block processing. The consent disclosure names this additional
context. Orcaops does not remove or change either file or your login.
`max_input_bytes` bounds the prepared content Orcaops supplies, not Codex's
built-in or global instructions.

These controls are **not a guarantee that every Codex tool is absent**. Some
built-in tools can still be advertised. If the event stream reports tool use,
Orcaops discards the answer; that check cannot undo anything a tool already did,
and the stream does not report every attempted custom-tool call.
The restriction is version-checked and unsupported Codex versions are refused,
without falling back to another provider or a less restricted invocation.

Codex reports token usage but not a dollar cost for these calls. Unknown cost
is not zero. Hard dollar limits and an output-token ceiling are unsupported and
pause processing when requested. The hourly allowance counts worker attempts,
not underlying Codex model requests: one attempt can send a continuation request
after a built-in tool attempt. Transport retries are disabled, but that does not
limit an attempt to one model request. See the
[Codex configuration example](./configuration.md#restricted-codex-configuration).

## Limits and what they guarantee

The configured limits do not all make the same promise:

- Prepared-input and retained-output byte limits, attempts per job, and the hourly
  worker-attempt allowance are local enforcement boundaries. The input limit
  covers only what Orcaops supplies, not provider-added instructions. An oversized input is parked
  before a call; an oversized response fails rather than being truncated into a
  successful answer.
- A requested output-token ceiling or hard dollar ceiling is used only when the
  selected provider can enforce it. Otherwise processing pauses before a call.
- A daily dollar budget reserves an enforceable per-call ceiling before
  dispatch. A provider that cannot hold that ceiling cannot run under the daily
  budget.
- A best-effort provider amount is not a cap, and a call-count limit is not a
  dollar limit. Provider-reported tokens and cost are retained as reported; they
  are observations, not independently verified measurements.
- The timeout bounds Orcaops' attempt and termination handling. It cannot erase
  cost already incurred by a call whose outcome became uncertain.

There is one call at a time per project database. These limits do not govern
evaluator calls, agent sessions, other clones, or other machines. The exact
values and provider capability matrix are in
[Configuration](./configuration.md#background-knowledge-processing).

## Interpretations are not approvals

The worker reads supported authored fields, including task and step text,
criteria, decisions and their reasons, non-goals, and checkpoint and summary
prose. Field roles matter: a task criterion, rejected alternative, question, or
non-goal is not automatically a continuing rule. Machine command strings and
generated evaluator results are not new authored knowledge.

Model-derived wording is retained separately from exact quoted evidence.
Orcaops locates each quotation inside the source segment actually supplied to
the model and records its verified location. It does not ask the model to count
bytes, guess between repeated quotations, search unseen material to rescue a
citation, or treat a redaction placeholder as a person's words. Valid evidence
does not establish that the interpretation is correct.

A proposed match can connect differently worded statements to one exact
existing revision without creating a duplicate rule. The new wording, evidence,
uncertainty, source task and intended scope remain independently readable in
lookup and task context as **unapproved detector interpretations**. A proposed
match does not merge rules, follow later revisions, inherit authority, or show
that a task selected a rule. Even identical wording requires compatible scope
and context. A genuinely new candidate retains the ordinary human-approval
path; a decision with no supplied explanation reports “reason unknown.”

`orcaops knowledge equivalence reject --input <file>` records that a proposed
match was wrong. Rejection preserves both the interpretation and the original
target; it changes no rule's authority. Accepting a merge is not supported by
this operation.

Discovery still uses bounded source references, task connections and word
matching, not semantic search. A paraphrase with little shared wording may
never bring its earlier rule into the model's context. Recognizing a supplied
rule and discovering it are separate capabilities. Multiple-parent derivation
and background access to the originating repository are not part of this pass.

## Processing recovery

Capture commits before background model work starts. A slow, missing, or failing
provider therefore does not roll back the capture. Jobs, attempts, leases,
pauses, and usage reservations are durable in the project database, and one
worker at a time claims eligible work. The worker exits when idle; Orcaops does
not promise an always-running supervisor.

Before a call, the worker saves the exact ordered fields, segment roles and
byte ranges scheduled for that job. Current-format recovery reuses this
schedule and only advances past atomically published results. Equal numbers
of chunks do not make different ranges interchangeable. Changed terms or
limits must still authorize the retained schedule; a missing, corrupt or
incompatible schedule is refused without silently restarting paid work.
Reading more fields does not increase the permitted attempts or call limits.

Use these recovery surfaces:

- `orcaops knowledge status` shows effective configuration, consent, queue,
  pause, and coverage without starting a worker.
- `orcaops doctor` explains whether processing is off, unavailable, not
  consented, paused, pending, caught up, or failing.
- `orcaops knowledge pause --reason <text>` records a project-wide stop.
- `orcaops knowledge resume` lifts that stop after rechecking configuration and
  consent. `--model <job>` or `--model --all` is the explicit path for jobs
  captured under a no-model choice.
- `orcaops knowledge retry` makes eligible waiting work due now; it does not
  reset the job's attempt allowance or turn an uncertain call into a free one.
- `orcaops knowledge reopen <job>` gives one job that gave up a fresh attempt
  allowance, at a terminal on a typed confirmation, after showing why it gave
  up. Configuration can lower the allowance it records but never raise it.

Revocation prevents later dispatch. Disabling while a call is active stops
future calls and requests cancellation where the provider supports it, but
already-incurred or uncertain usage remains in the record.

## Processing coverage

Knowledge answers, `knowledge status`, and `doctor` use the same coverage
calculation:

| Claim           | Meaning                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `complete`      | Every job admitted at or before the answer's read boundary settled. Only this claim names the source sequence completed through.    |
| `partial`       | Work is open, gave up, is paused, or the newest admitted source is behind the read boundary.                                        |
| `not_processed` | Processing is off or nothing was admitted. Raw captures are still searchable, but automatic relationships do not cover the history. |
| `unknown`       | The processing history could not be read, so Orcaops makes no coverage claim.                                                       |

“Complete through source sequence” describes queue processing, not discovery.
It does not prove that every requirement in those captures was found. An empty
processed answer is therefore never promoted into a statement that no
requirements exist. Raw capture search remains the fallback while processing is
off, behind, or unavailable.

Extraction quality is separate from queue completion. A trustworthy answer can
settle as accepted, partly accepted, all items rejected, or valid but empty.
Valid independent items survive malformed siblings; bounded diagnostics retain
the rejected item positions. Rejected identity links do not silently create
unrelated rules. Results and progress commit together, and later successful
chunks do not erase earlier partial results. There are no automatic model calls
to repair rejected items. An unsafe or wrongly bound response settles no
successful coverage.

For a completed model answer with invalid JSON, Orcaops first tries a bounded,
local punctuation repair: missing or trailing commas, unambiguous extra closing
braces or brackets, or a Markdown fence around the whole answer. It never fills
in missing values, rewrites strings, removes fields, or chooses between different
valid interpretations. The original answer, repaired answer, and exact edits
remain in the attempt details. All ordinary proposal, citation, permission, and
publication checks still apply. This repair makes no model call; an answer that
cannot be repaired follows the existing failed-call retry limits.

Field coverage names processed, omitted and unfinished material. Reading a field
only as neighboring context does not count as processing all its bytes. Lookup
limits keep adopted rules ahead of unapproved interpretations and disclose what
was omitted.

The extraction summary inspects up to 25 newest jobs in the selected source
cohort. It names excluded jobs and bounds field details by count and bytes;
those totals are a sample, not a whole-history quality score. JSON output retains
the exact prepared field ranges and whether their units settled. Queue completion
and extraction quality remain separate even when every unit returned an empty or
rejected answer.

See [`orcaops knowledge lookup`](./command-reference.md#background-knowledge-processing)
for read boundaries, applicability, limits, corrections, and exact references.

## Database upgrade and recovery

Project history is an authoritative SQLite database shared by the repository's
worktrees, not a disposable cache. Passive reads never initialize, migrate,
repair, or backfill it.

When a supported older schema is encountered, `orcaops history upgrade`
previews the exact transition and changes nothing. `orcaops history upgrade
--apply` first creates and verifies a SQLite-consistent backup and retained-
reference manifest, then applies the upgrade transactionally. Unknown, future,
and unsupported development schemas are refused; `orcaops rebuild` is not a
schema-upgrade or authoritative-recovery path.

Use `orcaops history backups` to inspect verified backups. `orcaops history
restore <backup>` previews and `--apply` verifies before replacing the database.
The displaced database is preserved, but work written after the selected backup
is absent from the restored history. Restoring a pre-upgrade backup is therefore
not a lossless downgrade after new work has been captured.

See [Upgrading a project database](./local-data.md#upgrading-a-project-database)
for paths, maintenance requirements, and downgrade limits.

## Evaluator consent and upgrades

Evaluator execution has a separate trust gate. Capability-requiring evaluators
run only when the built-in installation trust or a matching user-local pack
grant covers the effective engine capabilities. Repository configuration can
enable a pack but cannot grant that trust. A refusal is recorded as
`CONSENT_DENIED`; block-severity refusals halt that lifecycle boundary, while
warn and info refusals remain advisory.

This release runs evaluator result envelope `orcaops.evaluator_result/v2`.
Custom producers using `orcaops.evaluator_result/v1` must update
`@orcaops/evaluator-sdk` to `0.2.x` and rebuild, or change the one schema literal
in a hand-written envelope. A current runner reports old or unknown producer
protocols as `UNSUPPORTED_PROTOCOL`; an old runner may reject a v2 result under
its existing rules. Previously retained evaluator output stays readable and is
not re-run or given invented finding identities.

See [Updating packs](./evaluators.md#updating-packs) for trust and fingerprints,
and [Upgrading from the v1 result envelope](./authoring-evaluator-packs.md#upgrading-from-orcaops-evaluator-result-v1)
for the compatibility matrix and author checklist.

## Enforcement, observations, and assertions

Orcaops enforces rules only at the supported write, dispatch, and integration
boundaries its code owns. It does not control arbitrary agent actions, prove a
local caller's identity, turn an inferred relationship into authority, or make
local limits into organization-wide guarantees. Escalation wording and provider
usage are observed. Agent identity supplied to a command is an assertion.

The reviewed boundary-by-boundary list is in
[What Orcaops enforces, and what it only observes](./local-data.md#what-orcaops-enforces-and-what-it-only-observes).
It includes background-processing consent, evaluator-pack consent, authority,
spending and size limits, and the places where Orcaops only records what it was
told.

## Limits of this release

Local history and deterministic retrieval work without Cloud or a provider.
Shared transport and teammate access controls require Orcaops Cloud; local
records do not demonstrate what another client can see after synchronization.

Recording an observation also does not prove a process consumed a particular
snapshot. A snapshot-bound claim requires a runner-established execution
against identified retained inputs. The shipped `knowledge observe` surface
records agent-reported or human observations, not that stronger execution
basis.

Provider capability checks and fake-provider tests establish local safety
behavior, not the quality, cost, or availability of a live provider. Treat a
real-provider qualification as separate evidence.
