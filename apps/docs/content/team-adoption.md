---
description: 'Standardize Orcaops agent support and Cloud collaboration across a repository and engineering team.'
---

# Team adoption

Orcaops Cloud is the collaboration layer for teams. It turns the task records
developers capture locally into shared history, web plan approval, and
pull-request review.

Project scope complements Cloud by sharing agent skills, instructions, and
evaluator configuration through git. It gives every developer a consistent
Orcaops setup; it is not a replacement for the shared team workflow in Cloud.

## What project scope changes

The default personal install keeps skills in the current developer's home
directory, keeps its configuration in the repository's git common directory,
and hides each worktree's `.orcaops/` store. Project scope instead materializes
the selected agent support into the repository:

- generated skills and any supported slash commands;
- the Orcaops block in agent instruction files;
- `.orcaops/config.json`, evaluator configuration, and the install manifest;
- managed `.gitignore` entries for local artifacts and caches.

Captured plans, checkpoints, reviews, caches, and usage records remain ignored.
Committing project scope shares the workflow, not each developer's local task
history.

## Roll out from one engineer

From a working personal installation:

```bash
orcaops update --scope project
git status --short
```

Review every materialized file before committing it. The following loop stages
only supported surfaces that actually exist in your repository:

```bash
for path in .orcaops .gitignore .claude .agents .cursor .opencode .aider-desk AGENTS.md CLAUDE.md; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    git add -A -- "$path"
  fi
done
git commit -m "adopt orcaops"
```

Teammates then:

1. pull the committed setup;
2. install the CLI with `npm i -g @orcaops/cli`; and
3. run `orcaops update` in the repository to reconcile their local agent
   surfaces and runtime support.

If a teammate's setup does not behave as expected, `orcaops doctor` can diagnose
unsupported agents, stale files, evaluator discovery issues, or missing
runtimes. It is a troubleshooting tool, not an onboarding requirement.

## Decide what belongs in git

Generated agent files are committed by default in project scope. If the team
prefers to regenerate them on each machine:

```bash
orcaops update --scope project --generated-files ignore
```

The committed manifest and configuration remain the shared declaration; each
developer runs `orcaops update` to materialize ignored support files locally.
This reduces generated-file churn but makes a successful local update part of
onboarding.

Review evaluator registrations with particular care. A repository may declare
and enable evaluators, but it cannot grant user-local execution trust. Each
developer retains control over the capabilities third-party evaluator code may
use.

## Personal installs and the adoption commit

A personal install keeps nothing in the worktree that an adoption commit would
collide with: its configuration lives in the git common directory, so pulling a
teammate's `.orcaops/config.json` simply makes that project config win in the
checked-out worktree. Switching a worktree to project scope yourself releases
the shared `info/exclude` claim so the materialized files are visible to
`git add`; a sibling worktree that stays personal re-adds the block on its next
`orcaops update`.

## Connect the shared workflow

Project scope standardizes what runs in each developer's environment, but it
does not sync task records or create shared web reviews. Connect the team to
Orcaops Cloud for shared history, plan approval, and pull-request review. Follow
[Cloud collaboration](./cloud-collaboration.md) for account, organization, sync,
and review setup.
