---
description: 'Install Orcaops, initialize a repository, keep your existing agent workflow, and inspect a local Task Review.'
---

# Getting started

Orcaops gives your coding agent skills for capturing and reviewing its work. You
keep talking to the agent in plain language; the skills call the Orcaops CLI and
record a structured plan, checkpoints, decisions, verification, and a final
summary underneath.

Everything in this guide runs locally. You do not need an Orcaops account to
capture work, run evaluators, or use Orcaops Watch.

## How Orcaops names the work

Orcaops builds a **task record** while your agent works: the plan and its
revisions, checkpoints, decisions, verification, evaluator results, uncertainty,
and final outcome. The CLI and lower-level reference pages call one captured
task thread an **artifact**. A branch can therefore contain several artifacts
that contribute to one body of work.

A **completion check** is the user-facing last look at that work before you
accept it. Evaluators compare the captured record with its requirements, while
Task Review independently examines the code and organizes the captured account
for a human reviewer. Neither a clean evaluator result nor a generated Task
Review is automatically a merge verdict.

The [Glossary](./glossary.md) is the quick reference for these and other terms
that appear in Orcaops Watch, the digest, and lower-level command output.

## Prerequisites

- **Node.js 22 or newer** — check with `node --version`.
- **macOS or Linux** on x64 or arm64. On Windows, use WSL2.
- A **git repository with at least one commit**.
- **[Bun](https://bun.sh) — for `orcaops watch` only.**

## 1. Install the CLI

```bash
npm i -g @orcaops/cli
orcaops --version
```

> [!NOTE]
> Orcaops stores its task records in SQLite, whose native module is fetched by
> `better-sqlite3`'s install script. If your npm blocks install scripts (an
> `allow-scripts` policy or `--ignore-scripts`), the install "succeeds" but the
> first real command fails with a missing-binding error — reinstall with
> `npm install -g --allow-scripts=better-sqlite3 @orcaops/cli`.

## 2. Initialize your repository

Run this once from the repository root:

```bash
orcaops init
```

`init` detects your supported coding agents and installs the matching Orcaops
skills. Interactive setup shows the agents it detected, then asks:

- which agents should receive Orcaops skills;
- whether to add the recommended session-start reminder so those agents remember
  to capture non-trivial work;
- whether Orcaops should maintain an instruction-file section when that surface
  is supported and still needed; and
- whether to keep a durable backup of captured history in your home directory.

### What `init` changes

The default personal setup is designed for one developer to try Orcaops without
changing the repository for anyone else.

