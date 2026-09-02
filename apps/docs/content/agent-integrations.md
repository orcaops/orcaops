---
description: 'Configure supported coding agents, install scope, generated files, naming, workflow hints, and manifests.'
---

# Configure Orcaops for your coding agents

These settings control which coding agents receive Orcaops support, where those
files live, and how the managed installation is reconciled. Use
[Configuration](./configuration.md) for the minimal file shape and the other
configuration guides.

## Install set and capture attribution

`install.agents` is the install set: which supported agents receive generated
Orcaops support files. An empty array is manual mode — no agent support files
are installed, and you drive the CLI yourself.

Capture attribution is NOT configured here: there is no static
repo-level capture identity. Each artifact-writing command records the agent
that produced it, resolved per invocation — `--invoked-by-agent`, then
`ORCAOPS_INVOKED_BY_AGENT`, then unambiguous coding-agent environment markers,
then the deterministic `other` fallback. This keeps attribution accurate when
several agents work in one repository. `orcaops init` never persists capture
identity; the install set (`--agents` / `--install-agent`) only selects which
agents get skills and commands.

Supported install targets are `claude-code`, `codex`, `cursor`, `opencode`,
`aider-desk`, `github-copilot`, and `antigravity-cli`. Codex, Cursor, OpenCode,
GitHub Copilot, and Antigravity share the universal `.agents/skills` tree, so
selecting any combination of them materializes it once. GitHub Copilot is
skills-only: the Copilot CLI and VS Code surface installed skills as
`/skill-name` slash commands natively, so no command files are generated for it.

## Install scope

`install.scope` controls where generated support files are materialized:

- `personal` — **the default for a fresh `orcaops init`** — keeps the installation
  repository-invisible: skills materialize into the global skill location used by each
  selected agent (tracked in `~/.orcaops/install.local.json`), the optional
  bootstrap block lives in `CLAUDE.local.md`, and the whole `.orcaops/` store is
  hidden via the git common dir's `info/exclude`. `git status` stays clean, diffs
  stay empty, and teammates see nothing. Orcaops never edits a tracked file under
  personal scope (enforced at runtime—a plan that would do so is a bug, not a
  surprise diff).
- `project` keeps generated skills and commands in the repo — the
  [team adoption](./team-adoption.md) mode. Switch with
  `orcaops update --scope project`, then commit
  the files it materializes (config, `install.json`, skill trees,
  `.gitignore` lines); the info/exclude section is stripped on the way out so
  a plain `git add` works.
- `global` uses the selected agents' global skill locations like personal, but
  keeps the committed project manifest and instruction block.

Notes on `personal`:

- Every supported agent gets skills. The bootstrap block reaches Claude Code
  only (nothing else reads `CLAUDE.local.md`) — other agents are covered by
  session hooks or team adoption, and init/update surface an advisory when
  that gap applies.
- Slash commands require project scope: no supported agent declares a global
  command root, so `/orcaops:*` commands do not materialize under personal or
  global scope.
- The repo identity (`git config --local orcaops.projectid`) is minted at
  init under every scope — repo-local, invisible to `git status`, shared
  across worktrees. A filesystem copy that includes `.git` shares the same
  identity, pins, archive namespace, and global refs until explicitly re-keyed;
  Orcaops never guesses move versus copy or performs that re-key in doctor. To
  make a copy independent, run this in the copy before capturing new work:

  ```bash
  git config --local --unset orcaops.projectid
  orcaops update
  ```

  `update` mints a fresh identity that applies from then on; history, pins, and
  refs already recorded under the old identity stay where they are. Do not do
  this after an ordinary move, where keeping the identity is correct.

