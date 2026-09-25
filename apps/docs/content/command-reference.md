---
description: 'Look up the Orcaops CLI commands for installation, capture, review, evaluators, provenance, and maintenance.'
---

# Command reference

Most people use Orcaops through the installed [skills](./skills.md). The CLI is
the underlying interface for automation, diagnostics, inspection, and advanced
integration.

This page covers every top-level command and the important command groups. Run
`orcaops <command> --help` for the exact flags and nested verbs in your installed
version.

## Common conventions

- Commands discover the git worktree root from any subdirectory.
- `--root <path>` overrides discovery; `ORCAOPS_ROOT` provides the same override.
- Read-oriented commands commonly support `--json` for automation.
- Agent-facing capture and review commands accept structured payloads. Let the
  corresponding skill construct them unless you are building an integration.
- Destructive maintenance commands are dry-run by default where noted and
  require an explicit `--apply` or purge flag.

## Install and manage

| Command                          | What it does                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orcaops init`                   | Initialize a repository and install agent support; personal scope is the default, applies to every worktree of the repository, and leaves tracked repository files unchanged.            |
| `orcaops update`                 | Reconcile generated support after upgrades or changes to scope, agents, prefix, hooks, or file posture.                                                                                  |
| `orcaops configure`              | Open the interactive settings menu and preview changes before applying them.                                                                                                             |
| `orcaops link`                   | Consolidate `AGENTS.md` and `CLAUDE.md` onto a canonical file plus symlink, with lossy-change confirmation; unavailable under personal scope, which owns no repository instruction file. |
| `orcaops uninstall`              | Remove managed install surfaces; `--purge-data` also removes `.orcaops/`. Canonical history is kept.                                                                                     |
| `orcaops doctor`                 | Diagnose runtime, adapters, install state, authentication, evaluator packs, caches, and watch signals.                                                                                   |
| `orcaops doctor --fix --dry-run` | Preview guarded installation repairs; omit `--dry-run` to apply the approved repair.                                                                                                     |
| `orcaops hook session-start`     | Emit the agent session-start guidance installed by repository hooks; always exits successfully.                                                                                          |
| `orcaops session-hooks <verb>`   | Install, inspect, or uninstall machine-level session hooks in supported agents' user configs.                                                                                            |
| `orcaops skills <verb>`          | List, enable, or disable installed skill templates; run `orcaops update` after changing overrides.                                                                                       |

See [Configuration](./configuration.md) for the index to agent scope, session
hooks, capture controls, generated files, and environment variables.

## Inspect captured work

| Command                              | What it does                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orcaops status [--json]`            | Show the current branch's artifact state and immediate next actions.                                                                                                                                             |
| `orcaops list [--state <state>]`     | List artifacts and optionally filter by lifecycle state.                                                                                                                                                         |
| `orcaops show <artifact-id>`         | Inspect a bounded digest or exact `--checkpoint`, `--decision`, or `--section`; page checkpoints with the returned cursor. `--output <file>` explicitly exports complete selected evidence.                      |
| `orcaops checkout <artifact-id>`     | Pin one artifact as the current shell's focus; `--clear` removes the pin.                                                                                                                                        |
| `orcaops decisions`                  | Query recorded plan, checkpoint, and deferred decisions by branch, artifact, time window, or project scope.                                                                                                      |
| `orcaops loose-ends`                 | Report open items, uncertainty, uncovered steps, open checkpoints, and missing summaries.                                                                                                                        |
| `orcaops step brief <step-id>`       | Produce a bounded task brief with criteria, guardrails, evidence, and sibling claim state for one plan step.                                                                                                     |
| `orcaops stats`                      | Show repository artifact/checkpoint/summary counts and session-token totals; `--scope all-projects` reads across project databases.                                                                              |
| `orcaops usage [--artifact <id>]`    | Show exact session/model totals or labeled per-artifact estimates and checkpoint spans.                                                                                                                          |
| `orcaops search <query>`             | Search captured plan, checkpoint, and summary content, with the standing of the continuing records each hit cites.                                                                                               |
| `orcaops resume`                     | Show in-flight progress and a paste-ready continuation prompt.                                                                                                                                                   |
| `orcaops why <file> / <file>:<line>` | Find ranked provenance and rationale; `--details --candidate <id> --anchor <token>` inspects one historical candidate, `--details --audit` compares a bounded page, `--at-boundary <n>` reads earlier knowledge. |
| `orcaops finish --input <path>`      | Run pre-PR review, finalize the artifact, and render its digest.                                                                                                                                                 |
| `orcaops digest [artifact-id]`       | Render one artifact and the knowledge it is answerable to; `--branch-wide [--base <ref>]` combines a PR range, `--at-boundary <n>` names a boundary.                                                             |
| `orcaops watch`                      | Open Orcaops Watch, the live cross-project dashboard and local Task Review interface.                                                                                                                            |

With `--scope all-projects`, `list`, `decisions`, `loose-ends`, `stats`, and
`search` read the registered project databases and combine their results. Each
project database is authoritative for its history; there is no hot/archive
merge. Use `--project <id>` to select one project explicitly.

`orcaops show <artifact-id> --project <id>` reads an artifact from the selected
project. `orcaops list --between <ref1>..<ref2>` remains repository-anchored
because it resolves the Git refs locally, then reads the identified project's
database history.

