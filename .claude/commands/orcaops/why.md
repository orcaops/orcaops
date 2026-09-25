---
name: "orcaops:why"
description: "Show a file history or trace a file:line to the checkpoint that touched it."
metadata:
  generatedBy: "orcaops@0.3.0"
  contentHash: "ed02cdeb6982"
tags: ["orcaops", "read-only"]
---

Answer "how did this file evolve?" with its evaluated recorded history,
or answer "why does this line exist?" by linking a file + line to the
captured artifact and checkpoint that produced it.

Pass either a bare `<file>` or `<file>:<line>` after the slash:

```bash
orcaops why src/middleware/rateLimiter.ts --json --view rationale --limit 5
orcaops why src/middleware/rateLimiter.ts --json --limit 5
orcaops why src/middleware/rateLimiter.ts:42 --json --limit 5
orcaops why <target> --branch feat/x
```

Resolve an existing target path before querying. JSON schema 8 returns candidate summaries
in `results` and focused explanations in `knowledge.rationale`. For a known target and a
reasons question, start with rationale; use compact to compare candidate histories. A line
target does not inherently require details. These are alternatives, not mandatory steps.
`best` is a candidate ID or null. Find it in `results[].id` or the off-page `best_candidate`.
Never promote one ambiguous row to best. Candidate summaries survive knowledge pressure.

Check rationale `status` before reading an account. An `omitted_oversized` placeholder
retains ranking and exact expansion, not abbreviated evidence. Inspect its `reference`
and attached correction/context references before using it. The original account alone
does not include all qualifications. Ordinary context may omit redundant prose and source
inventories; standing, applicability, conflicts, and scope effects remain meaningful.

`knowledge.obligations` and rationale items' `context` preserve authority, applicability,
competing revisions, corrections, and sources. Recorded accounts and unapproved interpretations
are not automatically current requirements. Keep reasons, alternatives, and rejection reasons.
Exact-source variants can be grouped under `interpretations`; differing accounts remain
explicit, while `account_from` reuses identical text. Context `wording_from`/`reason_from`
can name the main account or a grouped variant. Read all qualifications, not only the first account.

`knowledge.evolution` distinguishes resolver relationships from recorded change passages.
Read standing and actual scope effect: an established but unapplied replacement does not
make the earlier decision obsolete. Prose and lexical matches are not established supersession.
Replacing one decision does not retire surviving sibling decisions. File overlap is not authorship.
Change passages from one source event share `related_passages`; grouping does not prove they
are one decision or establish a replacement relationship.

Human output uses the same selection and ceiling. JSON is bounded to 16 KiB by default, 32 KiB with
`--view rationale`, and 64 KiB for explicit `--details --audit` comparison.
For a needed checkpoint body, use `why <same-target> --details --candidate <results[].id>
--anchor <inspection.anchor> --json` with the original scope. It returns one historical
`candidate` if it fits under 16 KiB, independently of pagination, not another explanation response.
Oversized receipts include a bounded `sections` index. Preserve the selection and use
`--section checkpoint-decisions` or `--section plan-decisions`; page with `--section-offset`
or select one complete `--decision <n>`. `files` and `uncertainty` sections are paged too.
Changed code/history invalidates the anchor. Export only if the needed unit still cannot fit.
Missing evidence stays unavailable. Broad audit bodies can be omitted independently of summaries.

Inspect a returned readable account selector with `orcaops knowledge show <reference> --project <project_id>
--json` under a 16 KiB display allowance (32 KiB with `--details`). Add `--context`
for full current qualifying records. Scope defaults to project; select `--scope artifact:<id>`
for artifact-specific authority. Follow `follow_up.next`
when the needed qualifications are outside the page. Incomplete evidence does not imply
another page: read `completeness.reasons` and the cursor. Export cannot resolve unavailable
evidence or authority. Oversized selections require `--output <new-file>`, which returns only a receipt.
Selectors identify accounts, not prior observations; they survive unrelated writes. Restart
stale context pagination without its cursor. `orcaops show <artifact_id> --project <project_id>
--json` inspects the artifact including later revisions, not an exact historical candidate.

Read `output` omissions separately from `diagnostics.retrieval`, knowledge limits,
candidate selection, completeness, and coverage. The ordinary `selection_target` stopping
policy leaves spare allowance; it is not evidence of completeness. Unavailable applicable obligations
withhold background rationale explicitly. Corrected or uncertain checks stay full accounts;
routine successful checks use a reported summary with authority and missing-evidence status,
not independently verified results or a test total. Its optional `planned` section does not
mean the checks ran. Omitted status/reference counts remain limits.

`--limit 1` limits provenance rows, not rationale retrieval. The default page is five.
`--all` changes it to 1,000; explicit `--limit` overrides it. Separate bounds cover
500 candidate and 500 overlap-support artifacts. Neither promises complete history.
Follow `pagination.next_offset`, preserving `--project`, `--scope`, `--branch`, `--origin`,
`--touching`, and `--at`. Pagination does not continue rationale search. `--at` fixes
code, not captured history. `why` has no artifact-ID filter.

Line results include a **confidence label**:

- `exact` — meaningful fingerprint or verified blame evidence supports the attribution.
- `likely` — verified blame lies inside the checkpoint work interval.
- `weak` — the artifact touched the file but the specific line's
  attribution is uncertain (parallel branches, multiple touches).
A `none` conclusion means no candidate matched in the evaluated set.

Expand an exact reference for a missing account or qualification, and use details for a
supporting checkpoint's files/head SHA. Use `/orcaops:show <id>` only when
broader chronology is missing from anchored evidence. Stop once material claims have support
or explicit inference labels, retrieved later changes are addressed, and current code/docs
corroborate the surviving design. Disclose coverage limits instead of exhausting every artifact.
Use `/orcaops:digest` only for a separately requested broader PR picture.
