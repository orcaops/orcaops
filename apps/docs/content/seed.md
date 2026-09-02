---
description: 'Preview and backfill existing git history so Orcaops search and provenance include work from before installation.'
---

# Import existing Git history

Orcaops normally captures reasoning while work happens. An established
repository starts with no captured artifacts, even though git already contains
useful authorship, change boundaries, commit messages, and file history. The
`orcaops-seed` skill can turn that existing evidence into a local, searchable
backfill without making you operate the import commands yourself.

## Ask your agent to prepare the backfill

Start with the outcome:

```text
Backfill this repository's existing git history into Orcaops.
```

The agent inspects any existing seed state, prepares a local preview, and
reports the selected branch, commits, proposed artifacts, authors, coverage,
and any truncation. Previewing does not create artifacts or contact a network.

You can narrow the request in ordinary language when you do not want the whole
default history selection:

```text
Preview a backfill of only my commits.
Preview the history since v2.0.0.
Backfill the history that touched packages/auth.
```

The skill chooses the corresponding author, date, ref, path, branch, or commit
selectors and keeps them consistent when the approved import is applied.

## Approve the exact import

The agent explains what the preview will create before asking for confirmation.
It does not treat a request to inspect coverage, diagnose missing history, or
preview an import as permission to write artifacts.

After you approve the exact selection, the agent can enrich the strongest
history clusters, then applies the import once and checks the final status.
Interrupted imports resume from their first incomplete write, and rerunning the
same selection reports covered clusters instead of duplicating them. If an
older, high-impact history pass remains, the agent explains that second pass
and asks for separate confirmation before applying it.

A preview from a small repository looks like this. The repository path is
normalized; the timestamps, cluster labels, and counts come from the actual
history selection.

<!-- cli-output:seed-preview:start -->

```text
Seed preview — main (main)
  2025-01-01T00:00:00Z  run  establish activity service  (1 commit)
  2025-01-02T11:00:00Z  run  paginate the activity feed + cover pagination boundaries  (2 commits)
Pending 2; covered 0; commits 3
Enrichment bundles: 2 in <repo>/.orcaops/cache/seed/pending
Run `orcaops seed --yes` to write these artifacts.
```

<!-- cli-output:seed-preview:end -->

The preview makes the write boundary explicit: nothing is imported until you
approve that selection.

## Synthesized is not captured

Seeded artifacts are honest reconstructions from git evidence, not a claim that
Orcaops observed the original work session. They are marked
`origin: git-import` and headline commands render `[imported]` or an explicit
“imported from git history (synthesized)” banner.

The importer can state structural facts: commits, authors, timestamps, changed
files, trees, and evidence-backed paraphrases of commit rationale. It does not
invent plan-time intent or in-the-moment knowledge. Acceptance criteria,
non-goals, uncertainty, verification, tests, open items, and deferred decisions
remain empty because git cannot establish them. Imported work is attributed to
its commit authors, never to the agent performing the import.

Search includes imported results by default but ranks an equivalent live
capture first. Default `status` and `list` output collapse imported artifacts to
a count so a large history does not bury current work. Ask the agent for
imported results specifically when you want to inspect the backfill.

## Enrichment remains evidence-bound

The agent can turn strong commit evidence into clearer labels, outcomes,
checkpoint summaries, and decisions before applying the import. It prioritizes
the highest-signal clusters rather than manufacturing detail for every commit.

Every synthesized decision requires an exact commit-message citation. Git
structure, authorship, and file changes cannot be rewritten by enrichment, and
invalid enrichment falls back to the truthful skeleton rather than blocking the
import. Pull-request titles, bodies, and threads are an optional additional
source for labels and outcomes only; the agent asks before using that context
because retrieving it can contact the source-control provider.

## Fill gaps as you encounter them

After the initial backfill, the `orcaops-seed-discovery` history-gap skill may
notice that a provenance lookup or prior-art search reached older, uncovered
code. It reports the gap and recommends a narrow seed request; it does not import
history automatically.

For example:

```text
Backfill the history behind this uncovered commit.
Backfill the older history for packages/auth.
```

The seed skill previews the narrow selection and asks for approval through the
same workflow as the initial import.

## CLI reference for automation

The skill drives the commands below. Use them directly when building automation
or intentionally operating without an agent:

```bash
orcaops seed status
orcaops seed --dry-run
orcaops seed --yes
orcaops seed --importance --dry-run
orcaops seed --importance --yes
orcaops seed --commit <sha> --dry-run
orcaops seed --commit <sha> --yes
```

Use `--since`, `--max-commits`, `--branch`, `--author`, or `--path` to narrow a
preview. Preserve the same selectors when applying it. `--yes` is the explicit
write authorization; omit it for inspection. Pass `--enrichment-dir <path>`
only with a prepared enrichment directory. Run `orcaops seed --help` for the
complete current flags.

Use `orcaops list --imported` to inspect the imported set or
`orcaops search --no-imported` to exclude it from a search. To suppress another
progressive backfill suggestion for an area, run
`orcaops seed status --decline <directory>`.

## Where the backfill is stored

Seed writes to the local Orcaops store. It does not push imported artifacts to
Cloud as part of the import, even when ordinary live capture sync is enabled.

The refs used for seeded checkpoint time travel live under
`refs/orcaops/snap/`; the `orcaops doctor` and garbage-collection checks own
their health and cleanup.
