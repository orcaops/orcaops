# Changelog

Notable changes to the Orcaops CLI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html). Below 1.0.0, minor releases
may change behaviour. Anything needing action on upgrade is called out.

## [0.2.0] - 2026-09-04

Four things to check on upgrade: move to Node 22.14.0 or newer, uninstall
`@orcaops/watch`, use WSL2 on Windows if you open the Task Review UI, and
regenerate any unapplied enrichment bundles produced by `0.2.0-rc.1`.

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
- Regenerate any enrichment bundles produced by `0.2.0-rc.1` before applying
  them with this release.

### Added

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
- Seed previews disclose checked-out commits omitted from the selected history,
  the evidence available for proposed decisions, and the enrichment scope
  before you approve an import.

### Fixed

- Installing under an npm version that blocks install scripts leaves a working
  CLI. Previously the install reported success and every command that opened
  the capture store then failed.
- Two orcaops commands running at once no longer fail while the search index
  is being updated.
- When the capture store cannot be opened, the error shows the command that
  fixes it; previously the message was cut off before it.
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