### What a search hit says about standing

A capture stays a first-class result whatever has been interpreted. On top of
that, `search` asks the same shared reader `orcaops knowledge lookup` uses which
continuing requirements, decisions and claims cite the event a hit came from, at
the knowledge boundary the answer names, and reports the standing they have
there. So a query that matches wording the project has since rewritten comes back
with the wording that stands now beside it, rather than with old guidance and
nothing marking it as old. Search decides none of that itself and writes nothing:
it starts no worker, initializes nothing and resolves no model provider.

`--json` carries it in `schema_version` 4, which keeps every field of 3 and adds:

| Field                           | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `knowledge.groups`              | One entry per continuing record any hit cites: its revisions with their wording and standing, which of them govern, the corrections and replacements in force, its task uses in two lists, and the sources and plan criterion to drill into.                                                                                                                                                                                                                                                                                   |
| `knowledge.boundaries`          | The write sequence each project's entries were read at. Every answer names the boundary it read at.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `knowledge.coverage.processing` | What background processing has interpreted, from the same rule `knowledge status` and `doctor` use — `not_processed` when it is off. It is `null` when this search reads several projects at once or runs outside a checkout, because no configuration read here governs them. Search never claims completeness of its own.                                                                                                                                                                                                    |
| `knowledge.budget`              | `bytes` the page may spend on entries, `spent`, and `entries_omitted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `knowledge.limits`              | What the composed reads did not reach, in bounded retrieval's own words.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `results[].knowledge`           | `null` for a hit no continuing record cites. Otherwise `records`, one per record the hit's event cites, each naming its group, the revision the hit's wording belongs to and whether that wording `stands`, is `background`, is `superseded`, is `withdrawn` or is `unknown`; and `incomplete`, the entries this page could not carry whole. `background` is a wording nothing adopts here — recorded as background, departed from in this scope, adopted under a selector this read rules out, or an adoption since reversed. |

The budget is `--limit` times a fixed 2048 bytes per result, or exactly
`--knowledge-bytes <n>`. It is spent on whole entries in hit order, and several
hits of one record share one entry, so carried copies cannot crowd out unrelated
results. An entry that does not fit is reported on the hit as an explicit
incomplete entry naming the record and why; it is never cut down to a fragment,
because part of a rule reads as guidance while leaving out the act that stopped
it.

See [Provenance JSON](./provenance-json.md) for schema 8, focused explanations, grouped interpretations, oversized placeholders, exact expansion, pagination, and processing budgets.

The [Skills guide](./skills.md) maps these capabilities to the plain-language
requests normally used with an agent. The [Task Review guide](./task-review.md)
covers Orcaops Watch.

## Capture lifecycle and evaluators

These commands are primarily called by lifecycle skills:

| Command                                          | What it does                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `orcaops capture plan`                           | Capture or revise the task plan.                                                      |
| `orcaops capture checkpoint open`                | Declare the coherent plan-step scope before changing the worktree.                    |
| `orcaops capture checkpoint close`               | Record what completed, changed, was verified, was decided, and remains uncertain.     |
| `orcaops capture checkpoint abandon`             | Cancel an opened checkpoint without claiming its work.                                |
| `orcaops capture pre-pr-check`                   | Run the final evaluator pass without freezing the artifact.                           |
| `orcaops capture summary`                        | Finalize the artifact outcome, validation, open items, and deferred decisions.        |
| `orcaops block acknowledge` / `dismiss`          | Resolve a block-severity evaluator violation under its configured policy.             |
| `orcaops eval list`                              | List discovered evaluators, enablement, engines, trust state, and operational health. |
| `orcaops eval show <ref>`                        | Render one resolved evaluator as its source YAML or parsed JSON.                      |
| `orcaops eval schema <kind>`                     | Print the author-facing schema for a spec, manifest, or command result envelope.      |
| `orcaops eval add-pack <source> [pack-id]`       | Register an evaluator pack from a package or local path.                              |
| `orcaops eval remove-pack <pack-id>`             | Remove a registered pack, its evaluator overrides, and its user-local trust grant.    |
| `orcaops eval enable` / `disable <pack/id>`      | Toggle one exactly discovered evaluator.                                              |
| `orcaops eval trust <pack>`                      | Inspect and grant user-local capabilities required by third-party evaluator code.     |
| `orcaops eval run --ref <ref>`                   | Run one discovered evaluator against an existing artifact and persist the result.     |
| `orcaops eval test --ref <ref> --fixture <path>` | Test an evaluator against a JSON fixture without persisting a real run.               |
| `orcaops eval fork-pack <pack> --to <path>`      | Copy a resolved pack into an editable local directory.                                |
| `orcaops eval update-pack <pack>`                | Re-resolve and validate a registered pack.                                            |

See [Evaluators](./evaluators.md) and
[Authoring evaluator packs](./authoring-evaluator-packs.md) before granting or
shipping executable evaluator code.

Before the evaluators run, `orcaops finish` and `orcaops capture pre-pr-check`
compare the task's own knowledge against what stands now. It is not an evaluator
and no pack turns it off.

- An act this task published that rests on an authorization or an assignment a
  revocation has ended, or on a delegation whose validity no longer covers it,
  refuses the pass with `AUTHORITY_REVOKED`. The message names the act, what it
  rested on, who revoked it and when, and what lifts it. The refusal writes
  nothing to the act, to what it rested on or to the revocation, and mints no
  pre-PR marker; the phase's own completion is recorded, as it is for a pass the
  evaluators block.
- A revision the plan recorded a use of that no longer governs is reported, not
  refused. The pass completes `needs_attention`, the response carries an
  `authority` field with the identity, the revision that governs now and why the
  obligation moved, and the same finding is retained on the pre-PR marker by
  identity and reason.

`orcaops finish` pauses on either and prints the findings beside the evaluator
warnings. Where the review also holds an acceptable evaluator warning, accepting
it with a reason accepts that review. Where the moved obligation is the only
finding, there is no evaluator run for `accepted_warnings` to name: record a use
of the revision that governs now with `orcaops task uses record`, or revise the
plan, and run `finish` again.

See [What Orcaops enforces, and what it only observes](./local-data.md#what-orcaops-enforces-and-what-it-only-observes)
for every authority and consent check named in this documentation.

## Background knowledge processing

Sending captured content to a model provider takes two separate things, and
these commands keep them separate: configuration chooses the settings, and a
user-local grant outside the repository authorizes the send. Neither stands in
for the other.

| Command                          | What it does                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orcaops knowledge observe`      | Record what somebody saw, from `--input`: a human observation, or a command an agent ran and its result. It can never claim a runner established what a process consumed.              |
| `orcaops knowledge assess`       | Assess a selected release or build against exact expectation revisions, from `--input`, with no task. With no software identified it concludes unresolved or not assessed.             |
| `orcaops knowledge status`       | Show whether configuration enables processing, the provider, model and limits it resolves to or the reasons it is paused, whether consent covers them, and what is queued.             |
| `orcaops knowledge lookup`       | Show the continuing requirements and decisions that bear on some work, at a knowledge boundary the answer names. A passive read: it asks nothing, writes nothing and starts no worker. |
| `orcaops knowledge equivalence`  | Reject a proposed match with `reject --input`, preserving the interpretation, evidence and exact target. It does not merge or withdraw a rule.                                         |
| `orcaops knowledge consequences` | Show what else this history records reaching from one change, with the reason and the full path for each affected item. A passive read, on the same terms as `lookup`.                 |
| `orcaops knowledge reconsider`   | Retain what a change leaves worth another look, list those items, and record what somebody decided about one. It opens no defect and assigns no remediation.                           |
| `orcaops knowledge assignment`   | Record who may decide what on somebody else's behalf, list those assignments with what each delegates, and end one. Ending one refuses every later act under it.                       |
| `orcaops knowledge enable`       | Show the terms, record consent on a typed confirmation at a terminal, then set `knowledge_processing.enabled` to `true`.                                                               |
| `orcaops knowledge disable`      | Set `knowledge_processing.enabled` to `false`. The consent grant is left on record.                                                                                                    |
| `orcaops knowledge pause`        | Stop claiming for this project, recording `--reason <text>` and who asked. Every admitted job is left exactly as it is.                                                                |
| `orcaops knowledge resume`       | Let claiming start again for this project. No admitted job is changed. With `--model <job>` or `--model --all`, allow a model for jobs captured without one.                           |
| `orcaops knowledge retry`        | Make a waiting job, or with `[job]` one of them, due now. No attempt allowance is reset and no finished job is reopened.                                                               |
| `orcaops knowledge reopen`       | Give one job that gave up a fresh attempt allowance, on a typed confirmation at a terminal, after showing why it gave up and the terms it would run under.                             |
| `orcaops knowledge revoke`       | Withdraw this project's consent, optionally `--provider <name>` only. Configuration is left as it is.                                                                                  |

