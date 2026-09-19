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
  repository-invisible and repository-wide: the configuration, the evaluator
  registration, and the ownership manifest live in the git common directory
  (`$(git rev-parse --git-common-dir)/orcaops/`), so one `orcaops init --personal`
  in any worktree enables every existing and future worktree of the same
  repository; skills materialize into the global skill location used by each
  selected agent (tracked in `~/.orcaops/install.local.json`); and each
  worktree's `.orcaops/` working directory is hidden via the common dir's `info/exclude`.
  Personal scope writes no instruction file and no repository settings entries —
  guidance comes from global skills and, with consent, machine-level session
  hooks. `git status` stays clean, diffs stay empty, and teammates see nothing.
  Orcaops never edits a tracked file under personal scope (enforced at runtime:
  every planned installation write must land in the common dir's `orcaops/` files or
  `info/exclude`, git's hooks dir, or this worktree's `.orcaops/` working directory, never
  in a sibling worktree or on a tracked path).
- `project` keeps generated skills and commands in the repo — the
  [team adoption](./team-adoption.md) mode. Switch with
  `orcaops update --scope project`, then commit
  the files it materializes (config, `install.json`, skill trees,
  `.gitignore` lines); the info/exclude section is stripped on the way out so
  a plain `git add` works.
- `global` uses the selected agents' global skill locations like personal, but
  keeps the committed project manifest and instruction block.

Notes on `personal`:

- Every supported agent gets skills. Automatic guidance comes from machine
  session hooks; declining them leaves the agents with global skills and the
  CLI, and `orcaops session-hooks install` adds the reminder later.
- Captured artifacts, reviews and usage share the project's canonical database
  across worktrees. Worktree identity and focus remain separate. A passive read
  never initializes a missing store; a registered project whose database is
  missing reports missing history. Worktree caches and authoring files remain
  local. See [Local data](./local-data.md).
- A project config checked out in a worktree wins over the shared personal
  config for that worktree; switching branches changes the effective source
  without changing install ownership.
- When a worktree returns from project to personal scope, Orcaops adopts an
  existing shared personal config and applies only the flags supplied by that
  command. It refuses the transition if the shared config is invalid or does
  not declare personal scope.
- Slash commands require project scope: no supported agent declares a global
  command root, so `/orcaops:*` commands do not materialize under personal or
  global scope.
- Repository registration records the project, data root and database instance
  in the Git common directory. Worktrees share that registration and have their
  own create-once identities. Copying `.git` copies these identities; it does
  not establish an independent project. Do not unset `orcaops.projectid` or
  remove registration files to force a fresh install. `orcaops doctor` reports
  mismatches; automatic re-keying and reset are not supported.

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
  `## Orcaops` instruction block in the supported repository instruction files
  (project and global scope). Personal scope owns no instruction file and always
  stores `manual`.
- `manual` means Orcaops does not mutate instruction files. Skills and commands
  can still be managed. Automatic workflow guidance may still come from session
  hooks; only when both surfaces are off are you responsible for telling the
  agent when to use the lifecycle skills.

Fresh initialization decides the mode from session-hook coverage. If enabled
session hooks cover every selected agent, `manual` keeps the repository
invisible without sacrificing automatic guidance. If they do not — session hooks
off, or an agent such as Codex with no registration on this machine — the
managed block is what carries the guidance, so initialization chooses `managed`.
Interactive initialization offers that answer and waits; unattended
initialization applies it, except in a repository whose `AGENTS.md` or
`CLAUDE.md` is someone else's — it exists and carries no orcaops block — which
keeps `manual` rather than have that file edited with nobody watching. A file
that already carries a block is orcaops's own, and stays managed.

Personal scope always stores `manual`; it owns no instruction file.

`orcaops init --no-agents-md` persists `bootstrap: "manual"`, and `--agents-md`
persists `managed`. Both override the coverage rule.

When neither surface carries skill routing for an installed agent, the
`session-hooks` check in `orcaops doctor` names that agent and the recovery
steps for your scope — adopting the block under project or global scope, or
enabling emission and registering the machine hook under personal scope.

## Generated files

`generated_files` controls whether generated support files are committed:

- `commit` is the default. Generated trees stay in git, so teammates get them on
  pull.
- `ignore` adds adapter-derived `.gitignore` entries for generated trees. Each
  developer materializes support files locally, and bare `orcaops` nudges a fresh
  clone when files are missing.

Global installs are always per-user local materialization; this setting only
applies to project-scope generated files.

## Workflow

`workflow` shapes what both bootstrap surfaces say — the managed block and the
session-hook payload render the same resolved content.

### Hints

`workflow.hints` declares workflow preferences:

```json
{
  "workflow": {
    "hints": {
      "keys": ["subagent-parallelism", "checkpoint-cadence"],
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

Three of them render no bullet of their own, because the lifecycle guidance
already states them: `open-checkpoint-before-edits` and `capture-on-nontrivial`
whenever their lifecycle step is present, and `commit-on-checkpoint-close`
always — it is a legacy alias for `workflow.commit_inside_window` below, and
the only key the interactive picker does not offer.

Custom hints render verbatim after curated hints. When hints are present, the
rendered preferences look like:

```md
### Workflow Preferences

- Dispatch independent subagents concurrently; do not serialize them.
- Use one checkpoint per coherent unit of work.
- Run pnpm -r test before summary.
```

The session hook injects all of this too, so a long `workflow.hints.custom`
costs context at every session start; the `session-hook-payload` check in
`orcaops doctor` warns once the rendered payload passes 6000 characters.
Custom lines render as one bullet each, so interior whitespace is collapsed.

### Commit guidance

`workflow.commit_inside_window` (default `true`) puts "run tests and commit
inside the window" in the checkpoint step of both surfaces. Set it to `false`
to drop the clause everywhere. Pinning `commit-on-checkpoint-close` while the
boolean is `false` is redundant, not invalid: the key asks for the guidance the
boolean turns off, the resolver drops the key, and the `workflow-hints` check in
`orcaops doctor` names the combination.

### Routing suppression

`workflow.routing.suppress` takes skill ids whose read-intent routing entry
should not render on either surface:

```json
{ "workflow": { "routing": { "suppress": ["seed", "estimate"] } } }
```

The skill stays enabled and invocable; only the phrasing-to-skill line is
dropped, and `orcaops doctor` does not treat its absence from the block as
drift.

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
- the `info/exclude` lines Orcaops manages (`info_exclude`). Under personal
  scope this record is the repository-wide `personal-manifest.json` in the git
  common dir — the single owner of the managed block, which is exactly
  `.orcaops/` — and fresh personal scope writes no worktree manifest at all;
- delete guard (`hash`, `confirm`, or `never`);
- local symlink/copy materialization details.

`update`, `prune`, and `uninstall` use these guards to preserve user-edited or
unverifiable files. If the local manifest is missing on a fresh clone, Orcaops
reconstructs it from the committed manifest and the files on disk.
