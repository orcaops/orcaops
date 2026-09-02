---
description: 'Understand what Orcaops stores locally, what authenticated Cloud sync receives, and how data is removed.'
---

# Local data

Orcaops is useful without an account. Capture, evaluator runs, search,
provenance, the archive, and `orcaops watch` all operate on local data. Network
access starts only when you authenticate for an optional Cloud workflow or when
another tool you configured—such as an LLM-backed evaluator—uses its own
provider.

## What is stored in the repository

The ignored `.orcaops/` directory is the hot store for the current checkout:

| Path                       | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `.orcaops/artifacts/`      | Append-only plan, checkpoint, evaluator, summary, and lineage events.    |
| `.orcaops/reviews/`        | Local Task Review runs, Stories, comments, and review state.             |
| `.orcaops/usage/`          | Coding-agent token-usage records, without prompt or completion text.     |
| `.orcaops/cache/`          | Rebuildable indexes and other disposable working caches.                 |
| `.orcaops/config.json`     | Project configuration; tracked only when you adopt project scope.        |
| `.orcaops/evaluators.yaml` | Evaluator registrations and enablement for project-scoped installations. |

Orcaops also creates local git refs in the repository:

| Ref namespace                                                      | Contents                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `refs/orcaops/snap/<artifact>/<n>/<phase>`                         | Checkpoint-boundary snapshots for open, close, and abandon events.            |
| `refs/orcaops/baseline/<artifact>`                                 | One plan-time baseline ref per artifact.                                      |
| `refs/orcaops/review/<slug>` and `refs/orcaops/review/<slug>-base` | Pinned Task Review floor and base trees, retained until the review is pruned. |
| `refs/notes/orcaops/agent-trace`                                   | Opt-in line-provenance notes written by `orcaops export agent-trace --notes`. |

Ordinary `git push` does not include these refs, and Orcaops does not push them
for you.

## The home-directory archive

The durable archive is enabled by default so captured history survives a deleted
worktree. Its root is `~/.orcaops/`, `$XDG_DATA_HOME/orcaops`, or the local
operator's `ORCAOPS_DATA_DIR` override. It stores append-only mirrors grouped by
repository identity plus disposable search indexes.

### Layout

Back up the archive root; everything marked disposable rebuilds from it.

| Path                                                                      | Class        | Contents                                                                                                                      |
| ------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `<root>/projects/<project-id>/artifacts/<artifact-id>/events.ndjson`      | precious     | Byte-identical mirror of the repository's event log, append-only with per-line checksums.                                     |
| `…/artifacts/<artifact-id>/sidecars/`                                     | precious     | Oversized event payloads.                                                                                                     |
| `…/reviews/v<version>/<slug>/{journal.ndjson,comments.ndjson}`            | precious     | Durable Task Review journal and comment logs, restored to local review state.                                                 |
| `<root>/projects/<project-id>/usage/`                                     | precious     | Mirror of the repository's usage ledger and its sidecars.                                                                     |
| `<root>/projects.json`                                                    | hints only   | Registry of project ids to display names and last-seen paths. Verified on access, never used as identity, self-heals if lost. |
| `…/artifacts/<artifact-id>/derived/`                                      | re-derivable | Cached fingerprint manifests.                                                                                                 |
| `$XDG_CACHE_HOME/orcaops/archive-index/` (fallback `<root>/index-cache/`) | disposable   | Per-project search indexes, marked with `CACHEDIR.TAG` so backup tools skip them.                                             |
| `$XDG_CACHE_HOME/orcaops/checkouts/` (fallback `<root>/checkouts-cache/`) | disposable   | Scratch worktrees from `orcaops snapshots checkout`, also marked with `CACHEDIR.TAG`.                                         |

The archive root and every project directory are created with mode `0700`.
`orcaops doctor` and `orcaops archive status` report when that has widened.

### Defaults and controls

Important defaults:

- captured history is kept until you explicitly prune it;
- archive trouble warns but does not block capture;
- archive bytes are not encrypted by Orcaops—protect the directory like the
  rest of your user account; and
- one archive can contain history from many repositories, including client
  work.

Inspect or change the posture with:

```bash
orcaops archive status
orcaops archive disable
orcaops archive repair
orcaops archive prune --project <project-id>  # preview only
```

Pruning requires an explicit apply step. Disabling the archive stops new
mirrors for that project; it does not erase existing history.

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
trees, the home-directory archive, or the raw usage ledger. It also protects the
artifact boundary with configurable secret scrubbing: recognizable credentials
in captured prose are refused before anything is written or synchronized, and
generated views redact other detected secret shapes. Teams can extend the
built-in credential-file exclusions with `capture.exclude` and manage reviewed
example values through exact `redact.allow` entries. See
[Secret protection and scrubbing](./data-configuration.md#secret-protection-and-scrubbing)
for the available controls.

## Deletion and recovery

Orcaops does not age out captured history automatically. The destructive paths
are explicit:

- `orcaops snapshots prune` removes selected local snapshot refs;
- `orcaops archive prune ... --apply` removes selected archive data;
- `orcaops gc` cleans reported stale pins and orphans; and
- `orcaops uninstall --purge-data` removes the repository's local capture data.

Caches are disposable and rebuildable; artifact event logs and archive mirrors
are the durable records. Preview prune and uninstall operations before applying
them.
