---
description: 'Route selected plans through human web approval while the agent preserves the approved version automatically.'
---

# Plan review

Some plans deserve a human sign-off before the agent builds anything. Plan
review sends a plan to the cloud, lets a teammate review and approve it **on
the web**, and records the approved version with the task when it is captured.
The task record therefore preserves exactly what your reviewer approved, not
just what the agent originally drafted.

Like the rest of Orcaops, the workflow runs through your agent. `init` installs
the `orcaops-plan-approval` skill, and repository instructions or the task can
tell the agent when human approval is required. Once required, the agent manages
the workflow; you do not advance upload, polling, pull, and capture as separate
steps.

## What happens automatically

When a task requires approval, the agent:

1. drafts the plan before implementation;
2. uploads it and requests the named reviewers;
3. surfaces comments, proposed edits, and verdicts as they arrive;
4. sends a revised candidate after feedback is addressed; and
5. after web approval, retrieves the approved version and records it as the
   task's approval anchor.

The agent waits only in bounded stretches. If nothing changes after a few quiet
checks, it returns control with the current state instead of polling forever. A
later session can resume the same review.

Name reviewers the way you normally refer to them; you do not need to provide
an email address. The agent checks your organization's reviewer roster. If the
name is not an exact match, the CLI returns likely matches so the agent can
confirm the intended teammate before sending the request. Nobody is silently
requested when the reviewer is unclear.

## What remains a human decision

- Decide whether the task requires review when repository policy does not already
  say so.
- Choose the reviewers and resolve ambiguous reviewer names.
- Accept, reject, or modify proposed plan changes.
- Click **Approve** on the web when the exact candidate is acceptable.

Only a human clicking **Approve** on the web page moves a plan to approved.
Nothing the agent or CLI does can approve one; CLI verdicts are advisory opinions
for the author.

## Manual controls

You can start, inspect, or resume the workflow explicitly at any time. These are
controls, not steps you must add to every reviewed task:

- **Send this plan to Alice for review.** starts approval when the
  requirement was not already part of the task or repository instructions.
- **Any feedback on my plan yet?** reports comments, proposals, and verdicts.
- **Address Alice's feedback.** pulls the latest candidate and prepares a
  revision for review.
- **What changed since I last looked?** shows the version diff.
- **Wait for the review to come back.** starts another bounded wait.

One thing worth knowing: a verdict is cast on a specific version and doesn't
reset when a new candidate is pushed. The agent flags verdicts on older
versions as stale — "changes requested" on v1 means _re-review needed_, not
_still blocked_, once v2 is up.

## The approved plan becomes the task anchor

When approval arrives, the agent retrieves the approved version and records it
when capturing the task. That version becomes the task's immutable approval
anchor, so later edits cannot obscure what the reviewer accepted. You do not
need to retrieve or attach it yourself.

::: info Approval anchor
The approval anchor is set once, at capture, and frozen. Mid-flight plan
revisions still work the same as ever—your checkpoints survive—but they never
rewrite what was approved. To build against a _newer_ approved version, the
agent retrieves it and starts a fresh captured task.
:::

## Reviewing a teammate's plan

The loop works from the other seat too:

```text
Show me the plans waiting on my review.
Pull up Bob's plan.
```

The agent walks you through the plan, and you can leave comments, suggest an
edit, or record your verdict through it. Your verdict is advisory — the
approval itself is still the web page.

## CLI reference for integrations

The skill owns the upload, review, waiting, retrieval, and capture sequence.
Automation authors can drive the same surface through `orcaops plan` and
`orcaops plan review`; see the [command reference](./command-reference.md) and
the installed command's `--help` output for the complete verbs and flags.
