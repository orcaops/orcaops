# Changelog

Notable changes to the Orcaops CLI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html). Below 1.0.0, minor releases
may change behaviour. Anything needing action on upgrade is called out.

## [0.2.2] - 2026-09-18

This patch release contains breaking changes: `^0.2.1` and `~0.2.1` both pick
them up without asking.

### Breaking changes

- Newly authored plan steps must declare at least one acceptance criterion.
  `capture plan` and `capture plan revise` reject a step with none, and reject a
  revision that would strip the last criterion off a step that has one — even
  with `acknowledge_criteria_changes`. The error code is
  `PLAN_ACCEPTANCE_CRITERIA_REQUIRED` (path `plan_steps`) and its message prints
  the nested YAML shape to add. Replacing a step's criteria in one revision is
  still allowed where no checkpoint protects the step.

  Existing stored artifacts remain valid. A step retained with no criteria
  carries forward as-is, so long as its text is byte-identical; label-only edits
  stay allowed, and rewriting its text makes it newly authored work that needs a
  rubric. Git imports are unaffected and continue to record absent criteria
  without manufacturing acceptance claims.

  **On upgrade:** a new CLI alongside installed skills generated before this
  release will produce plans this contract rejects, because those instructions
  still describe `acceptance_criteria` as optional. The rejection message names
  the affected step, prints the required shape, and points at `orcaops update`
  to regenerate the instructions. The message never claims your install is
  stale — malformed input alone does not establish that; `orcaops doctor`
  remains the check that does.

- `plan review comment --reply-to` no longer accepts a plan slug. It takes the
  canonical id that `plan review pull` echoed, like the other write verbs, and
  there is no flag to opt out. Replies previously accepted a slug.

### Added

- Rubric coverage is reported wherever a plan is surfaced: `capture plan`,
  `capture plan revise`, `checkpoint close`, `resume` (data, rendered output and
  the paste-ready prompt) and the digest used by `finish`. Each count carries
  the plan revision it measured. Revision responses — including a replay of an
  older revision — report the revision they return, and a checkpoint close
  reports only the steps it claimed, measured against the revision it opened
  against.

### Changed

- The digest reports acceptance-criteria coverage unconditionally. It previously
  stayed silent when every step lacked criteria unless the opt-in `step-coverage`
  evaluator had run, and described absent criteria as something delivery-coverage
  "does not grade". Counts now describe what the plan records, and no surface
  presents an omission as an approved exemption. Rubric presence is not evidence
  of delivery, and is reported separately from it.
- `orcaops doctor` is much faster on a repository with a lot of history. On one
  with 166 captured artifacts and 113 branches it went from about 17 seconds to
  about 2, by inspecting lineage in a fixed number of Git calls instead of one
  per artifact and branch pair. What it reports is unchanged.

### Fixed

- `orcaops doctor` and `orcaops session-hooks status` no longer report a
  repository as covered when the session hook it requires is missing,
  malformed, disabled, superseded, or cannot be read. A shared settings file
  could lose the registration and both checks kept reporting coverage. Each now
  names the repair that matches the failure. Both remain read-only: installing a
  hook still takes `orcaops session-hooks install`, with its consent prompt
  unchanged.
- `plan review comment`, `push` and `propose` check your plan reference before
  they send anything. Given a slug rather than the canonical id, `push` and
  `propose` with `--base-version-id` used to publish to the cloud and only then
  fail locally, leaving a change published with nothing recorded for it. That is
  refused up front now, and if it ever happens the CLI says so in plain text
  rather than only in `--json`. Without that flag the old failure was harmless
  but told you to re-run the `plan review pull` that had just succeeded. The
  refusal prints the id to use. `plan review pull` and the other read commands
  still take a slug, because they resolve it against the cloud.
- A fresh agent session finds the mapping from what you type to the skill that
  handles it, even where the repository has no managed instruction block.
  Repositories created by a non-interactive `orcaops init` had none by default,
  so asking a session to critique a plan draft never reached the skill named for
  exactly that. Upgrading is enough: the guidance is produced by the CLI each
  session rather than written into your settings.
- `orcaops doctor` reports the lineage it could check when one branch tip cannot
  be read, instead of discarding the whole result.

## [0.2.1] - 2026-09-11

### Breaking changes

- Logged-out `push-status --json` returns `pending: null`, with
  `state: "unavailable"`, `reason: "not_connected"` and exit code 0. Handle the
  null before reading `pending.length`.
