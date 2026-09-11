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
| `orcaops uninstall`              | Remove managed install surfaces; keep captured data unless `--purge-data` is explicitly supplied.                                                                                        |
| `orcaops doctor`                 | Diagnose runtime, adapters, install state, authentication, evaluator packs, caches, and watch signals.                                                                                   |
| `orcaops doctor --fix --dry-run` | Preview guarded installation repairs; omit `--dry-run` to apply the approved repair.                                                                                                     |
| `orcaops hook session-start`     | Emit the agent session-start guidance installed by repository hooks; always exits successfully.                                                                                          |
| `orcaops session-hooks <verb>`   | Install, inspect, or uninstall machine-level session hooks in supported agents' user configs.                                                                                            |
| `orcaops skills <verb>`          | List, enable, or disable installed skill templates; run `orcaops update` after changing overrides.                                                                                       |

See [Configuration](./configuration.md) for the index to agent scope, session
hooks, capture controls, generated files, and environment variables.

## Inspect captured work

| Command                              | What it does                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orcaops status [--json]`            | Show the current branch's artifact state and immediate next actions.                                                                                   |
| `orcaops list [--state <state>]`     | List artifacts and optionally filter by lifecycle state.                                                                                               |
| `orcaops show <artifact-id>`         | Render one complete artifact thread.                                                                                                                   |
| `orcaops checkout <artifact-id>`     | Pin one artifact as the current shell's focus; `--clear` removes the pin.                                                                              |
| `orcaops decisions`                  | Query recorded plan, checkpoint, and deferred decisions by branch, artifact, time window, or project scope.                                            |
| `orcaops loose-ends`                 | Report open items, uncertainty, uncovered steps, open checkpoints, and missing summaries.                                                              |
| `orcaops step brief <step-id>`       | Produce a bounded task brief with criteria, guardrails, evidence, and sibling claim state for one plan step.                                           |
| `orcaops stats`                      | Show repository artifact/checkpoint/summary counts and session-token totals; `--scope all-projects` reads across project databases.                    |
| `orcaops usage [--artifact <id>]`    | Show exact session/model totals or labeled per-artifact estimates and checkpoint spans.                                                                |
| `orcaops search <query>`             | Search captured plan, checkpoint, and summary content with FTS5.                                                                                       |
| `orcaops resume`                     | Show in-flight progress and a paste-ready continuation prompt.                                                                                         |
| `orcaops why <file> / <file>:<line>` | Find ranked provenance for a file or line; compact JSON by default, with `--details` for full candidates and rich `best` (no effect without `--json`). |
| `orcaops finish --input <path>`      | Run pre-PR review, finalize the artifact, and render its digest.                                                                                       |
| `orcaops digest [artifact-id]`       | Render one artifact; add `--branch-wide [--base <ref>]` to combine all captured work in a PR range.                                                    |
| `orcaops watch`                      | Open Orcaops Watch, the live cross-project dashboard and local Task Review interface.                                                                  |

With `--scope all-projects`, `list`, `decisions`, `loose-ends`, `stats`, and
`search` read the registered project databases and combine their results. Each
project database is authoritative for its history; there is no hot/archive
merge. Use `--project <id>` to select one project explicitly.

`orcaops show <artifact-id> --project <id>` reads an artifact from the selected
project. `orcaops list --between <ref1>..<ref2>` remains repository-anchored
because it resolves the Git refs locally, then reads the identified project's
database history.

See [Provenance JSON](./provenance-json.md) for schema v4, detail expansion, pagination, and processing budgets.

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

| Command                                               | What it does                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `orcaops login` / `orcaops logout` / `orcaops whoami` | Create, clear, or inspect the current Orcaops Cloud session.                                        |
| `orcaops auth-state`                                  | Emit the simple connection state: connected, expired, or not connected.                             |
| `orcaops org switch`                                  | Change the active organization.                                                                     |
| `orcaops push <artifact-id>`                          | Upload a captured artifact and complete any Cloud source-plan pin.                                  |
| `orcaops push-status`                                 | List artifacts whose local events have not reached Cloud.                                           |
| `orcaops resync [--force]`                            | Retry pending artifact pushes, normally respecting per-artifact backoff.                            |
| `orcaops plan upload <file>`                          | Upload a local plan as a Cloud review draft.                                                        |
| `orcaops plan pull <id-or-slug>`                      | Pull an approved plan into the local cache for pinning.                                             |
| `orcaops plan review <verb>`                          | List/view review state; pull, diff, comment, propose, push, record a verdict, or wait for approval. |
| `orcaops review status` / `pull`                      | Inspect and download the Cloud PR review-feedback transcript.                                       |
| `orcaops review reply` / `watch`                      | Reply to a Cloud review thread or wait for another human pass.                                      |

Cloud is optional. Read [Cloud collaboration](./cloud-collaboration.md),
[Authentication](./authentication.md), and [Plan review](./plan-review.md) for
the human workflows and data boundary.
