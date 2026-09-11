---
description: 'Understand what Orcaops stores locally, what authenticated Cloud sync receives, and how data is removed.'
---

# Local data

Orcaops is useful without an account. Capture, evaluator runs, search,
provenance and `orcaops watch` all operate on local data. Network
access starts only when you authenticate for an optional Cloud workflow or when
another tool you configured—such as an LLM-backed evaluator—uses its own
provider.

## Project history

Mutable structured history lives in one SQLite database per project, shared by
that repository's worktrees. It contains captured events, revisions, usage,
review comments and workflow history, Source Plan records, and current selections.
The database is authoritative; it is not a disposable search cache.

The data root is selected by the local operator: `ORCAOPS_DATA_DIR`, otherwise
`$XDG_DATA_HOME/orcaops`, otherwise `~/.orcaops`. Checked-in project settings
cannot redirect canonical history to another data root.

| Path                                                          | Purpose                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `<root>/projects/<project-id>/history.sqlite3`                | Authoritative project history.                                                          |
| `<root>/projects/<project-id>/history.sqlite3-wal` and `-shm` | SQLite-managed transaction and coordination files; do not delete them to clear a cache. |
| `<root>/projects/<project-id>/`                               | Also contains immutable retained evidence used by database records.                     |
| `<root>/projects/catalog/<project-id>.json`                   | Create-once project catalog entry.                                                      |
| `$(git rev-parse --git-common-dir)/orcaops/registration.json` | Create-once registration naming the data root, project and expected database instance.  |
| `$(git rev-parse --git-dir)/orcaops/worktree.json`            | Create-once worktree identity.                                                          |

Watch and passive commands open only existing, validated databases through
read-only connections. SQLite may manage its own WAL/SHM files, but viewing does
not initialize history, migrate it, repair application records or rebuild indexes.
A missing registered database is an error, never permission to create an empty one.

Deleting a worktree does not delete its project database. Git-backed snapshot
objects remain in the repository's Git storage, so retaining the database alone
does not preserve those objects if the repository itself is deleted. Moving a
registered data root or copying repository metadata is not an implicit new install;
Orcaops validates the recorded identities and reports mismatches.

## Repository configuration and working files

The ignored `.orcaops/` directory holds worktree files such as generated caches
and seed-authoring workspaces. In project scope it also holds configuration,
evaluator registrations and the installation manifest. It is not the canonical
artifact, review or usage store.

Personal scope keeps shared configuration, evaluator registrations and its
ownership manifest under `$(git rev-parse --git-common-dir)/orcaops/`. Installation
scope controls generated integration files; it does not create a separate history
store for each worktree.

Orcaops also retains immutable local Git refs:

| Ref namespace                                                                  | Contents                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `refs/orcaops/snap/<artifact>/<n>/<phase>-<publication>`                       | Checkpoint-boundary snapshots.                                     |
| `refs/orcaops/baseline/<artifact>-<publication>`                               | Published plan baselines.                                          |
| `refs/orcaops/review/<review>-<publication>` and the corresponding `-base` ref | Published review evidence.                                         |
| `refs/notes/orcaops/agent-trace`                                               | Opt-in provenance notes from `orcaops export agent-trace --notes`. |

Database records select the current publication; existing retention refs are not
moved to make another publication current. Ordinary `git push` does not include
these refs, and Orcaops does not push them for you.

There is no optional archive mirror or archive enable/disable setting. Inspect
history with `orcaops status` and `orcaops doctor`. Local history and immutable
evidence are not encrypted by Orcaops; protect the data root and Git storage like
other private files in your user account.

## What Cloud receives

**Logged out means no Cloud sync.** If you have not run `orcaops login` and have
not provided an official Cloud token, the CLI sends no repository, capture,
review, evaluator, file-path, hash, or usage data to Orcaops Cloud. `orcaops
init` does not create an account, log you in, or upload anything. Capture,
search, provenance, and `orcaops watch` continue to use local data only.

Cloud sync starts only after you explicitly authenticate with `orcaops login`
or provide an official Cloud token. Once authenticated, Cloud can receive:

- plan, checkpoint, decision, uncertainty, verification, summary, and approved
  plan prose;
- evaluator verdicts and bodies;
- branch names, commit SHAs, file paths, hunk hashes, and aggregate counts; and
- cumulative token totals without prompt or completion text.

Orcaops does **not** upload source file contents, raw diffs, checkpoint snapshot
trees, the project database, or the raw usage ledger. It also protects the
artifact boundary with configurable secret scrubbing: recognizable credentials
in captured prose are refused before anything is written or synchronized, and
generated views redact other detected secret shapes. Teams can extend the
built-in credential-file exclusions with `capture.exclude` and manage reviewed
example values through exact `redact.allow` entries. See
[Secret protection and scrubbing](./data-configuration.md#secret-protection-and-scrubbing)
for the available controls.

## Retention and recovery

Orcaops does not automatically age out captured history, and this version has no
command for deleting canonical project history or resetting it to an empty store.
Uninstall preserves canonical history, including when `--purge-data` removes
eligible worktree files. Archive commands, including archive prune, are removed.

`orcaops snapshots prune` and `orcaops gc` preview eligible retained Git-resource
reclamation. Applying it requires `--apply`; only positively retired publications
with no remaining database references can be reclaimed. Unknown ownership, missing
history and inaccessible state never authorize deletion.

`orcaops rebuild` rebuilds derived query and search metadata from retained database
rows. It cannot recreate a missing or corrupted authoritative database. Use
`orcaops doctor` to identify the affected resource and follow its specific recovery
guidance. Retry an interrupted operation with its original operation identity
where supported. Lost or corrupt retained content may require restoring a verified
backup; do not delete a database or registration marker to force initialization.
