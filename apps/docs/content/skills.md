---
description: 'Find every shipped Orcaops skill, the intents that trigger it, and which specialized workflows are opt-in.'
---

# Skills

Skills are the user-facing Orcaops workflows installed into your coding agent.
Describe the outcome you want in normal language; the matching skill chooses the
CLI commands, validates their responses, and handles the next step.

Some skills are lifecycle machinery the agent normally selects on its own.
Others represent capabilities you deliberately ask for, such as explaining a
line or producing a changelog. Skill names use the default `orcaops-` prefix;
your installation may use a custom prefix.

## The automatic work lifecycle

For a normal non-trivial development task, injected session guidance and
repository instructions tell the agent to run this lifecycle. Give the agent
the development task normally; do not prompt for each row.

| When the agent uses it                   | Skill                | Result                                                               |
| ---------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| Before implementation or a plan revision | `orcaops-capture`    | Records or revises the task plan.                                    |
| Around each coherent unit of work        | `orcaops-checkpoint` | Attributes changes and records decisions, evidence, and uncertainty. |
| When the task is complete                | `orcaops-finish`     | Reviews the work, records the outcome, and renders the digest.       |

If one of these phases is missed or needs to be rerun, name the skill explicitly
as described under [If a skill does not trigger](#if-a-skill-does-not-trigger).

## Continue or inspect work

These are deliberate requests rather than phases you add to every task. Examples
are intents, not exact trigger phrases.

| Ask your agent                                     | Skill            | Result                                                    |
| -------------------------------------------------- | ---------------- | --------------------------------------------------------- |
| Pick up where we left off.                         | `orcaops-resume` | Restores the active artifact and explains the next work.  |
| Show me what changed.<br>Draft the PR description. | `orcaops-digest` | Renders the existing captured work for review or sharing. |

## Review the work

| Ask your agent                                | Skill                        | Result                                                                                                             |
| --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Generate a Task Review for this branch.       | `orcaops-task-review`        | Builds the branch-level review for [`orcaops watch`](./task-review.md) when you decide the combined work is ready. |
| Address the open Task Review comments.        | `orcaops-task-review`        | Reads locally anchored feedback, works requested changes, and replies in each comment thread.                      |
| Is this actually done?<br>Red-team this work. | `orcaops-adversarial-review` | Challenges completion claims, uncertainty, plan lineage, and unaccounted changes.                                  |

Task Review organizes evidence for a human reviewer. Adversarial review tries to
refute the agent's claims. Neither is a merge verdict. Request Task Review again
to refresh it after material branch changes.

## Report progress and releases

The `orcaops-recap` skill turns captured work into standup, changelog, and
journal formats. Ask for the report you need; the agent selects the right time
window or git range.

| What you need           | Example request                                | Result                                                                                      |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Daily or weekly standup | Give me my standup for yesterday.              | Summarizes shipped work, work in flight, and loose ends over the activity window.           |
| Client or team update   | Put together a client update for this week.    | Produces a concise progress report from captured outcomes across the requested time window. |
| Changelog               | Draft the changelog between v1.4.0 and v1.5.0. | Builds release notes from captured task labels and outcomes rather than commit subjects.    |
| Development journal     | Append this week's work to `docs/journal.md`.  | Adds a dated, artifact-linked record of shipped work, decisions, and open items.            |

Standups, client updates, and journals use activity windows such as yesterday or
this week. Changelogs use a git ref range and can surface captured work whose
commits may have been rebased. Reports can cover the current repository or, when
the archive is enabled, captured work across projects.

Use `orcaops-digest` instead when you want the reviewer-facing account of one PR
or artifact. Use `orcaops-resume` when you want to continue the work rather than
report on it.

## Understand and reuse prior work

| Ask your agent                                  | Skill                   | Result                                                                         |
| ----------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Why does this validator exist?                  | `orcaops-why`           | Traces a file, line, symbol, or concept to its captured checkpoint and reason. |
| Have we worked on authentication before?        | `orcaops-search`        | Searches captured artifacts across branches and archived projects.             |
| Critique this plan against our prior decisions. | `orcaops-plan-critique` | Finds relevant prior art and stress-tests a draft before capture.              |
| Replay how this feature came together.          | `orcaops-timetravel`    | Replays checkpoints; it can also bisect or salvage a captured attempt.         |
| Import the existing git history.                | `orcaops-seed`          | Previews, then backfills older commits after explicit approval.                |

If provenance or search misses an older, uncaptured area, the agent may use the
`orcaops-seed-discovery` history-gap skill to explain the cold coverage and
recommend a seed. It does not import history without your approval.

## Opt-in skills

Six shipped skills are available but disabled by default because their intents
are specialized or their actions should remain deliberate:

| Skill                       | Ask for                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `orcaops-loose-ends`        | Sweep current open items, deferred decisions, uncertainty, uncovered steps, and stale work. |
| `orcaops-decisions`         | Recall recorded decisions and rejected alternatives, or promote them into ADRs.             |
| `orcaops-parallel-dispatch` | Dispatch disjoint captured plan steps to concurrent subagents.                              |
| `orcaops-estimate`          | Estimate a plan from the shape, checkpoints, and attributed usage of similar captured work. |
| `orcaops-lessons`           | Turn recurring uncertainty and evaluator outcomes into evidence-linked lessons.             |
| `orcaops-blame`             | Export per-line agent provenance for a commit in the agent-trace format.                    |

Enable an opt-in template, then refresh the generated support files:

```bash
orcaops skills enable <skill-id>
orcaops update
```

For example, use `orcaops skills enable loose-ends`. The `blame` skill also
requires the matcher capability because it exports line-level provenance and
can write a file or git note.

## Diagnose and extend Orcaops

| Ask your agent                       | Skill                      | Result                                                                     |
| ------------------------------------ | -------------------------- | -------------------------------------------------------------------------- |
| Is Orcaops set up correctly?         | `orcaops-doctor`           | Diagnoses adapters, environment, evaluator packs, caches, and watch state. |
| Make this failure mode an evaluator. | `orcaops-author-evaluator` | Guides a deliberate evaluator implementation and test loop.                |

Evaluator code can execute with your permissions. The authoring workflow stops
at development registration and does not silently grant durable trust or enable
the evaluator for a team. See [Authoring evaluator packs](./authoring-evaluator-packs.md)
for the underlying contracts.

## Optional team and Cloud workflows

After authentication, additional skills can drive shared plan approval and web
review feedback. Team or repository instructions can make them automatic for
matching work; the prompts below are manual controls when you want to start or
resume the workflow explicitly:

| Ask your agent                    | Skill                   | Result                                                                    |
| --------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| Get this plan approved.           | `orcaops-plan-approval` | Uploads a plan, follows human feedback, and records the approved version. |
| Address the open review comments. | `orcaops-review`        | Pulls review threads, replies to each acted-on thread, pushes, and waits. |

These extend the local workflow; they do not make Cloud a prerequisite for
capture, evaluation, search, or Task Review.

## Complete skill index

This is the canonical index of the 26 skill templates shipped by Orcaops. The
installed name is `<prefix>-<id>`; the table uses the default `orcaops-` prefix.
“Default” means the template is selected automatically when its listed
requirement is available. “Opt-in” templates appear in `orcaops skills list`
but are installed only after you enable them.

| Skill                        | State   | Requirement       | Purpose                                                       |
| ---------------------------- | ------- | ----------------- | ------------------------------------------------------------- |
| `orcaops-capture`            | Default | None              | Capture or revise a task plan.                                |
| `orcaops-checkpoint`         | Default | None              | Open, close, or abandon a coherent work checkpoint.           |
| `orcaops-plan-approval`      | Default | Cloud             | Drive web plan review and preserve the approved version.      |
| `orcaops-pre-pr`             | Default | None              | Run the final evaluator pass before summary.                  |
| `orcaops-finish`             | Default | None              | Review and finalize a completed task in one workflow.         |
| `orcaops-summary`            | Default | None              | Record the task outcome, verification, and open items.        |
| `orcaops-digest`             | Default | None              | Render a reviewer-facing task account or PR body.             |
| `orcaops-why`                | Default | None              | Trace a file, line, symbol, or concept to captured rationale. |
| `orcaops-resume`             | Default | None              | Continue an in-flight captured task.                          |
| `orcaops-search`             | Default | None              | Search captured artifacts across branches and archives.       |
| `orcaops-doctor`             | Default | None              | Diagnose installation and runtime health.                     |
| `orcaops-adversarial-review` | Default | None              | Challenge completion claims and unaccounted changes.          |
| `orcaops-loose-ends`         | Opt-in  | None              | Sweep everything captured work still owes.                    |
| `orcaops-decisions`          | Opt-in  | None              | Recall decisions, reasons, and rejected alternatives.         |
| `orcaops-parallel-dispatch`  | Opt-in  | None              | Run disjoint plan steps through concurrent subagents.         |
| `orcaops-estimate`           | Opt-in  | None              | Ground estimates in similar captured task shapes and usage.   |
| `orcaops-lessons`            | Opt-in  | None              | Mine captured outcomes into evidence-linked lessons.          |
| `orcaops-timetravel`         | Default | Snapshot checkout | Replay, bisect, or salvage checkpoint-boundary trees.         |
| `orcaops-blame`              | Opt-in  | Matcher           | Export commit-level per-line agent provenance.                |
| `orcaops-recap`              | Default | None              | Produce standups, changelogs, client updates, or journals.    |
| `orcaops-plan-critique`      | Default | None              | Critique a draft plan against captured prior art.             |
| `orcaops-task-review`        | Default | None              | Generate Task Review or address its local comments.           |
| `orcaops-review`             | Default | Cloud             | Work shared PR review feedback and wait for another pass.     |
| `orcaops-seed`               | Default | None              | Preview and backfill an existing repository's git history.    |
| `orcaops-seed-discovery`     | Default | None              | Detect local history-coverage gaps and recommend seeding.     |
| `orcaops-author-evaluator`   | Default | None              | Guide evaluator implementation through development testing.   |

## If a skill does not trigger

1. Name it explicitly: “Use `orcaops-resume` to continue this work.”
2. Run `orcaops doctor` to check the selected agent and generated support files.
3. Run `orcaops update` after a CLI upgrade or agent-install change.
4. Confirm the current repository has been initialized with `orcaops status`.

Agent-specific slash commands are generated only where the adapter and install
scope support them. Plain language and explicit skill names work across agents.
