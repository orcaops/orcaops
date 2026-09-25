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
| `<root>/projects/<project-id>/knowledge-worker.log`           | Background knowledge worker log, rotated at 1 MiB, one previous file kept.              |
| `<root>/projects/catalog/<project-id>.json`                   | Create-once project catalog entry.                                                      |
| `$(git rev-parse --git-common-dir)/orcaops/registration.json` | Create-once registration naming the data root, project and expected database instance.  |
| `$(git rev-parse --git-dir)/orcaops/worktree.json`            | Create-once worktree identity.                                                          |

When an evaluator states structured findings, they are retained beside the run they belong to, in
the same transaction that records the run: the findings themselves, a record saying that findings
were offered and could not be read when that is what happened, and what the run was given — the
digest of the context it was handed, the base and head commits it saw, and the evaluator it
resolved to. Retained findings never change a verdict or a gate, and evaluator history recorded
before this release keeps exactly the content it has: nothing is migrated, reinterpreted or re-run,
and no finding identities are invented for it. A command prints no finding text; with `--json` a
pass that established findings reports how many were retained.

Watch and passive commands open only existing, validated databases through
read-only connections. SQLite may manage its own WAL/SHM files, but viewing does
not initialize history, migrate it, repair application records or rebuild indexes.
A missing registered database is an error, never permission to create an empty one.

`show`, `resume`, `digest`, `why` and Watch's detail pane also read the
continuing records — requirements, decisions, their adoptions and corrections,
and the task uses a plan recorded — out of the same project database, in the
same read the thread itself is taken in. Those reads resolve no provider, call
no model, start no background worker and write nothing, including no processing
job: they report what stands and say plainly that they claim no completeness
about what background processing has interpreted.

Deleting a worktree does not delete its project database. Git-backed snapshot
objects remain in the repository's Git storage, so retaining the database alone
does not preserve those objects if the repository itself is deleted. Moving a
registered data root or copying repository metadata is not an implicit new install;
Orcaops validates the recorded identities and reports mismatches.

## Upgrading a project database

Upgrading is never automatic. A newer Orcaops opening a database an older release
wrote refuses it, says an explicit upgrade is required, and names the command; it
migrates nothing, takes no backup and writes nothing. `orcaops doctor`, `orcaops
status`, search and session hooks behave the same way.

`orcaops history upgrade` previews. It reports the database's state, the schema
version it holds and the one this build writes, the tables that would be rebuilt
with their row counts, where the backup would be written, and every Git ref and
evidence file the database names that could not be found. It changes nothing.

`orcaops history upgrade --apply` performs it. It first copies the database,
fsyncs the copy, reopens it read-only and verifies its integrity, version, store
identity and per-table content against the source, and writes a manifest of what
the database names outside itself. Only then does it make the whole transition in
one transaction, so an interruption leaves either the original database or the
complete upgraded one. Running it again on an upgraded database reports that
nothing is required and takes no second backup.

A verified backup is one directory beside the database:

| Path                                                                                        | Purpose                                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `<root>/projects/<project-id>/upgrade-backups/schema-<version>-<id>/`                       | One verified backup. A directory appears only after it has been verified. |
| `<root>/projects/<project-id>/upgrade-backups/schema-<version>-<id>/history-backup.sqlite3` | The database as one self-contained file.                                  |
| `<root>/projects/<project-id>/upgrade-backups/schema-<version>-<id>/manifest.json`          | What the copy must hold, and the Git refs and evidence files it names.    |

`orcaops history backups` lists them with the date, the schema version and the
counters each one was taken at. Nothing in Orcaops removes a published backup.

`orcaops history restore <backup>` previews replacing the database with one of
them, and `--apply` performs it after verifying the copy against its manifest
again. **Work written after that backup was taken is not in it and is not
restored.** The database that was in place is not deleted: it is kept whole beside
the restored one, and the apply prints its exact name. A restore holds the database
for itself while it exchanges the file, so it refuses while any other orcaops session
has the database open: close them and run it again.

An older Orcaops refuses a database a newer one upgraded, and there is no
downgrade. To go back to the older release, restore the backup its upgrade took
and keep using that release against the restored database.

## Repository configuration and working files

The ignored `.orcaops/` directory holds worktree files such as generated caches
and seed-authoring workspaces. In project scope it also holds configuration,
evaluator registrations and the installation manifest. It is not the canonical
artifact, review or usage store.

Personal scope keeps shared configuration, evaluator registrations and its
ownership manifest under `$(git rev-parse --git-common-dir)/orcaops/`. Installation
scope controls generated integration files; it does not create a separate history
store for each worktree.

Observations and assessments live in the project database beside the captures,
whether `orcaops knowledge observe` and `orcaops knowledge assess` wrote them or
an evaluator run did. They are insert-only, like every other record there: a
later observation or assessment is a further record, and nothing rewrites an
earlier one. They need no provider, no consent grant and no model, and they are
never sent anywhere by recording them.

Reconsideration items live there too, one per affected item and cause, with the
cause, the path the traversal found and the owner where a record names one.
`orcaops knowledge reconsider open` is the only thing that writes one. What
somebody decided about an item is a separate insert-only record beside it, with
who decided and when, so the facts an item was opened on are never rewritten by
what became of it. An item is not a defect and carries no assignment.

