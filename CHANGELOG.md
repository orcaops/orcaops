# Changelog

Notable changes to the Orcaops CLI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html). Below 1.0.0, minor releases
may change behaviour. Anything needing action on upgrade is called out.

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