| Surface             | What happens                                                                                                                                                                                                | Why                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Agent skills        | Installs skills in the repository or in each selected agent's global skill location, depending on install scope. The default personal setup uses global locations, so no skill files enter the repository.  | Your agent can run the capture and review workflows without committing generated files. |
| `.orcaops/`         | Creates `.orcaops/artifacts/`, `.orcaops/cache/`, and `.orcaops/config.json` inside the checkout. The directory is hidden with git's local `info/exclude`.                                                  | Task records stay beside the repository while `git status` remains clean.               |
| Repository identity | Stores a repository ID in local git config, shared by its worktrees.                                                                                                                                        | Orcaops can recognize the same repository without deriving identity from its path.      |
| Workflow guidance   | Offers a recommended session-start hook and, where supported, a managed instruction-file section. Hooks emit only in initialized repositories; managed instructions stay within the selected install scope. | The agent remembers to run the lifecycle when you give it an ordinary development task. |
| History archive     | If enabled, mirrors captured history to the per-user Orcaops data directory (`~/.orcaops` or the platform's XDG data directory).                                                                            | The task record can survive a deleted worktree.                                         |
| LLM tool            | Selects an available local coding-agent CLI automatically when an Orcaops workflow needs a model; it reuses that tool's login rather than asking Orcaops for an API key.                                    | You keep using the coding-agent subscription already configured on the machine.         |
| Tracked repository  | No tracked files, `.gitignore` edits, tracked instruction-file edits, git hooks, or background services are added by the default personal setup.                                                            | You can evaluate Orcaops without affecting teammates or the project diff.               |

Keep either the recommended session reminder or managed instruction section
enabled to get the automatic workflow described below. Skills are installed even
if you decline both, but skills alone provide capabilities rather than a
session-wide reminder to capture every non-trivial task; in that deliberately
manual setup, you may need an explicit skill request.

At the end, `init` prints the directories and agent support it created, whether
session reminders and the archive are enabled, the selected LLM tool, and the
command for adopting Orcaops as a team later:

```bash
orcaops update --scope project
```

That command materializes the shared files for review and commit; it is not part
of the personal setup. For unattended setup, `orcaops init --yes` uses personal
scope and does not install session hooks or edit agent instruction files.
That unattended mode installs the skills but intentionally leaves proactive
workflow guidance off. Use interactive `orcaops configure` afterward and follow
any machine-registration instruction it prints when you want to enable that
guidance with consent.

::: details Example interactive initialization

```console
$ npm i -g @orcaops/cli
$ orcaops init

◇ Which AI coding agents do you use in this repo?
│ ● claude-code (detected)
│
◇ Session-start hooks put a short Orcaops reminder into your agent's
│ context at the start of every session, so it remembers to capture
│ its work. What should the reminder say?
│ ● On — fixed reminder (recommended)
│
◇ Keep a backup of captured session history in your home directory?
│ ● Yes
```

After those choices, `init` prints a summary like this. Paths are normalized
and intermediate sections are omitted; your selected agent and install scope
determine the exact paths and counts.

<!-- cli-output:init-summary:start -->

```text
Orcaops initialized at <repo>

Created:
  .orcaops/artifacts/
  .orcaops/cache/
  .orcaops/config.json

Installed 18 skills for claude-code → <agent-skills-dir>

…

Machine session hooks installed for:
  + claude-code

…

LLM tool: auto (piggybacks on your local subscription — no API key).

…

Invisible install: nothing touches git — `git status` stays clean, teammates
see nothing. To adopt orcaops as a team later: `orcaops update --scope project`,
then commit the files it materializes.

…

Next: have your agent capture plans + checkpoints via `orcaops capture …`.
Change settings: `orcaops configure` · Undo: `orcaops uninstall`
```

<!-- cli-output:init-summary:end -->

:::

The installed count includes the default-enabled skills compatible with that
agent and scope. The [complete skill index](./skills.md#complete-skill-index)
also lists opt-in and capability-gated skills.

## 3. Give your agent a normal task

Open your coding agent in the repository and describe the task normally:

```text
Add pagination to the activity feed and update its tests.
```

With the recommended session reminder or managed instructions enabled, the
installed guidance tells the agent to capture a plan before editing, checkpoint
coherent units of work, and finish with the review, summary, and digest in one
workflow. You do not add Orcaops instructions to each task or prompt for those
phases individually. The skills own their CLI arguments, ordering, evaluator
responses, and recovery behavior.

Explicit skill requests are available when you want to override the normal flow
or recover from a missed trigger. Learn those controls—and the everyday
on-demand requests—in
[Working with your agent](./working-with-your-agent.md).

## 4. Generate and inspect the branch review

One branch or worktree can contain several captured task artifacts, so you
decide when the combined work is ready for review. Then ask your agent:

```text
Generate a Task Review for this branch.
```

The skill assembles the branch-level review. From the repository, open it in
Orcaops Watch:

```bash
orcaops watch
```

Orcaops Watch is the local terminal interface over captured artifacts and branch
changes. Use it to inspect the captured reasoning alongside the diff and read
the generated Task Review. Ask the agent to regenerate it after material branch
changes.

Capture, evaluation, and Task Review stay local unless you deliberately enable a
Cloud workflow.

## Where to go next

- Starting in an established repository? [Backfill its git history](./seed.md)
  so search and provenance have earlier context.
- Want more ways to use the installed skills? Browse the
  [skill catalog](./skills.md).
- Need to change agents, install scope, hooks, or generated files? Use
  `orcaops configure` or open [Configuration](./configuration.md).
- Adopting Orcaops across a team? Follow [Team adoption](./team-adoption.md) to
  standardize the developer setup, then connect
  [Cloud collaboration](./cloud-collaboration.md) for shared history, plan
  approval, and web review.

## Updating

```bash
npm i -g @orcaops/cli@latest    # or @<version> to pin
```

## Maintain or remove the installation

After updating the CLI, refresh generated support files with:

```bash
orcaops update
```

To inspect what an uninstall would remove, then uninstall safely:

```bash
orcaops uninstall --dry-run
orcaops uninstall
npm rm -g @orcaops/cli
```

Captured data under `.orcaops/` is kept by default. `--purge-data` is the
explicit destructive option when you also intend to remove it.