- Logged-out `status --json` reports cloud sync as unavailable, with null counts
  and `reason: "not_connected"`.

### Added

- `init --json` marks a registration-only run with `registration_only: true`,
  alongside `repo_root`, `project_id`, `project_id_minted: false`, `dry_run` and
  `warnings`. Branch on that flag before reading installer fields such as
  `created`, `config_path` and `git_hooks`, which the run does not produce.

### Fixed

- Snapshot capture accepts Git maintenance packs and other same-stem pack/index pairs
  without requiring a filename prefix or hash. Doctor reports unpaired pack/index files
  with recovery guidance and surfaces pack-directory inspection failures.
- Credential-store lookup failures no longer break local status or push-status;
  unknown authentication state preserves backlog reporting without a network probe.
- Doctor explains which checks wait for worktree registration, and init refusals
  identify the registration-only remedy when installation flags were supplied.
- Personal-scope legacy conversion retains the shared ownership manifest and
  evaluator registration. Conversion refusals identify unresolved source paths
  and issues. Already-converted installations, including those that used a
  move-aside workaround, need no reconversion.
- Update reports global skill changes, repairs, and reference changes accurately,
  while preserving the up-to-date confirmation for genuine no-ops.
- New linked worktrees register automatically for execution against existing
  history. Ordinary init and `doctor --fix` can register a missing worktree
  binding without forced reinitialization. Artifact ownership still requires
  explicit handoff; orphan-recovery diagnostics identify blocked worktrees.
- Status and push-status omit cloud backlog details when local authentication is
  `not_connected`. Expired credentials retain backlog visibility without a
  network check. Connected output and retained sync records are unchanged.

## [0.2.0] - 2026-09-10

Five things to check on upgrade: move to Node 22.14.0 or newer, uninstall
`@orcaops/watch`, convert your existing local history, move any
`orcaops why --json` consumer to schema 4, and use WSL2 on Windows if you open
the Task Review UI.

### Breaking changes

- Node 22.14.0 or newer is required. Older versions are refused at startup.
- The separate `@orcaops/watch` package is retired and gets no further
  releases. Uninstall it:

  ```
  npm uninstall -g @orcaops/watch
  ```

  `orcaops watch`, the terminal UI for reviewing a branch, now ships with the
  CLI as a prebuilt binary for your platform and no longer needs Bun.

- That prebuilt UI covers macOS and Linux on x64 and arm64. On Windows it runs
  under WSL2. The rest of the CLI is unaffected, and anywhere without a build
  `orcaops watch` lists the platforms it supports and exits.
- Captured history is one SQLite database per project, shared by that
  repository's worktrees. Convert existing history from its original repository
  before you run other commands:

  ```
  orcaops history convert
  orcaops history convert --apply --offline
  ```

  The preview writes nothing. Apply prints an operation ID; if it is
  interrupted, retry from the same checkout with `--operation-id <id>`. Task
  Review history from earlier versions is not carried over.

- The home-dir archive mirror is removed, with the `orcaops archive` command
  and the `archive.enabled` and `archive.redact_secrets` settings. Keep your
  own backup of the project database if you want a second copy of captured
  history.
- `orcaops why --json` returns schema 4. Candidates are compact; add
  `--details` for the full candidate bodies. Human output is unchanged.
- Regenerate any enrichment bundles produced by `0.2.0-rc.1` before applying
  them with this release.

### Added

- `orcaops history convert` imports a repository's pre-database history into
  its project database.
- `orcaops rebuild` rebuilds derived query and search metadata from retained
  database rows.
- `orcaops gc` reports retained Git publications. `--apply` reclaims refs
  already recorded as retired and unreferenced.
- `orcaops snapshots prune` previews retired snapshot publications and reclaims
  them with `--apply`.
- `orcaops status`, `list`, `decisions`, `loose-ends` and `stats` take
  `--scope worktree|project|all-projects`, and `--project <id>` reads one
  project by its UUID.
- `ORCAOPS_DATA_DIR` selects the history data root, ahead of `XDG_DATA_HOME`
  and `~/.orcaops`.
- `orcaops doctor` names the Task Review build it found, or tells you your
  platform has none.
- Imported decisions now carry structured evidence linking each decision to its
  supporting commit and exact commit-message quote.
