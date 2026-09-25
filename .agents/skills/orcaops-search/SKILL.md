---
name: "Orcaops: search captured artifacts"
description: "Search captured plans, checkpoints, and summaries. Use for \"have we worked on X before?\", \"find earlier work about X\", or \"what did we decide last time?\""
metadata:
  generatedBy: "orcaops@0.3.0"
  contentHash: "3969aac89182"
---

# When to use

Use captured-history search to find prior decisions, implementation and evidence
before suggesting an approach or investigating earlier work.

# Search scope

```bash
orcaops search "rate limit" --json
orcaops search redis --branch feat/x --type checkpoint --json
orcaops search redis --touching 'src/**' --limit 5 --json
orcaops search redis --scope worktree --json
orcaops search redis --scope all-projects --json
orcaops search redis --project <project-id> --origin captured --json
orcaops search redis --knowledge-bytes 8192 --json
```

The default searches the current project across branches. Branch names are literal;
`--touching` filters actual touched paths before the result limit. Use explicit project
or all-projects scope outside Git. All-projects search merges each project database's
ranked results; it does not read another project's local checkout.

# Read the result

Cite `project_id`, `artifact_id` and the exact `source_id`. Each hit includes
its source kind, match class, evidence time and snippet. An unknown evidence time
stays unknown. Matching totals are null when unavailable; returned totals describe
only the current page. If completeness is false, disclose the reported issues and
do not present the available matches as exhaustive.

For the next page, use the returned `page.next_offset` with `--offset`. Pages are
fresh queries; intervening captures may change their order. No cursor freezes history
across projects.

Open an exact hit with `orcaops:show <artifact-id> --project <project-id>`.
Use `orcaops-digest` for a reviewer-facing digest.

# What a hit says about standing

A match on wording the project has since rewritten is the failure mode this
section exists for. In `schema_version` 4, each hit carries
`results[].knowledge` — `null` when no continuing record cites the event, and
otherwise:

- `records[]`, one per record the hit's event cites, each with `group` (the
  record's key), the `revision_id` the hit's own wording belongs to, and
  `wording`: **`stands`**, **`superseded`**, **`withdrawn`** or
  **`unknown`** (the wording is not tied to a revision this read can name).
- `incomplete[]`, entries this page could not carry whole.

**Quote the wording that stands, not the wording that matched.** Join
`records[].group` to `knowledge.groups[].key`; the group's `governing`
revision ids pick out the revisions in `groups[].revisions[]` whose
`statement` holds now, and `corrections[]` says what acted on it. A
`withdrawn` record has nothing governing — say it was withdrawn rather than
repeating it. Search decides none of this: it reports the shared reader's
answer.

Several hits of one record share one group entry, so a carried copy cannot
crowd out an unrelated result.

# Budget, incomplete entries, and coverage

`knowledge.budget` is `{ bytes, spent, entries_omitted }`. The default is
`--limit` times 2048 bytes; `--knowledge-bytes <n>` sets it exactly. It is
spent on **whole** entries in hit order — an entry that does not fit is
reported on its hit under `incomplete` with the record and the reason, never
trimmed to a fragment, because part of a rule reads as guidance while leaving
out the act that stopped it. When `entries_omitted` is above zero, raise
`--knowledge-bytes` or narrow `--limit` before concluding anything about
those records.

`knowledge.coverage.processing` carries the same claim `orcaops doctor` and
`orcaops knowledge status` print:
`complete`, `partial`, `not_processed` or `unknown`. It is `null` when
this search read several projects at once or ran outside a checkout, because no
configuration read here governs them. **Never report that a project has no rule
about something on the strength of a search.** Search finds wording; only
`orcaops knowledge lookup --identity <kind>:<id> --json` answers what applies,
and only a `complete` claim supports saying nothing was found because nothing
exists. Records that exist are reported with their standing whatever the queue
says, so a claim short of `complete` is never a reason to stop.

Search reads existing databases without changing application history, rebuilding
indexes or initializing missing history. It is a passive read: it asks nothing,
writes nothing, resolves no model provider and starts no worker. If a project is
unavailable, preserve its existing data and follow the reported recovery action.
A missing expected database is never permission to create an empty replacement.
