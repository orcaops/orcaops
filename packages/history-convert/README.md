# Frozen legacy conversion

This removable private package converts in-scope file history using the
`0.2.0-rc.2` replay profile at `9cb6e606cebed31a3e22bb928119c04cb041bfc3` into the
canonical project database. Its private schemas, replay code and fixtures preserve
original source bytes and identities. Canonical runtime packages must not import
these decoders. Missing producer or account evidence stays unknown.

## Accepted mixed-era sources

The supported local source boundary includes exact operational SQLite schemas
20, 22, 23, 24 and 25, plus configuration version 4 and every version from 5
onward — a repository whose config a newer orcaops rewrote still converts,
because the three fields read here have been stable since the freeze. This extends the
original rc.2-only conversion boundary; it does not restore the removed canonical
SQLite development migrations. Unknown versions and altered SQLite schemas refuse.
The destination records the actual source version, never relabels it as 25.
The copied rc.2 replay code remains unchanged. Older configuration normalization
only locates source history; original config bytes are never rewritten.

Schema-only fixtures and synthetic rows cover these accepted operational formats.
They contain no user history. Missing producer evidence remains unknown even when
its schema is recognized.

Structurally valid fingerprints that disagree with checkpoint identities, snapshot
boundaries or recorded summaries are retained byte-for-byte with a disclosure.
Readers validate identities, hashes and summaries before using fingerprints as
evidence. Attributed evidence must match the physical snapshot boundaries or the exact
earlier baseline recorded for empty-window recovery. Explicit inspection can show
the retained fingerprint window. Missing required manifests and structurally invalid manifests still refuse.
The public preview exposes attachment disclosures separately from completeness:
complete means all required source content is classified, not that every retained
attachment is trustworthy. Registration retries do not re-derive the original
attachment disclosures and explicitly report that limitation.

`artifacts.zip` at the legacy installation root is an opaque backup, not another
artifact authority. `.DS_Store` is opaque filesystem metadata. Both remain
hash-bound during preparation and untouched at their original locations; neither
is interpreted or imported as canonical history. Keep the original backup if its
contents are needed. Unknown filenames still require classification.

## Command

Run from the legacy repository, using the CLI release containing this converter:

```sh
orcaops history convert --json
orcaops history convert --apply --offline --operation-id <uuid> --json
```

The first command previews identities, counts, hashes, target presence, disclosed
omissions and classification issues. It does not initialize history or change
application records. SQLite source images are decoded from verified copies;
original database paths are never opened.

Before applying, stop old and new capture, review, sync and seed writers in every
selected worktree. Keep this offline window through conversion and registration.
`--offline` confirms that condition; it does not stop other processes for you.
Apply without it refuses. Preview accepts neither `--offline` nor `--operation-id`.

Choose and retain one operation UUID before applying. Retrying the second command
with the same UUID resumes that conversion. Apply imports the verified source,
compares retained content against independently decoded originals, and publishes
create-once registration only after the comparison succeeds. It preserves source
files and Git refs. A retry after committed import can finish registration without
repeating the comparison; the response discloses that case.

An interruption can leave an unregistered target database. Retry under the original
operation ID; do not remove the target or initialize a replacement. A conflicting
identity refuses with `IDENTITY_CONFLICT` or `IDEMPOTENCY_CONFLICT`. An incomplete
source classification or absent offline confirmation refuses with `INVALID_INPUT`.
A failed source/target comparison reports `HISTORY_INTEGRITY_REQUIRED` and does not
register the target. Resolve the reported source or authority problem before retrying;
conversion is not a general repair command.

## Preserved and excluded history

Captured artifact events, plans, checkpoints, summaries, verification, usage,
Source Plan approval history and other supported operational records remain in
scope. Raw/redacted choices retain the selected original representation; historical
import does not authorize bypassing secret refusal on new authored input.

Legacy Task Review history is excluded: runs, synthesis, Story, floor, inputs,
attempts, anchors, comments, workflow, mirrors, feedback and cursors. Discovery
skips the fixed review locations without decoding their payloads and reports the
omissions. Malformed review-only data does not block otherwise valid conversion.
Shared stores still require validation for their in-scope records. No excluded
source file or Git ref is deleted.

## Fixtures and retirement

`fixtures/legacy-0.2.0-rc.2/fixture.json` contains synthetic history produced by the
pinned legacy release, with producer identity, repository bundle and member hashes.
Tests materialize that fixture without a sibling checkout or live user history.
`fixtures/sources.json` records the copied source closure. The converter's tests
validate the frozen profile, source preservation, omissions, apply and retry paths.
Normal fresh database initialization does not certify conversion completeness.

The converter is scheduled for introduction in `0.3.0` and removal in `0.4.0`.
At removal, document one command using an exact published converter-containing
release and verify it against the frozen legacy fixture. Keep that runnable upgrade
instruction, not tarballs or a permanent legacy reader. The future release pin and
its sunset verification must be recorded when that release exists.

After switching from a build containing removed decoders, clear only this package's
generated `dist` output before rebuilding: TypeScript does not remove stale outputs.