`knowledge equivalence reject --input rejection.json --json` accepts a rejection
record with `interpretation_id`, `disposition: "rejected"`, a `reason` string or
`null`, and `recorded_at` as an ISO timestamp. The command derives the stable
`disposition_id`; an explicitly supplied ID must match the same account.
Optional `decided_by` and `operation_id` follow the other evidence-writing
commands. Reuse the same file when retrying. A different second rejection is
refused rather than replacing history. There is no acceptance or merge action.

`lookup --json` exposes a separate bounded `interpretations` list. Entries keep
the interpreted wording, exact evidence, intended scope, originating task,
uncertainty and exact target revision, plus any rejected-match disposition.
They never appear as applicable rules merely because the model proposed them.

`lookup` and `consequences` are the two passive reads here. `consequences`
starts from what the record actually links to a change — the exact task uses of
the revision, the plan events and artifacts those uses belong to, the
assessments that weighed it, and the code those artifacts recorded a touch of —
and then follows `depends_on` and `motivates` relationships, recorded
assumptions and shared subjects to `--depth` links and `--limit` items. Ask
about one change: `--identity <kind>:<id>`, `--revision <kind>:<id>@<revision>`,
`--touching <path>` (a path or a glob over one), or `--since <write sequence>`,
which traverses every identity whose standing an act moved after that boundary.

