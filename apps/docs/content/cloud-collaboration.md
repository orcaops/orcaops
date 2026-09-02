---
description: 'Share captured task records through Cloud history, plan approval, and pull-request review workflows.'
---

# Cloud collaboration

Orcaops Cloud turns the task records developers capture locally into a shared
team workflow. It provides cross-repository history, web plan approval, and
pull-request review while developers continue working through their existing
agents and local tools.

Use [team adoption](./team-adoption.md) to give every developer the same skills,
instructions, and evaluator configuration. Cloud can be piloted with one
authenticated developer before the repository-wide setup is committed.

## Connect an account and organization

```bash
orcaops login
orcaops whoami
orcaops org switch  # when your account belongs to multiple organizations
```

See [Authentication](./authentication.md) for browser, headless, credential
storage, and logout details.

## Understand the sync boundary

When you are logged out, the CLI sends no repository, capture, review,
evaluator, file-path, hash, or usage data to Orcaops Cloud. Local capture,
search, provenance, and Task Review continue to work without a Cloud account.

Cloud sync starts only after `orcaops login` or an official Cloud token is
provided. When authenticated, the CLI syncs the task record, evaluator results,
file paths, change counts and hashes, branch and commit identifiers, and
aggregate token usage. It does **not** upload source files or raw diffs.

If you connect GitHub or Bitbucket in Cloud, that source-control integration can
read code there to anchor the review page and post a digest or status check. The
code comes from the source-control provider, not from the Orcaops CLI.

See [Local data](./local-data.md) for the precise local, archive, and Cloud data
boundaries.

## Review a plan before coding

When repository instructions or the task require plan approval, the agent
selects `orcaops-plan-approval` before implementation. You can express that
requirement in ordinary task language:

```text
Get this plan approved by Alice before implementation.
```

The skill uploads the candidate, resolves reviewers, surfaces comments and
proposals, and waits in bounded intervals. A human approves on the web. The agent
then retrieves and records that approved version so the task remains tied to
exactly what the reviewer accepted. You do not need to prompt separately for
upload, polling, retrieval, or capture.

Read [Plan review](./plan-review.md) for the author and reviewer workflows,
version behavior, approval anchors, and integration reference.

## Share the completed task on a pull request

The agent completes the local capture lifecycle through summary and digest. For
a task that Cloud and the source-control integration can match to a pull request,
reviewers receive the task account and check status alongside the code. Work that
was never captured does not receive a guessed Orcaops verdict; partial adoption
remains visible.

Reviewer decisions and dismissals stay attached to the task record. Supported
agents can use that shared history in later plans instead of reconstructing the
decision from commits and chat logs.

## Address web review feedback through the agent

Addressing reviewer feedback is an ordinary development request:

```text
Address the open review comments on this pull request.
```

The agent selects `orcaops-review` and the skill:

1. checks review status and pulls the anchored transcript;
2. replies to every thread it acts on;
3. captures each coherent change as a checkpoint;
4. pushes the branch so the reviewer can inspect the update; and
5. waits for another human pass in a bounded polling window.

Only the human reviewer resolves threads. The agent reports a quiet timeout as
“no reviewer activity,” not as a failed implementation or an approval.

You provide the intent and make any product decisions the feedback requires; the
agent owns the transcript, replies, checkpoints, push, and bounded wait.

This web feedback loop is separate from comments and dispositions stored in
[Orcaops Watch](./task-review.md), opened with `orcaops watch`.
