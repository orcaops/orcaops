# Core history

This directory coordinates project history across SQLite, Git and cloud services.
It owns the order of those operations and the checks that connect their identities.
It does not define the database schema or the CLI's presentation.

## Package boundaries

| Location                                                                                       | Responsibility                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`storage/src/history/database`](../../../storage/src/history/database)                        | Authoritative project rows, schema validation, read transactions, write admission, operation receipts and retry rules. |
| This directory                                                                                 | Repository context, setup, capture preparation, Git retention, checkout and push orchestration.                        |
| [`core/src/cloud`](../cloud)                                                                   | Credentials, authenticated connections, cloud payload helpers and SDK transport adapters.                              |
| [`orcaops-cli/src`](../../../../apps/orcaops-cli/src)                                          | Command options, selection, confirmation, progress and output; composition of the core APIs.                           |
| [`project-scope/src`](../../../project-scope/src), [`watch-data/src`](../../../watch-data/src) | Scoped retrieval and Watch's Node data side.                                                                           |
| [`review-engine/src/database`](../../../review-engine/src/database)                            | Review workflow and publication over the same project database.                                                        |

SQLite is authoritative for mutable structured history. Git retains snapshot objects
under immutable publication refs. Registration markers identify an initialized store;
they do not provide a second representation of its history.

## Where to start

The `database-*-api.ts` files are small public export lists. Their package paths
are stable so callers can depend on a capability without importing its internals.
They do not add another execution layer.

| Capability                              | Public import from `@orcaops/core` | Implementation starting point                                                                                                                                    |
| --------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and setup inspection              | `history/database-setup`           | [`setup/setup.ts`](setup/setup.ts), [`setup/inspection.ts`](setup/inspection.ts)                                                                                 |
| Passive repository context              | `history/database-read`            | [`context/read.ts`](context/read.ts)                                                                                                                             |
| Plan capture and capture retention      | `history/database-capture`         | [`capture/plan.ts`](capture/plan.ts), [`capture/retention.ts`](capture/retention.ts)                                                                             |
| Snapshot preparation and Git retention  | `history/database-retention`       | [`retention/snapshot.ts`](retention/snapshot.ts), [`retention/publication.ts`](retention/publication.ts), [`retention/reclamation.ts`](retention/reclamation.ts) |
| Execution checkout                      | `history/database-checkout`        | [`checkout/execution.ts`](checkout/execution.ts)                                                                                                                 |
| Push, resync and completed-capture sync | `history/database-push`            | [`sync/artifact-sync.ts`](sync/artifact-sync.ts), [`sync/dispatch.ts`](sync/dispatch.ts)                                                                         |

Implementations are grouped into `setup/`, `context/`, `capture/`, `retention/`,
`checkout/` and `sync/`. `context/` holds repository identity and filesystem checks
shared by readers and writers. The other folders follow the capabilities above.
The `database-` prefix remains on the public entry points; implementation filenames
use their folder for context.

The remaining top-level modules provide registration-file handling, bootstrap presence
inspection and provenance resolution. [`search/`](search) contains query and hit handling.
Tests sit beside the code they exercise; child-process fixtures support tests that
must cross a real process boundary.

## Why preparation and publication are separate

A plan capture illustrates the boundary:

1. Refuse secrets in authored input and validate the repository and execution context.
2. Prepare event bytes and, when available, a baseline snapshot outside the database
   transaction. Snapshot preparation can write Git objects.
3. Admit the prepared capture and its retention operation in SQLite.
4. Publish the immutable Git retention ref outside the transaction.
5. Settle the retained publication and capture in SQLite after checking that the
   original operation still applies. A capture without a snapshot follows the direct
   database append path.

Git and SQLite cannot commit atomically together. Keeping preparation, external
publication and database settlement distinct makes interruptions explicit and lets
authorized retries use the original operation identity. A stale publisher cannot
become current; it can leave an unused immutable ref. Passive reads never resume
these operations.

The push path follows the same boundary: prepare calls from retained history, admit
them, send through an injected client outside the transaction, then record outcomes
and settle. Unknown delivery is not permission to resend. Authentication and automatic
capture-sync policy are handled by the cloud and CLI layers.

## Readers and writers

Start passive callers at `history/database-read` and the storage read APIs. They open
only existing, validated databases using read-only connections and short read
transactions. They do not initialize history, migrate schemas, repair application
state or rebuild indexes. SQLite may manage its own WAL/SHM runtime files.

[`context/execution.ts`](context/execution.ts) serves authorized execution paths, including
first-use worktree registration. It is not interchangeable with the passive context
reader. Similarly, snapshot preparation is a Git-writing operation even though it
does not modify the user's worktree or index.

Writers use the storage transaction runner for admission, cancellation-aware waiting
and classified retries. Git subprocesses, snapshot preparation, cloud sends and
rendering stay outside those transactions. These boundaries are more important than
reducing the number of files.

The ordinary context Git runner and the retention Git runner remain distinct.
Retention needs stricter environment isolation, replacement-object handling,
publication durability and process cleanup than repository inspection. Do not merge
them merely because both launch Git.

## Editing this code

Keep a helper beside the capability whose invariant it enforces. Share it when callers
actually need the same behavior; do not combine superficially similar read, setup or
retention paths. Keep public exports explicit and tests close to their implementations.

[TESTING.md](../../../../TESTING.md) describes qualification, including deferred Linux
checks. This README is a navigation guide, not a claim that every platform has passed
qualification.