Every affected item carries the reason it was reached, the full path from the
change with each link marked explicit or inferred, the owner where a record
names one, and the boundary the answer was read at. An identity reached several
ways is one item with every path that found it; a loop ends the walk where it
closes; and a mapping the store cannot make — a file no artifact recorded a
touch of, a dependency whose far endpoint this read holds no record of, a
truncated depth or count — is reported as a named limit, never as nothing being
affected. The answer never claims complete impact coverage, and reaching an item
is never a finding that the item is wrong: it opens no defect, revises no
requirement and assigns no remediation.

`reconsider` is where that answer becomes a record somebody can work through.

| Command                                | What it does                                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orcaops knowledge reconsider open`    | Run the `consequences` traversal, on the same flags, and retain one item per affected item and cause. It writes items and nothing else.                                                               |
| `orcaops knowledge reconsider list`    | Show the items with their cause, reason, owner and dispositions, at a knowledge boundary the answer names. `--identity`, `--open` (the default), `--all`, `--at-boundary`, `--limit`. A passive read. |
| `orcaops knowledge reconsider dispose` | Append what somebody decided about `<item>`: `--acknowledge`, `--reconsidered <outcome>`, `--decline <reason>` or `--superseded-by <item>`. The item's own facts are left as they are.                |

An item is identified by what it is about and what caused it, so opening the
same signal again returns the item the store already holds and writes nothing:
repeated signals leave one item. How a revision's standing moved — adopted,
replaced, corrected — takes no part in that identity, because an adoption and
the replacement that follows it are one revision changing, not two things to
reconsider. Opening an item creates no defect, revises no requirement, assigns
no remediation and admits no processing job; nothing else in Orcaops opens one
either, because a correction may schedule bounded reconsideration and may not
start a cascade. A person or a skill asks.

A disposition is a row beside the item, never a change to it: it carries who
decided and when, and the item's cause, path and owner stay exactly as they were
retained. `--reconsidered` names what came of it — `unchanged`, `revision:<id>`
or `assessment:<id>` — and the store requires the record it names to be one this
history holds. Acknowledging is not deciding, so an acknowledged item is still
open; reconsidering, declining and superseding decide it, and a decided item
takes no second disposition. A read at an earlier boundary shows the item as it
stood then, without a disposition appended afterwards.

`status --json` and `knowledge lookup --json` carry a `reconsideration` field
beside their answer: how many items are open about the identities in view and
the first few with their reasons. It is `null` — never an empty summary — when
the read composed no answer to attach it to.

`assignment` is where delegation is recorded. `orcaops knowledge revoke` already
means withdrawing this project's consent to background processing, so ending a
delegation is `orcaops knowledge assignment revoke` and not a second top-level
verb beside it.

| Command                               | What it does                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orcaops knowledge assignment open`   | Retain one assignment from `--input -` (YAML or JSON): its objective, the obligations it inherits, the footprint it delegates, who is responsible, the authority it rests on and when it ends. |
| `orcaops knowledge assignment list`   | Show the assignments with what each delegates and how it stood, at a knowledge boundary the answer names. `--identity`, `--responsible`, `--at-boundary`, `--limit`. A passive read.           |
| `orcaops knowledge assignment revoke` | End `<assignment>` from now on, with `--reason <text>`. Every later act under it is refused; what was published under it before stays exactly as it was retained.                              |

What an assignment delegates is a structured footprint — the revisions it may
adopt, the rules it may depart from and how, and the findings it may restate.
That footprint, and nothing else, is what the store judges an act under the
assignment against; the allowed changes and escalation conditions it also
records are the assigner's own words for people, and are never parsed. An
escalation condition is shown and never enforced.

An assigner cannot delegate authority they do not hold: what the assignment
delegates is judged, when it is opened, against the instruction, approval or
earlier assignment it rests on, so a chain of assignments can only narrow. An
act citing an assignment needs no new instruction when it falls inside what the
assignment delegates, is in the same scope, is not after the assignment's end or
its revocation, and is attributed to the party the assignment made responsible.
**Orcaops enforces that the act claims that identity; it does not authenticate
it** — a local invocation carries no authentication, so the identity a record
here carries is an assertion.

`knowledge lookup` names the assignments in view for each identity, in JSON and
in a line per identity for a person, and `orcaops status --json` carries an
`assignments` summary beside its other knowledge fields. Both are `null` or
absent — never an empty list — when the read composed none.

`observe` and `assess` write records, not settings: they need no provider, no
consent grant and no model, and they work with processing disabled. `observe`
records what was reported. Establishing which inputs a process actually
consumed takes a runner that hands them over and digests them, so no wording in
an `observe` payload can claim it — an `execution.kind` of `runner_established`
is refused, by the command and by the store behind it. `assess` names the
expectation revisions, the exceptions in force, the software it identified or
its explicit absence, the evidence it weighed and one conclusion per
expectation; a check that errored, was skipped, lacked its inputs or rested on
stale evidence is recorded as that, never as a conclusion. The store refuses
`supported` or `contradicted` against unidentified software, and neither
command substitutes the current checkout for one.

What the store checks is that each expectation revision, exception and piece of
evidence is retained here and that every selected input is named. That a name
identifies software which exists — that `0.2.1` was ever built, that a commit is
in any repository — it cannot check and does not claim.