- Pulling a teammate's adoption commit while you have an untracked personal
  `.orcaops/config.json` makes git refuse the checkout ("untracked working
  tree file would be overwritten"): move your config aside, pull, then run
  `orcaops update`.

`install.link` controls global materialization:

- `copy` is the default and safest option.
- `symlink` is used only when Orcaops can do it without replacing unrelated
  files.

## Naming prefix

`naming.prefix` controls every generated Orcaops name:

- skills use `<prefix>-<verb>`, such as `orcaops-capture` or `oo-capture`;
- Claude Code slash commands use `<prefix>:<verb>`, such as `/orcaops:status` or
  `/oo:status`;
- the managed instruction block and generated skill bodies use the same prefix.

Prefixes must be lowercase and hyphen-safe.

Use `orcaops init --prefix <name>` on a fresh repo. Use
`orcaops update --prefix <name>` to rename an existing repo so the old generated
footprint is pruned safely.

## Bootstrap

`bootstrap` controls whether Orcaops manages the instruction block:

- `managed` makes `init`, `update`, and `doctor --fix` maintain the appropriate
  `## Orcaops` instruction block: `CLAUDE.local.md` for a personal Claude Code
  install, or the supported repository instruction files in project scope.
- `manual` means Orcaops does not mutate instruction files. Skills and commands
  can still be managed. Automatic workflow guidance may still come from session
  hooks; only when both surfaces are off are you responsible for telling the
  agent when to use the lifecycle skills.

Fresh initialization starts from `manual` and asks before editing instruction
files. If enabled session hooks cover the selected agents, remaining on `manual`
keeps the repository invisible without sacrificing automatic guidance. If hooks
do not cover the install set, interactive initialization recommends a managed
instruction block where the agent supports one.

`orcaops init --no-agents-md` persists `bootstrap: "manual"`.

## Generated files

`generated_files` controls whether generated support files are committed:

- `commit` is the default. Generated trees stay in git, so teammates get them on
  pull.
- `ignore` adds adapter-derived `.gitignore` entries for generated trees. Each
  developer materializes support files locally, and bare `orcaops` nudges a fresh
  clone when files are missing.

Global installs are always per-user local materialization; this setting only
applies to project-scope generated files.

## Workflow hints

`workflow.hints` renders workflow preferences inside the managed Orcaops block:

```json
{
  "workflow": {
    "hints": {
      "keys": ["commit-on-checkpoint-close", "checkpoint-cadence"],
      "custom": ["Run pnpm -r test before summary."]
    }
  }
}
```

Curated keys render vetted text in a stable order. Current keys are:

- `commit-on-checkpoint-close`
- `open-checkpoint-before-edits`
- `capture-on-nontrivial`
- `subagent-parallelism`
- `checkpoint-cadence`

Custom hints render verbatim after curated hints. When hints are present, the
managed block includes a section like:

```md
### Workflow Preferences

- Open the checkpoint, make changes, run formatters and tests, commit (including hook rewrites), then close.
- Use one checkpoint per coherent unit of work.
- Run pnpm -r test before summary.
```

## Install manifest

Orcaops tracks what it owns separately from what it wants.

`.orcaops/install.json` is committed. It records project-scope ownership:

- install agents;
- naming prefix;
- managed paths or patterns;
- ownership kind, such as generated file, injected block, or `.gitignore` entry.

It does not store per-file hashes or CLI materialization versions, so it does not
churn on every CLI release.

`.orcaops/install.local.json` is git-excluded. It records per-machine
safe-mutation state:

- expected hashes for managed generated files or managed block regions;
- provenance (`created`, `adopted`, or `pre-existing`);
- the `info/exclude` lines Orcaops manages on this checkout (`info_exclude` —
  the personal-scope hiding mechanism; per-checkout git-dir state, so it never
  belongs in the committed manifest);
- delete guard (`hash`, `confirm`, or `never`);
- local symlink/copy materialization details.

`update`, `prune`, and `uninstall` use these guards to preserve user-edited or
unverifiable files. If the local manifest is missing on a fresh clone, Orcaops
reconstructs it from the committed manifest and the files on disk.
