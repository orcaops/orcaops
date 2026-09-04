# Orcaops

**Git versions your code. We version your intent.**

As your coding agent works, Orcaops captures the plan, decisions, progress,
checks, and open questions in a local, versioned task record — without
replacing your agent, planning tools, or development workflow.

Documentation: <https://docs.orcaops.ai/> · Website:
<https://orcaops.ai>

## What it does

- **Keep your workflow.** Continue using the coding agent and planning method
  you already have. Orcaops installs skills into supported agents and captures
  the task as the work happens, with no separate reporting step.
- **Watch the work, not just the answer.** `orcaops watch` opens a terminal UI
  over the captured plan, progress, decisions, findings, and Task Review as
  they develop. Leave comments directly on the diff for your agent to read,
  answer, or address.
- **Don't take "done" on faith.** Evaluators compare the finished code and
  recorded evidence with the task the agent captured, surfacing missing work,
  scope drift, unsupported claims, and unresolved questions while they can
  still be addressed.
- **Make every task compound.** Each completed task leaves behind decisions,
  constraints, rejected approaches, and evidence that future agents can search
  and build on instead of rediscovering it — or undoing deliberate choices.

## How it works

Describe a task to your agent the way you normally would. The installed
Orcaops skills run the capture lifecycle underneath:

**plan → checkpoint(s) → finish**

- **Plan** records the intended outcome, boundaries, decisions, and acceptance
  criteria before implementation. If the work changes the plan, the agent
  revises the same record rather than starting over.
- **Checkpoints** bracket each coherent unit of work. Orcaops attributes
  changed lines by diffing the worktree between open and close, so provenance
  comes from real diffs, not from the agent's account of them.
- **Finish** runs the final evaluator pass, pauses on warnings that need a
  human, records the summary, and renders the reviewer-facing digest.

Together these form a **task record**: the plan and its revisions,
checkpoints, decisions, verification, evaluator results, uncertainty, and the
final outcome. The CLI calls one captured task thread an **artifact**, and a
branch can hold several.

When the branch is ready, ask your agent to generate a **Task Review**. A
forensic lane reviews the diff without seeing the agent's account, an account
lane organizes the captured intent without inspecting code, and Orcaops
validates and merges both into one review you read in `orcaops watch`. It is
review material for a human, not a merge verdict.

## Getting started

You need Node.js 22.14 or newer on macOS or Linux (Windows via WSL2), and a git
repository with at least one commit. `orcaops watch`, the Task Review terminal
UI, installs with the CLI as a compiled companion for your platform; nothing
else is required.

```bash
npm i -g @orcaops/cli
orcaops --version

# from the repository root
orcaops init
```

[orcaops.ai](https://orcaops.ai) is the project site and where accounts live.
npm is the only place the CLI is published; the site points at the command
above rather than offering a second way in.

`init` detects your coding agents and installs the matching Orcaops skills.
The default personal setup changes nothing that git tracks: skills go to each
agent's global location and `.orcaops/` is hidden through git's local exclude,
so teammates see no difference.

Then open your agent in the repository and describe a task normally:

```text
Add pagination to the activity feed and update its tests.
```

When you want to review the branch, ask for the review and open Watch:

```text
Generate a Task Review for this branch.
```

```bash
orcaops watch
```

Supported agents: Claude Code, Codex, Cursor, OpenCode, AiderDesk, GitHub
Copilot, and Antigravity CLI.

The [Getting started](apps/docs/content/getting-started.md) guide walks through
the full setup, including exactly what `init` changes and how to undo it.

## Local by default

Capture, evaluators, search, provenance, and `orcaops watch` all operate on
local data. Network access starts only when you log in for an optional Cloud
workflow, or when a tool you configured — such as an LLM-backed evaluator —
calls its own provider. Evaluator packs are opt-in; `orcaops init` installs
none. See [Local data and privacy](apps/docs/content/local-data.md).

## Teams and Cloud

`orcaops update --scope project` materializes shared skills, instructions,
and evaluator configuration for the whole team to review and commit. Orcaops
Cloud adds cross-repository history, web plan approval, and pull-request
review on top of the local workflow; connect with `orcaops login`. See
[Adopt as a team](apps/docs/content/team-adoption.md) and
[Cloud collaboration](apps/docs/content/cloud-collaboration.md).

## Documentation

The hosted site is at <https://docs.orcaops.ai/>. The same pages
live in this repository under `apps/docs/content/`.

**Start locally**

- [Getting started](apps/docs/content/getting-started.md)
- [Import git history](apps/docs/content/seed.md)
- [Local data and privacy](apps/docs/content/local-data.md)

**Work through your agent**

- [Working with your agent](apps/docs/content/working-with-your-agent.md)
- [Skills](apps/docs/content/skills.md)
- [Task Review and Watch](apps/docs/content/task-review.md)
- [Evaluators](apps/docs/content/evaluators.md)

**Teams and Cloud**

- [Adopt as a team](apps/docs/content/team-adoption.md)
- [Cloud collaboration](apps/docs/content/cloud-collaboration.md)
- [Authentication](apps/docs/content/authentication.md)
- [Plan review](apps/docs/content/plan-review.md)

**Reference and extensions**

- [Configuration](apps/docs/content/configuration.md)
- [Agent integrations](apps/docs/content/agent-integrations.md)
- [Session hooks](apps/docs/content/session-hooks.md)
- [Capture and data](apps/docs/content/data-configuration.md)
- [Troubleshooting](apps/docs/content/troubleshooting.md)
- [Command reference](apps/docs/content/command-reference.md)
- [Glossary](apps/docs/content/glossary.md)
- [Authoring evaluator packs](apps/docs/content/authoring-evaluator-packs.md)
- [Task Review protocol](apps/docs/content/task-review-protocol.md)

## Security

See [SECURITY.md](SECURITY.md) for the trust model — in particular, what a
checked-in repository configuration is and is not allowed to authorize, and
how consent for evaluator packs works.

## Development

This is a pnpm workspace:

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm typecheck:tests`
mirror CI. See [TESTING.md](TESTING.md) for the test taxonomy — where a new
test belongs and how to keep it discovered and typechecked — and
[docs/dependency-policy.md](docs/dependency-policy.md) before adding a
dependency.
