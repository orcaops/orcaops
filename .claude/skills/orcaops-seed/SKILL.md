---
name: "Orcaops: seed git history"
description: "Backfill Orcaops once from an existing repository's git history. Use when the user says \"seed orcaops from git history\", \"import my git history\", \"backfill my history\", or \"why is orcaops search empty?\". Preview first, explain synthesized provenance, obtain confirmation, orchestrate optional enrichment, apply once, and finish the importance lane."
metadata:
  generatedBy: "orcaops@0.1.0"
  contentHash: "ef5a2f1ab9c4"
tags: ["orcaops", "orchestration"]
---

Only proceed on explicit user request.

# Workflow

1. Inspect existing state:

   ```bash
   orcaops seed status --json
   ```

   If the run is partial, say that the next apply resumes it. If imports already
   exist and the run is complete, report that and do not create duplicates.
2. Preview locally:

   ```bash
   orcaops seed --dry-run --json
   ```

   Preview writes precious seed state, may mint project identity in repository
   Git config, and writes generated bundle files when clusters are pending. It
   does not write the seed journal or artifacts and does not contact a network
   in the default flow.

   Summarize the selected branch, commit/artifact counts, truncation, author
   distribution, enrichment bundle directory, candidate-cue totals, estimated
   reading size, and coverage denominator. Suggest
   `--author <pattern>` (often `git config user.email`) when the user wants
   only their history.
3. Explain the honesty boundary before asking for confirmation: the result is
   synthesized from commits, labeled `[imported]`, attributed to commit authors,
   and contains no invented acceptance criteria, uncertainty, or tests. Seeded
   artifacts stay local in v1.
4. Ask the user to confirm the exact import and enrichment scope. Offer all
   bundles, cue-bearing bundles, a user-specified maximum, or skeleton only.
   A bounded subset may be enriched now; imported skeleton artifacts remain
   eligible for later enrichment through `orcaops seed enrich --artifact <id>`.
   Clusters excluded from the approved selection remain eligible for a later
   seed run. Do not treat a request to inspect, diagnose, or preview as consent
   to write.
5. After confirmation, optionally enrich the generated bundles. Write each
   cluster's enrichment JSON into the SAME directory the bundles were written
   to — the dry run reports it as `enrichment.bundle_directory`, and every
   bundle header names it — then pass exactly that path to
   `--enrichment-dir`. Writing beside the bundles is the sanctioned layout;
   a separate directory works only if you pass that directory instead.
   **Triage before authoring.** Follow the scope the user approved. When they
   choose a maximum, put cue-bearing bundles first, then rank by absolute
   candidate-cue count, recency, and commit count. Say which bundles will be
   enriched and which will be written as skeletons; never silently drop them.
   Evidence-backed
   decisions must remain paraphrases with their citation; never manufacture
   rationale when the evidence bar is not met. Keep `label` and every step
   `label` within 70 characters — the validation gate rejects longer ones
   before anything is written. Compose every field WITHIN its cap; never clip
   drafted text to fit. A quote that will not fit must be re-selected as a
   shorter verbatim span, never truncated mid-word — the gate warns on fields
   sitting exactly at a cap or ending mid-word, and a warned field should be
   re-worded, not shipped. Account for every candidate decision nomination a
   bundle lists — the target is zero unaccounted nominations: every nomination
   gets one `nomination_dispositions` entry keyed by its listed
   `nomination_id`, either `"decision"` paired with a cited entry in
   `decisions`, or `"skipped"` with a reason. That array
   accounts for the NOMINATIONS, not for your decisions: a decision minted from
   an un-nominated commit of the same cluster is legal and gets no row, and the
   apply report is right not to count it. Let the bundle's
   "Distinct tasks" count size how much you READ — a merged run cluster carries
   each of its tasks' decisions, so never stop at a fixed per-cluster quota —
   and let the evidence size how much you MINT, up to the
   per-bundle effort ceiling the bundle states. Fewer nominations is normal
   rather than a shortfall: mint what the evidence supports and never pad. Past
   the ceiling, take nominations in their listed order and bulk-disposition the
   remainder as `"skipped"` with one honest shared
   reason. A bundle being large is never a reason to skip it wholesale. Each
   bundle's "Output contract" section states the exact payload schema, the
   decision object shape, and the citation format — follow it literally, since
   parsing is strict and one unknown key rejects the whole file.
   PR context is opt-in: ask before
   adding `--pr-context` or using `gh`, disclose that this may contact the GitHub
   provider, and use PR titles, bodies, and threads only for `label`, `task`,
   and `outcome`. Decisions remain commit-cited only; PR context must not inform
   decisions, steps, or checkpoint summaries. Never make a network or provider
   call during the default local-only flow.
6. Apply once:

   ```bash
   orcaops seed --yes --enrichment-dir <output-dir> --json
   ```

   `<output-dir>` is the bundle directory from step 5. Omit
   `--enrichment-dir` when no enrichment was produced. Preserve any
   selection flags from the approved preview.
7. Run `orcaops seed status --json`. If `pending_importance` is true, explain
   the older/high-impact second phase, obtain confirmation for it, then run
   `orcaops seed --importance --yes --json` and report final coverage/failures.

To enrich an artifact after import, preview it first:

```bash
orcaops seed enrich --artifact <artifact-id> --dry-run --json
```

Author the generated bundle, preview again to validate it, obtain explicit
confirmation, then apply with `--yes`. Use `--preserve-decisions` for a
prose-only amendment. Never apply a post-import amendment without showing the
validated preview first.

Do not use `orcaops-seed-discovery` for the initial one-time
backfill; that skill owns later, scoped gap filling.

# Enrichment orchestration

After the user approves an import, enrich the approved bundle set through a
bounded worker queue when there is more than one. Give each subagent a disjoint
bundle and one output JSON path INSIDE the bundle directory; as a worker
finishes, dispatch the next queued bundle until the approved set is exhausted.
If a launch fails, keep that bundle queued and retry it when a slot is free;
never silently drop it.

Every enrichment worker must use a private scratch directory OUTSIDE the
shared bundle directory. A worker must not write helper files into the shared
directory or run any helper script it did not create for this task. Its final
enrichment JSON is the only file it may write outside its private directory.

Require every worker to preserve each citation and the
bundle's artifact id, and to honor the bundle's per-bundle decision ceiling.
Wait for every subagent, validate that each expected JSON file exists, then make
ONE apply call with `--enrichment-dir` pointing at that same bundle directory.
Never let a subagent run the apply command.

# Reporting

Lead with created, resumed, covered, and failed counts. Disclose truncation and
invalid/unmatched enrichment files. Imported work belongs to `origin.authors`;
never describe colleagues' imported commits as first-person work.