Assignments live there too: who may decide what on somebody else's behalf, the
obligations the assignment inherits, the footprint it delegates, the allowed
changes and escalation conditions in the assigner's own words, who is
responsible and when it ends. `orcaops knowledge assignment open` is the only
thing that writes one. Ending one is a revocation recorded beside it, so the
assignment and everything published under it stay readable: a revocation refuses
every later act and rewrites nothing. The responsible identity a record carries
is the one an act must claim; nothing local authenticates it.

Consent to background knowledge processing is recorded outside the repository,
in `knowledge-processing-grants.json` under the config home (`ORCAOPS_CONFIG_HOME`,
otherwise `$XDG_CONFIG_HOME/orcaops`, otherwise `~/.config/orcaops`). Each entry names
the project, the provider, the processor contract, the source scope it covers and the
limits you were shown when you granted it, and nothing in the repository can create one.
`orcaops knowledge revoke` records a revocation on the entry and keeps it, so what was
once authorized stays inspectable. Nothing in that file is sent to Cloud.

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

## What Orcaops enforces, and what it only observes

Every authority and consent check this documentation names, with one sentence saying which it is.
Three sentence shapes, and no fourth:

- **Orcaops enforces X at &lt;boundary&gt;** — reaching that boundary without X refuses. Nothing is
  written and the command exits non-zero.
- **Orcaops observes X** — it is read, recorded and shown. It stops nothing.
- **Orcaops receives X as the agent's assertion** — the caller told Orcaops, and nothing local can
  check it.

This is not a promise to control what an agent does outside these boundaries. Orcaops does not
control agent conduct in general, all historical intent, every dependency, or spending on other
machines.

| Check                                                               | Statement                                                                                                                                                         | Where                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| An assignment delegates no more than its assigner holds             | Orcaops enforces it at the transaction that opens the assignment.                                                                                                 | `publishProjectAssignment` in `packages/storage/src/history/database/knowledge-assignments.ts` |
| An act is covered by the authority it cites                         | Orcaops enforces it at the transaction that publishes the adoption, exception or relationship.                                                                    | `requireAuthority` in `packages/storage/src/history/database/knowledge-authority.ts`           |
| A correction is covered by the authority it cites                   | Orcaops enforces it at the transaction that appends the correction.                                                                                               | `checkCorrection` in `packages/storage/src/schema/knowledge-contract.ts`                       |
| An act rests on authority that still stands when work is integrated | Orcaops enforces it at the pre-PR boundary and again in the transaction publishing a pre-PR result or new summary, including direct `orcaops capture summary`.    | `assertIntegrationPublication` in `apps/orcaops-cli/src/lib/integration-authority-gate.ts`     |
| Background processing has a consent grant covering the job          | Orcaops enforces it at dispatch, before a provider process is started.                                                                                            | `evaluateProcessingConsent` in `apps/orcaops-cli/src/lib/knowledge-processing-consent.ts`      |
| An evaluator pack has a grant covering its engine capabilities      | Orcaops enforces it before evaluator dispatch; a refused block-severity evaluator halts the lifecycle boundary, while warn and info refusals remain advisory.     | `evaluateConsentGate` in `packages/evaluator-runner/src/trust-capability.ts`                   |
| A per-call spend cap the provider can hold as a ceiling             | Orcaops enforces it at the call, refusing a cap no provider capability supports.                                                                                  | `resolveNoToolCall` in `packages/llm/src/provider-capabilities.ts`                             |
| The daily spend budget and the hourly call allowance                | Orcaops enforces them at the call, reserving each call's ceiling before it is sent.                                                                               | `decideProcessingCall` in `packages/storage/src/history/database/processing-usage.ts`          |
| The response size one processing call may return                    | Orcaops enforces it at the call, failing an oversized answer rather than truncating it.                                                                           | `runPreparedInputCall` in `packages/llm/src/prepared-input-call.ts`                            |
| The transport ceiling on the evidence one review carries            | Orcaops enforces it when the review payload is built, refusing rather than cutting the captured account down.                                                     | `buildDossier` in `packages/review-engine/src/dossier.ts`                                      |
| The identity an act claims                                          | Orcaops enforces that an act under an assignment claims the responsible identity, and observes the identity itself: a local invocation carries no authentication. | `checkAuthorization` in `packages/storage/src/schema/knowledge-contract.ts`                    |
| The escalation conditions an assignment records                     | Orcaops observes them. They are the assigner's words for people, shown and never parsed.                                                                          | `knowledgeAssignmentEntry` in `apps/orcaops-cli/src/lib/knowledge-assignment-view.ts`          |
| The tokens and cost a provider reports                              | Orcaops observes them. They are recorded as reported and nothing verifies them.                                                                                   | `settleProcessingCall` in `packages/storage/src/history/database/processing-usage.ts`          |
| Which agent invoked a command                                       | Orcaops receives it as the agent's assertion; `--invoked-by-agent` is checked for spelling and never for identity.                                                | `resolveInvokingAgent` in `apps/orcaops-cli/src/lib/invoking-agent.ts`                         |

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