Both records carry who acted. A record that names `observed_by` or `assessed_by`
keeps its own attribution; one that does not is attributed to the account this
command runs as, on the basis `--invoked-by-agent` implies — never
`authenticated`, because a local invocation authenticates nobody.

`enable` is interactive only. There is no `--yes`, no environment variable and
no flag that consents on your behalf, so a skill, hook or background job cannot
grant it; run it yourself in a terminal. It refuses when the workload would be
paused anyway, because turning it on would promise work that never runs, and
the terms it prints name the provider and model, what is sent, every effective
limit, whether each dollar amount is a ceiling, best effort or absent, and
whether existing captures are included. Consent is recorded before the setting
is turned on, so an interrupted run leaves consent recorded with processing
still off — never the reverse. `--include-backlog` covers captures already
admitted; without it the grant covers captures from now on.

`revoke` needs no confirmation: withdrawing consent is never harder than giving
it. Revoked grants stay on record rather than being deleted.

Every eligible capture — a plan, a revision, a closed or abandoned checkpoint,
a summary — puts one job on this project's queue, in the same transaction that
saves the capture. That happens whether or not processing is enabled or
consented, so nothing is lost while you decide; opening a checkpoint queues
nothing, and neither does anything seeded, imported, converted, restored or
replayed. Restoring a backup brings back the jobs it held, as they were when it
was taken. A capture made with `--no-llm` keeps that choice on its job, and no
later invocation turns it into a paid call — including the invocation that
finishes a capture whose Git inputs were staged before it was interrupted, which
settles with the choice the interrupted one made. `orcaops knowledge retry`
reports such a job as held rather than making it due.

`resume --model <job>`, or `--model --all` for every job this project admitted
without a model, is the one thing that lifts that choice. Like `enable` it is a
person's act: it refuses without an interactive terminal, has no `--yes`, prints
the source of each job and the provider, model and limits in force, and takes a
typed confirmation. It then judges consent for each job exactly as the worker
does; a job the grant does not cover is reported as `CONSENT_DENIED` and nothing
is recorded for it. A recorded resume names the grant it rests on and who
authorized it, and the original choice stays on the job: nothing is erased.
`orcaops knowledge resume` without `--model` remains the project-pause lift and
changes no job.

`status` reports that queue: how many jobs are in each state, what each group of
waiting jobs waits on and when its next retry is due, the five jobs that most
recently gave up and why (`--limit <n>` lists more), how many were captured
with no model, whether the project is paused and by whom, any worker lease, and
the calls and spend used against the limits in force. `--json` returns the same
values. `doctor` says in one line which of these holds — off, unavailable,
enabled but not consented, paused by a person, caught up, pending, or failing —
along with the provider and model in force and what to run about it.

`pause` records who asked from what the command line knows: the account the
process runs as, on a basis that is never `authenticated`, because nothing
local verifies who typed it. Pausing and resuming change no job, and `retry`
frees a job that is waiting without giving it a fresh attempt allowance.

A job that gave up — it spent its attempt allowance, or its answer or result was
refused — takes no further attempt until `reopen <job>` gives it a fresh one.
Every attempt is a paid call, so `reopen` is built like `resume --model`: it
refuses without an interactive terminal, has no `--yes`, shows why the job gave
up, how many attempts it made and the provider, model and limits it would run
under, and takes a typed confirmation. It judges consent and those terms again
after the answer, and records nothing if either changed. The reopening records
who reopened the job and the allowance that was shown; a later configuration
change can lower that allowance but never raise it. The earlier attempts, the
reason the job gave up and any unit it had already finished are kept, and it
continues from there. Reopening never allows a model for a job captured without
one: when its current terms fall outside its model confirmation, it waits for
`resume --model <job>`. A completed job is never run again.

`lookup` answers what the record says about some work. Ask with `--adopted`,
about text, about one `--subject <subject id>`, or about one or more
`--identity <kind>:<id>`; a
`--touching <path>` question is refused, because this history records no
attributed association between code and a continuing record and nothing indexes
a recorded file path against one. Use `orcaops list --touching <glob>` to find
the artifacts and then ask about the records themselves.

`--adopted` is the question that finds rules with no wording to match them
against: every adopted requirement and decision this project holds, whatever the
work happens to be about. It is what to ask before a plan exists, because a rule
the task never mentions reaches no text or reference route. It is bounded like
any other answer, and the bound is named under `limits`.

The answer puts the adopted rules that apply here first, each with the one line
that says why it applies — the scope it was adopted in, and whether its
applicability holds or is merely unresolved — then background, then proposals
and extracted candidates as the labelled candidates they are, then conflicts and
unresolved points, each with the artifact, event, source and revision ids to
drill into. It ends with the coverage line described below. Nothing is asked:
an ambiguous interpretation stays a labelled candidate rather than becoming a
question.

`--at-boundary <n>` reads at a past write sequence instead of the committed one,
so you can see what the record said then. The answer always names the boundary
it read at, whether or not you chose one, and a correction recorded after that
boundary appears only under "Recorded after this boundary" — separately dated,
never folded into the basis. `--scope project` (the default) or
`--scope artifact:<id>` chooses the authority scope.

