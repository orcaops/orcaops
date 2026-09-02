---
description: 'Keep your current planning and development tools while installed skills handle Orcaops through your coding agent.'
---

# Working with your agent

Orcaops is designed for conversations with your coding agent. Ask for an outcome
in ordinary language; an installed Orcaops skill translates the request into the
right CLI calls, checks the result, and reports back in terms you can act on.

The CLI remains available for automation and inspection, but it is not the
interface you need to memorize.

For the complete intent-to-skill map, see [Skills](./skills.md).

As Orcaops captures a task, the docs use **task record** for the complete
user-facing record and **artifact** for one task thread in CLI output. The
completion check you perform before accepting work can draw on evaluator
results, Task Review, and the digest; it is an outcome, not a separate lifecycle
command you must remember to run.

## Keep your planning method and tools

Continue planning the way you do today: from a product spec, issue, design doc,
spec framework, your agent's built-in plan mode, or an ordinary conversation.
You do not need to migrate to an Orcaops planning format, replace your coding
agent, or change editors.

Orcaops captures the plan your agent is working from and records its revisions,
decisions, checkpoints, and verification as the work unfolds. During initial
capture, the agent also preserves the exact plan it is using—whether it came
from a product spec, issue, design document, spec framework, built-in agent plan
mode, ordinary conversation, or approved Cloud plan.

If your planning tool creates a file, the capture skill uses it directly even
when it lives outside the repository. If the plan exists only in the
conversation, the agent preserves that plan for capture. You do not need to
export it, move it into the repository, or attach it to the task separately. If
the intended plan is genuinely unclear, identify it naturally, for example:

```text
Use plans/api-refactor.md as the plan for this task.
```

## Start with the intent

For ordinary implementation, give the agent the task exactly as you would
without Orcaops:

```text
Add pagination to the activity feed and update its tests.
```

The installed guidance tells the agent when to capture and which skills to use.
You do not need to prefix the request with “capture,” name a skill, or manage the
lifecycle yourself.

Other capabilities begin with a deliberate user intent. These are
representative requests, not magic phrases:

| What you want                  | What to ask your agent                   |
| ------------------------------ | ---------------------------------------- |
| Continue interrupted work      | Pick up where we left off.               |
| Check whether it is finished   | Is this actually done against the plan?  |
| Inspect the branch review      | Show me the Task Review for this branch. |
| Challenge the agent's claims   | Do an adversarial review of this work.   |
| Understand existing code       | Why does this function exist?            |
| Find related prior work        | Have we worked on authentication before? |
| Summarize a time window        | What did we ship this week?              |
| Recover or replay work         | Replay how this feature came together.   |
| Turn a lesson into a guardrail | Make that failure mode an evaluator.     |

The agent selects the matching skill from the installed set. Skill names such as
`orcaops-resume`, `orcaops-adversarial-review`, and `orcaops-recap` are useful
for discovery, but natural-language intent is the stable user interface.

## What the agent handles

For a normal captured task, the agent follows this lifecycle:

**plan → checkpoint(s) → finish**

- **Plan** records the intended outcome, boundaries, decisions, and acceptance
  criteria before implementation.
- **Checkpoints** bracket coherent units of work so changes can be attributed to
  what the agent says it completed.
- **Finish** runs the final evaluator pass, pauses on warnings that need review,
  then records the summary and renders the reviewer-facing digest.

If implementation changes the plan, the agent revises the same artifact instead
of discarding its earlier checkpoints. If a branch already has active captured
work, the agent resumes it rather than creating a competing thread.

These are agent responsibilities. A developer should not have to prompt for the
plan, each checkpoint, or each part of finalization as separate steps.

You may see the agent run detailed `orcaops capture ...` commands. Those commands
are the skill's implementation surface: the skill owns their payload shapes,
ordering, and evaluator responses.

## Review from the terminal

Open Orcaops Watch whenever you want to inspect the branch as a reviewer:

```bash
orcaops watch
```

`orcaops watch` opens captured artifacts and branch state in a local terminal
interface. See the [Task Review guide](./task-review.md) for navigation. A branch or
worktree may contain several artifacts, so you decide when the combined work is
ready for a branch-level review. At that point, ask:

```text
Generate a Task Review for this branch.
```

The agent invokes the skill and handles the two review lanes, validation, and
assembly. Ask it to regenerate the review if the branch changes materially
afterward.

The review combines a capture-grounded account of what the agent claims happened
with a capture-blind forensic pass over the code. It is review material, not a
merge verdict; findings remain leads for a human to adjudicate.

For a more skeptical check, ask for an adversarial review. That workflow attacks
the completion evidence, recorded uncertainty, plan lineage, and changes that
were not accounted for by checkpoints.

## Explicit skill invocation and recovery

You normally do not name lifecycle skills. Explicit invocation is useful when a
skill did not trigger, you are recovering an interrupted installation, or you
intentionally want to rerun one workflow. Most supported agents can invoke a
skill by name. Exact slash-command syntax varies by agent and installation
scope, so the portable form is the skill name or a plain-language request. For
example:

```text
Use orcaops-capture to capture this task before continuing.
Use orcaops-task-review to regenerate the stale branch review.
Use orcaops-resume to continue this task.
Use orcaops-why to explain the validator in src/auth.ts.
Use orcaops-recap for a changelog since v1.4.0.
```

If you chose a custom prefix during setup, replace `orcaops` with that prefix.
Project-scoped installs may also generate agent-specific slash commands.

## CLI use under the skills

Manual CLI use is mainly for automation, diagnostics, and targeted inspection:

```bash
orcaops status --json  # inspect the current branch's capture state
orcaops doctor         # diagnose installation and evaluator health
orcaops watch          # open Orcaops Watch
orcaops digest         # render the reviewer-facing digest
```

Run a command with `--help` for its current flags. If you intentionally want a
CLI-only setup, select no agents during interactive `init`; automation can use
`orcaops init --agents ''`.

Optional team skills add Cloud plan approval and web review-feedback loops after
authentication. Repository instructions can make those skills part of the
agent's normal workflow—for example, requiring approval for a particular task
class—without making developers manage their CLI phases. They do not replace
the local capture and Task Review workflow.