- `orcaops seed enrich` can add evidence-bound detail to an existing imported
  artifact without deleting or re-importing it.

### Changed

- Installing is one command, with no native build step:

  ```
  npm i -g @orcaops/cli
  ```

- `orcaops init` registers Codex hooks in `hooks.json`. An existing orcaops
  block in your Codex `config.toml` moves there for you and keeps the approval
  Codex already holds, so you are not asked to approve the hook again.
- `orcaops watch` opens project history through a read-only connection. It does
  not migrate a database or rebuild indexes.
- Deleting a worktree leaves its project database in place.
- Pointing `ORCAOPS_DATA_DIR` somewhere else does not move a registered
  project. Orcaops reports the mismatch, and `orcaops doctor` names the action
  to take.
- Seed previews disclose checked-out commits omitted from the selected history,
  the evidence available for proposed decisions, and the enrichment scope
  before you approve an import.

### Fixed

- Installing under an npm version that blocks install scripts leaves a working
  CLI. Previously the install reported success and every command that opened
  the capture store then failed.
- Two orcaops commands running at once no longer fail while the search index
  is being updated.
- Two commands that both create a project database at once settle on one of
  them instead of failing.
- When the capture store cannot be opened, the error shows the command that
  fixes it; previously the message was cut off before it.
- `orcaops watch` shuts down cleanly when it is closed before its first
  snapshot is ready.
- `orcaops watch` labels repositories by identity, so worktrees of the same
  repository read correctly and an issue is counted once.
- Projects keep their readable names in listings.
- Enriched imports retain their labels, summaries, outcomes, and decisions
  after cache and archive rebuilds.
- Commit-message metadata no longer becomes an imported artifact's label.
- Invalid enrichment files are rejected before import instead of silently
  producing skeleton artifacts.
- Renaming a locally captured plan after its first cloud sync no longer leaves
  later syncs permanently stale.

## [0.1.1] - 2026-09-03

No action needed on upgrade.

### Changed

- Personal scope now covers every worktree of a repository. Its config lives
  in the git common directory, so `orcaops init --personal` in one worktree
  enables the others, including worktrees created later.
- Personal scope writes nothing to the working tree: no `AGENTS.md` or
  `CLAUDE.md` block, no repository settings, and the capture store is hidden
  through `.git/info/exclude`. The CLI refuses writes outside that boundary.
- Codex hook setup previews the exact edit and defaults to managed. When a
  hook cannot be installed, the CLI names the step that failed.
- `orcaops doctor` reports a malformed agent config instead of skipping it.
- `orcaops watch` shows captures from a store that was created empty, without
  needing a restart.

### Fixed

- A blocked native-module install script now explains itself instead of
  failing with a bindings error. On npm versions that block install scripts:

  ```
  npm install -g --allow-scripts=better-sqlite3 @orcaops/cli
  ```

- The npm page renders the README and this changelog.

### Security

- `fast-uri` 4.1.2 to 4.1.3, clearing four high-severity advisories: host
  confusion ([GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8),
  [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp))
  and server-side request forgery
  ([GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc),
  [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf)).
  It reaches the CLI through the evaluator runner's schema validator.

## [0.1.0] - 2026-09-02

First public release.

### Added

- Captures a coding agent's plan, checkpoints, decisions, uncertainty, and
  summary into a local versioned record beside your code.
- Evaluators run at each lifecycle boundary and can warn or block. Packs are
  configurable per repository; write your own against `@orcaops/evaluator-sdk`.
- `orcaops digest` renders a captured thread as a PR summary.
- `orcaops why` traces a line or symbol to the checkpoint that produced it.
  `search`, `timetravel`, and `recap` cover full-text search, checkpoint
  replay, and work summaries.
- `orcaops init` detects coding agents in a repository and installs matching
  skills for Claude Code, Codex, Cursor, OpenCode, GitHub Copilot, and
  AiderDesk.
- Task Review terminal UI, published separately as `@orcaops/watch` and
  launched with `orcaops watch`.
- Optional cloud sync. The CLI is fully functional without it.

### Security

- Captured content is scanned for credential shapes before it is written or
  synced, and evaluator output is scrubbed on the way out.
- Published with build provenance.

[0.1.1]: https://github.com/orcaops/orcaops/releases/tag/v0.1.1
[0.1.0]: https://github.com/orcaops/orcaops/releases/tag/v0.1.0