`--limit` bounds how many continuing identities the answer carries, and it is
spent after every identity has been read and placed: background is left out
before any adopted rule that applies here, and an adopted rule that applies is
never dropped while a background one remains. Whatever the limit left out is
named in the answer's limits, by key, rather than counted and dropped. An
identity you asked about that this history holds no record of at the boundary is
named there too, as no such record, rather than shown as an empty entry.

Every answer carries one coverage field, and `knowledge status` and `doctor`
print the same one from the same computation: `complete` only when every
admitted job settled at or before the boundary read at, `partial` while any is
open or gave up or the newest admitted source is behind that boundary,
`not_processed` while processing is off or nothing was ever admitted, and
`unknown` when the history cannot be read. Only `complete` carries a source
sequence, and "completed through this source sequence" is about processing, not
proof that every requirement in those sources was found.

See
[Configuration](./configuration.md#background-knowledge-processing) for the
settings themselves.

While processing is enabled in the checkout a capture is made in, that capture
starts a background worker of its own; while it is off, none is started and what
was queued waits. The capture never waits for it either way: it commits first,
and the worker runs afterwards, takes a lease on the project database so only
one worker ever runs against it at a time, sends nothing to a provider without a
grant covering the job, and exits when there is nothing left to process.
Nothing is sent until the worker has re-read the configuration that governs the
worktree the capture was made in and the grant that covers it, so a disabled
worktree, a deleted one or a withdrawn grant stops the work rather than
borrowing another checkout's settings. `orcaops knowledge status` reads that
state and starts no worker itself.

There are two pauses and they read differently. A configuration pause is what
these settings resolve to — a provider that cannot be found, a limit that cannot
be enforced — and `status` prints it as the reason processing would not run. The
project-wide pause is a durable record in the project database, set by `orcaops
knowledge pause` or by the worker itself when a safety guarantee did not hold,
and lifted only by `orcaops knowledge resume`. `orcaops knowledge status` and
`orcaops doctor` are the two surfaces that show it, and both say who set it and
why.

## Task uses

A task use records that a task did something with an exact requirement or
decision revision, and which of two things it was. A use written by the plan
event's own operation was that plan's own selection; a use written by any later
operation is a connection somebody found afterwards. The store derives which
from the operations, never from what the caller says, and the two are never
shown as one.

| Command                    | What it does                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `orcaops task uses list`   | A plan event's uses in two labelled groups, with the discovery time and discoverer on every connection found later.                    |
| `orcaops task uses record` | Record a use of an exact revision. It always runs outside the plan event's operation, so it needs `--discovered-at`/`--discovered-by`. |

`list` takes `--plan-event <id>` or `--artifact <id>`, and `--at-boundary <n>`
to read at a past write sequence.

`record` takes `--artifact`, `--plan-event`, `--identity <kind>:<id>`,
`--revision <id>` and `--role` (one of `implement`, `preserve`, `assess`,
`background`, `propose_change`), or the same payload through `--input`. Because
it runs in an operation of its own, what it writes is always a connection found
after the plan: without `--discovered-at <instant>` and `--discovered-by <name>`
it fails `DISCOVERY_REQUIRED` and writes nothing, and with them the use is
recorded as connected later and never appears under the plan's own selections.
Recording the same use twice writes no second row.

You supply the discoverer's name; the attribution basis is the command's and is
never yours to give, including through `--input`. Nothing local authenticates
who typed the command, so the basis is never `authenticated`: it records that an
agent reported the discovery on a person's instruction when an agent invoked
orcaops, and otherwise that somebody asserted it. If this process cannot read
the account it runs as, it cannot state a basis for a name at all and refuses
with `DISCOVERER_NOT_ATTRIBUTABLE` before opening the database; record an
unknown actor through `--input` if that is what you mean.

### What a plan selects

`orcaops capture plan` and `orcaops capture plan revise` take the selection with
the plan itself, as `knowledge_uses` in the input payload:

```json
{
  "knowledge_uses": [
    {
      "kind": "requirement",
      "entity_id": "<requirement or decision id>",
      "revision_id": "<the exact revision>",
      "role": "implement",
      "exception_id": null
    }
  ]
}
```

`kind` is `requirement` or `decision` — the two things a task use can name. A
plan step's acceptance criterion is not one of them, so a task-local criterion
is recorded against the shared requirement it came from rather than as a target
of its own. `role` is one of `implement`, `preserve`, `assess`, `background`,
`propose_change`. `exception_id` is optional and names a recorded exception the
use relies on.

These are settled inside the plan event's own operation, so the store derives
`selected_with_plan` for each without being told: nothing a caller passes can
make a later connection read as an original selection. A use naming a revision
this history does not retain refuses the whole capture with `HISTORY_MISSING`
and captures nothing. Reusing a `capture plan` idempotency key with a different
selection is an `IDEMPOTENCY_CONFLICT`, because the selection is part of the
retained request; a replayed key writes no second row.

On `capture plan revise` the field is a complete supersede, like `plan_steps`. A
use the prior revision named and this one does not is not a use of the new plan
event — it stays recorded against the plan event that did select it, and if it
still applies it reappears under `applicable_not_selected` below.

A checkpoint records no uses of its own. It already pins the plan revision it
opened against, and `orcaops show --json` and `orcaops resume --json` render the
uses of that revision under it, with connections found later kept in their own
list.

### What previously recorded assessments say

`orcaops knowledge lookup` carries, under each requirement or decision it
answers about, the assessments that concluded about one of its revisions. Each
one shows the basis it judged on — the software it identified or its explicit
absence, the environment, the method and its configuration, the evidence it
weighed, any check that errored or was skipped, the exceptions in force, its
coverage limits, and the two counters it observed — and, beside that, what it
is for the question you asked.

`--software <kind>:<identity>` names the software the question is about, and is
repeatable; `--environment <name>` names the conditions, and needs
`--software`. `kind` is one of `git_commit`, `git_tree`, `worktree_snapshot`,
`build`, `release`, `file`, `evaluator_context`.

**Without `--software` the answer names no software, and no assessment
applies.** That is the rule and not a limitation: an assessment shown against a
question that never named a version would be read as satisfaction of
unspecified software, which is the one thing an assessment may never claim. Ask
to certify a version and the answer says either which assessment applies to it
or that there is no applicable assessment, with what one would have to name.

Each assessment is one of three things for your question, and none of them is a
defect in the work you are doing now:

| Outcome                        | Meaning                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applies`                      | Every part of its basis that the question constrains is the one asked about, so its conclusion is about this question.                                  |
| `historical`                   | It concluded about a revision the question does not name. Preserved with its own basis, shown under the revision it judged, never a conclusion here.    |
| `insufficient_for_a_new_claim` | It concerns a revision the question names under a different basis. That is a verification gap, with the changed part named — not an established defect. |

A mismatched old assessment, passing or failing, changes nothing: a checkpoint
still opens, `finish` still runs its pre-PR pass and commits, `doctor` reports
exactly what it reported before, and nothing schedules corrective work. A later
assessment establishes only what it observed — a clean rerun, a skipped check,
a changed configuration or a fix at a later version does not refute an earlier
report, and the earlier conclusion is shown unchanged beside it.

### Applicable and not selected

`orcaops knowledge lookup` and `orcaops status --json` both carry
`applicable_not_selected`: the adopted revisions that apply, minus the ones the
plan in view recorded a use of. It is a passive diff — no question is asked and
nothing is written — and it exists so a known rule cannot disappear from an
agent's view merely because the agent did not select it.

The comparison is by exact revision. A plan that selected a predecessor of the
revision that now governs is listed, with the revision it did select named
beside it, so drift reads as drift.

The two commands differ when there is no plan to diff against. `lookup` still
answers: `plan_event_id` is null, every applicable entry is listed, and the
statement says that no plan is in view. `status` sets the whole
`applicable_not_selected` field to null — never an empty list — when the branch
has no single active task or its history could not be read whole, because a diff
against the wrong plan would report another task's selections as missing, and an
empty list would read as "nothing is missing".

`status` resolves at most 50 adopted identities. When it reaches that bound the
diff's `limits` carry the `identity_count` entry naming what was left out, and
its statement counts "of at least N, capped at 50" rather than reporting the
bound as the whole of what applies; `orcaops knowledge lookup --adopted --limit`
is where to ask for more.

### What stands, beside the thread that is answerable to it

`orcaops show`, `orcaops resume`, `orcaops digest`, `orcaops why` and Orcaops
Watch's detail pane each render a thread's own captures — its steps, decisions,
non-goals and criteria. Each now carries a `knowledge` block beside them, read
through the same shared answer, so none of them decides standing for itself and
no two of them can report a different governing revision for one identity.

The block holds the boundary it was read at, one entry per continuing identity
with the revision that governs there and the wording that goes with it, the task
uses in their two lists, the `applicable_not_selected` diff described above, the
records dated after the boundary, and the coverage claim. A plan decision is
this task's own and stays where it was; a rule that stands is not, and is never
folded in with them.

`orcaops digest` renders the same block as a `## continuing knowledge` section,
which names the boundary in its first line. `orcaops why` carries it about the
artifact its ranking put first; with no best candidate it answers about the
project and says in words that no plan is in view.

The block claims no completeness on these surfaces: none of them resolves a
provider or evaluates a consent grant, so none can derive the processing claim.
`orcaops knowledge status` is where that claim is made.

### Reading the record as it stood

`orcaops show`, `orcaops digest` and `orcaops why` take `--at-boundary <n>`,
where `n` is a write sequence of the project history. The answer is read as the
record stood at that sequence: what governed then governs in the answer, and
anything published since appears only under `later_annotations`, separately
dated, never merged into the body.

`--at-boundary` is deliberately not `--at`. On `orcaops why`, `--at` resolves
the _code_ target at a Git revision; `--at-boundary` reads the _record_ at a
write sequence. They are different clocks, and one flag for both would answer at
a boundary nobody named. A boundary past what the store is committed through is
refused with `INVALID_INPUT` rather than read as now, and so is anything that is
not a positive integer.

`--at-boundary` cannot be combined with `orcaops digest --branch-wide`: a
branch-wide digest spans several threads and takes no single boundary.

## Provenance, snapshots, and maintenance

| Command                          | What it does                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `orcaops fingerprint show`       | Inspect a closed checkpoint's captured diff-fingerprint metadata and manifest.                                        |
| `orcaops fingerprint derive`     | Recompute a manifest from pinned trees and verify its hash without persisting output.                                 |
| `orcaops diff --attribution`     | Match live or committed diff hunks to the checkpoints that produced them.                                             |
| `orcaops diff --reconcile`       | Report in-window commits not accounted for by checkpoints.                                                            |
| `orcaops export agent-trace`     | Export per-line provenance as a Cursor agent-trace record, file, or explicit local git note.                          |
| `orcaops snapshots checkout`     | Materialize a checkpoint-boundary tree in a scratch worktree.                                                         |
| `orcaops snapshots diff <range>` | Diff checkpoint boundaries or a boundary against the plan baseline.                                                   |
| `orcaops snapshots prune`        | Preview retired, unreferenced snapshot publications; `--apply` reclaims eligible refs.                                |
| `orcaops lineage`                | Refresh captured lineage after a merge, rebase, or amend changes branch ancestry.                                     |
| `orcaops rebuild`                | Rebuild derived query and search metadata from retained project database rows.                                        |
| `orcaops seed [--dry-run]`       | Preview or apply the consent-gated one-time git-history backfill.                                                     |
| `orcaops seed enrich`            | Preview or append an enrichment amendment to one imported artifact.                                                   |
| `orcaops seed status`            | Show history coverage, failures, progress, and remembered discovery declines.                                         |
| `orcaops gc`                     | Inspect canonical retained Git publications; `--apply` reclaims only exact, positively retired, dependency-free refs. |

| Command                            | What it does                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `orcaops history convert`          | Preview a frozen legacy repository's history; `--apply --offline` converts it while preserving the originals.  |
| `orcaops history upgrade`          | Preview the explicit project-database upgrade; `--apply` takes a verified backup and then performs it.         |
| `orcaops history backups`          | List the verified backups this project database's upgrades took.                                               |
| `orcaops history restore <backup>` | Preview replacing the project database with one of those backups; `--apply` performs it and keeps the old one. |

See [Upgrading a project database](./local-data.md#upgrading-a-project-database)
for what an upgrade backup holds and what a restore does not bring back.

`orcaops history convert` previews supported legacy history; `--apply --offline`
converts it while preserving originals. Legacy Task Review history is intentionally
omitted. See [Local data](./local-data.md) before reclaiming retained Git resources.
Apply prints its operation ID before importing. If interrupted, keep the same
checkout and data root and retry with `--operation-id <id>`. An unregistered
committed conversion can recover that ID from its validated receipt when its
original sources still match; unrelated or changed history is refused.

## Task Review engine

The `orcaops-task-review` skill normally drives this surface. The most relevant
groups are:

| Command                                 | What it does                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `orcaops review data --branch <branch>` | Publish the bounded review floor and diff, reusing the selected floor when its inputs are unchanged. `--rebuild-cache` is retired. |
| `orcaops review routine-start`          | Pin inputs, mint a two-lane run, and serve the capture-blind forensic payload.                                                     |
| `orcaops review routine-submit`         | Validate a lane submission, serve the next input, or finalize the accepted routine.                                                |
| `orcaops review journal`                | Read or append local reviewer disposition events.                                                                                  |
| `orcaops review comments` / `comment`   | Read, add, reply to, resolve, or reopen local Task Review comments.                                                                |

The [Task Review protocol](./task-review-protocol.md) is the full integration
contract, including payloads, status dimensions, limits, and repair behavior.

## Authentication and Cloud

| Command                                               | What it does                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orcaops login` / `orcaops logout` / `orcaops whoami` | Create, clear, or inspect the current Orcaops Cloud session.                                                                                                                                                                                                |
| `orcaops auth-state`                                  | Emit the simple connection state: connected, expired, or not connected.                                                                                                                                                                                     |
| `orcaops org switch`                                  | Change the active organization.                                                                                                                                                                                                                             |
| `orcaops push <artifact-id>`                          | Upload a captured artifact and complete any Cloud source-plan pin.                                                                                                                                                                                          |
| `orcaops push-status`                                 | List artifacts whose local events have not reached Cloud.                                                                                                                                                                                                   |
| `orcaops resync [--force]`                            | Retry pending artifact pushes, normally respecting per-artifact backoff.                                                                                                                                                                                    |
| `orcaops plan upload <file>`                          | Upload a local plan as a Cloud review draft.                                                                                                                                                                                                                |
| `orcaops plan pull <id-or-slug>`                      | Pull an approved plan into the local cache for pinning.                                                                                                                                                                                                     |
| `orcaops plan review <verb>`                          | List/view review state; request reviewers, pull, diff, comment, propose, push, record a verdict, or wait for approval.                                                                                                                                      |
| `orcaops plan review request <ref> --reviewer <id>`   | Add 1–25 distinct reviewer identifiers of 1–200 characters to an in-review plan; results identify added, existing, unresolved, and unconfirmed input. Repeat `--reviewer`, add `--json`, or use `--resend` to dispatch an identical recorded request again. |
| `orcaops review status` / `pull`                      | Inspect and download the Cloud PR review-feedback transcript.                                                                                                                                                                                               |
| `orcaops review reply` / `watch`                      | Reply to a Cloud review thread or wait for another human pass.                                                                                                                                                                                              |

Cloud is optional. Read [Cloud collaboration](./cloud-collaboration.md),
[Authentication](./authentication.md), and [Plan review](./plan-review.md) for
the human workflows and data boundary.
