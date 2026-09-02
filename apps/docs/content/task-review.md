---
description: 'Generate a branch review, inspect it in orcaops watch, and collaborate with your agent through local diff comments.'
---

# Task Review

Task Review is Orcaops' local reviewer experience. Your agent assembles a
bounded review from captured evidence and the branch diff; `orcaops watch` lets
you read that review alongside the work in a terminal UI.

## Generate a review when you are ready

One branch or worktree can contain several completed Orcaops artifacts. Orcaops
does not guess when you consider that combined body of work ready for review.
When you are done with the work you want included, ask your agent:

```text
Generate a Task Review for this branch.
```

If the branch changes materially afterward, request a refresh:

```text
Regenerate the Task Review for this branch.
```

The `orcaops-task-review` skill runs two separated passes:

- a **forensic lane** reviews the eligible diff without seeing the captured
  plan or the agent's account; and
- an **account lane** organizes the captured intent, decisions, checkpoints,
  verification, evaluator results, and uncertainty without inspecting code.

Orcaops validates and combines both into a causal Story. This keeps the review
useful without allowing one lens to silently borrow the other's conclusions.

## Open Orcaops Watch

Run this from any initialized repository:

```bash
orcaops watch
```

**Orcaops Watch** is a cross-project dashboard over local captured work. The
basic path is:

1. Select a thread or task with `j`/`k` or the arrow keys.
2. Press `Enter` or `→` to inspect its details.
3. With a reviewable branch selected, press `v` to open **Review**.
4. Use `Tab` to move between panes and `q` to move back one level.
5. Press `?` anywhere for the commands available on the current screen.

The footer always prioritizes the keys that matter in the current context. `r`
chooses a repository, `/` cycles the status filter, `w` changes grouping, `t`
chooses a theme, and `q` quits when you are back at the Watch root. Mouse and
trackpad scrolling are also supported.

## Understand Task Review results

A completed Task Review means the review routine produced readable material. It
does not mean the branch is correct or safe to merge.

- **Story** explains the causal structure of the work and attaches owned code
  ranges to its Parts when attribution is available.
- **Captured checkpoints** provide a deterministic fallback view of the recorded
  work even when no current Story exists.
- **Forensic findings** are unadjudicated leads for the human reviewer, not
  confirmed defects.
- **Unassigned or degraded attribution** means some reviewable rows could not be
  tied cleanly to a captured checkpoint; it should remain visible, not guessed.
- **Stale** means the installed Story was generated for an earlier branch state.
  Ask the agent to regenerate it after the additional work is complete.

For a skeptical audit of whether the agent's completion claims hold up, ask it
to “do an adversarial review.” That is a separate workflow from routine Task
Review.

## Leave review comments for your agent

When something in the review looks wrong, is unclear, or needs another change,
leave a comment on the relevant diff in `orcaops watch`. The comment stays
attached to that code context in the branch's local review state, ready for your
agent to read through the same `orcaops-task-review` skill that generated the
review.

Ask your agent:

```text
Address the open Task Review comments on this branch.
```

The skill loads the open comments with their current diff context and nearby
captured reasoning. It treats each comment as a work item: the agent can answer
in the thread, make and verify the requested change, and reply with the
checkpoint that addressed it. A comment is resolved only when the request has
actually been satisfied.

Back in Orcaops Watch, you can read the agent's reply beside the review,
inspect any change, leave a follow-up, or resolve the thread. Open comments
remain visible so unresolved feedback is not mistaken for finished review. If
the code has moved and Orcaops cannot safely re-anchor a comment, it keeps the
comment visibly unresolved instead of silently attaching it to different code.

Comments and generated Task Review artifacts live under
`.orcaops/reviews/<branch>/`; do not edit those files by hand. This feedback
loop stays in the repository's local review state. Cloud PR comments are a
separate, optional collaboration loop documented in
[Cloud collaboration](./cloud-collaboration.md#address-web-review-feedback-through-the-agent).

## Advanced protocol reference

Most users should ask their agent and let the skill handle review generation. If
you are integrating the review engine or diagnosing a failed lane, see the
[Task Review protocol](./task-review-protocol.md) for CLI payloads, status
dimensions, limits, repair budgets, and artifact schemas.
