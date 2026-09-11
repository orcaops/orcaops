---
title: Provenance JSON
description: 'Inspect compact provenance candidates, expand evidence, and migrate why JSON consumers to schema v4.'
---

# Provenance JSON

`orcaops why <file> --json` and `orcaops why <file>:<line> --json` return
schema version **4**, with compact candidates in `results`. Add `--details`
to read the existing rich candidate evidence. Detail mode can produce large
responses. Human output retains captured narrative; `--details` without `--json`
adds nothing.

```sh
orcaops why src/auth.ts --json
orcaops why src/auth.ts --json --all
orcaops why src/auth.ts:42 --json --details --limit 1
orcaops show <artifact_id> --project <project_id> --json
```

Both modes use identical selection, ranking, confidence, reasons, and conclusions
for the same code and history state. Whole-file history is ranked by applicability;
it does not assert line authorship or newest-first ordering. `show` inspects an
artifact, including revisions and checkpoints, but has no historical event selector
and does not reproduce an exact historical candidate view.

## Candidate fields

The following table specifies the treatment of every candidate field from v3.
An omitted body and all its nested fields remain available in detailed `results`.
No additional raw fingerprint manifest is introduced by `--details`. Both modes
add a top-level candidate `label` from the historically supported plan, or null.
Compact mode also adds `evidence_counts`, described below.

| Fields                                                                                                        | Compact treatment                                                                     | Detail treatment                                |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `root_key`, `project_id`, `store_instance_id`, `artifact_id`, `locator`                                       | Complete identities                                                                   | Unchanged                                       |
| `version_token`, `artifact_generation`, `pending`, `origin`                                                   | Unchanged; origin is `captured` or `imported`                                         | Unchanged                                       |
| `kind`, `source_event_id`, `recorded_at`                                                                      | Unchanged                                                                             | Unchanged                                       |
| `reachability`, `reachability_basis`, `relationship`, `confidence`, `content_match`, `provisional`, `reasons` | Unchanged, including every reason                                                     | Unchanged                                       |
| `manifest_files`                                                                                              | Path previews with counts                                                             | Complete path array                             |
| `plan_support.anchor_event_id`, `.source_event_id`, `.content_event_id`, `.state`                             | Unchanged                                                                             | Unchanged                                       |
| `plan_support.plan`                                                                                           | Omitted; its nullable `base_sha` is retained as `plan_support.base_sha`               | Complete original supported plan                |
| `source_plan.source_ref`, `.hash`, `.baseline`                                                                | Complete source identity and baseline, including local/cloud reference fields         | Unchanged                                       |
| `source_plan.content`                                                                                         | Omitted                                                                               | Complete source-plan text                       |
| `checkpoint`                                                                                                  | Reference and boundary facts described below, or null                                 | Complete original checkpoint                    |
| `fingerprint.state`, `.truncated`, `.manifest_hash`                                                           | Unchanged                                                                             | Unchanged; raw manifest remains absent as in v3 |
| `overlap`                                                                                                     | Target facts and collection previews described below, or null                         | Complete adjudication                           |
| `association.worktree_ids`                                                                                    | Identity preview with counts                                                          | Complete identity array                         |
| `association.unknown`, `.checkpoint_worktree_id`                                                              | Unchanged                                                                             | Unchanged                                       |
| `enrichment.content_event_id`, `.enriched_at`                                                                 | Unchanged                                                                             | Unchanged                                       |
| `enrichment.plan`, `.checkpoint_summary`                                                                      | Bodies omitted; `plan_available` and `checkpoint_summary_available` indicate presence | Complete supplemental bodies                    |
| `issues`                                                                                                      | Diagnostic preview and code counts                                                    | Complete original array                         |

Compact checkpoints retain `n`, `source_event_id`, `source_event_ids.opened` and
`.closed`, `open_plan_revision_event_id`, `head_sha`, and nullable `open_head_sha`.
The existing interval-start fallback is `open_head_sha ?? plan_support.base_sha`.
The supported plan's base SHA is distinct from the source-plan authoring baseline.
Missing evidence stays null or explicitly unavailable; it is not a compact omission.

Checkpoint `attribution_degraded` is null when absent, otherwise it contains
`target_unmerged`, `probe_failed`, and an `unmerged_paths` preview. These target
facts are computed from all evidence, including paths outside the preview.
All other checkpoint fields are detail-only: `schema_version`, `artifact_id`
(already on the candidate), `status`, `declared_step_ids`, `agent_session_id`,
`agent`, `policy_exceptions`, `plan_revision_id`, `opened_at`, `open_snapshot`,
`closed_at`, `closed_by_agent`, `summary`, `files_changed`, `decisions`,
`uncertainty`, `done_criteria`, `verification`, `window_overlap`,
`completed_step_ids`, `close_snapshot`, and `diff_fingerprint_summary` (its
manifest identity is already retained under `fingerprint`).

Compact overlap retains `n` and `finalized`. Its `target` object reports
`ambiguous`, `mixed_segment`, `own_claim_pending`, `segment_attributed`, and
`unattributed_in_window` from the complete adjudication. `ambiguous`,
`mixedSegment`, `ownClaimPending`, `dropped`, `segmentAttributed`,
`unattributedInWindow`, and `unreadableSiblingArtifacts` become previews.
File-pair previews retain both before/after paths; dropped entries also retain
`status`. Sibling artifact identities remain complete.

## Historical labels and counts

The candidate's `label` is `plan_support.plan.label` at its historical anchor,
in both representations. It never comes from a later plan revision, task text,
checkpoint summary, or supplemental enrichment. When unavailable it is null;
callers can display `kind`, `checkpoint.n` when present, and artifact identity.
The existing plan-label limit is 70 characters.

Compact `evidence_counts` contains `plan_decisions`, `checkpoint_decisions`,
and `checkpoint_uncertainty`. Each counts entries in the corresponding historical
body array, without deduplication or combining sources. Null means the source
body is unavailable; zero means available and empty. Supplemental enrichment
is excluded. Detailed candidates retain the original arrays instead of these
counts, including full task, summary, decisions, and uncertainty.

## Preview contract

An evidence collection is `{ "items": [...], "total": 13, "omitted": 3 }`.
At most 10 original entries are previewed, preserving their original ordering.
Display paths and diagnostic text use
`{ "text": "...", "length": 300, "truncated": true }`: at most 240 Unicode
code points after redaction, with the full redacted length reported. These text
previews are for display, not lookup. Null paths remain null.

Candidate and shared diagnostic previews additionally contain `distinct_codes`
and `code_counts`, an alphabetically ordered array of `{ code, count }` entries
covering every distinct code. Those counts count original diagnostic records;
an issue's own `count` can instead count affected artifacts. Preview records keep
`code`, optional project/artifact/source-event identities, and optional `count`.
`message` and optional `resource` are text previews. Full diagnostics, including
records with no returned candidate, remain available in detail mode.

Identities, source-plan references, Git anchors, the selected target path,
attribution reasons, query uncertainty, distinct-code
inventories, and the result page are never cut to preview limits. Compactness
removes body-size amplification; it does not guarantee a constant total byte size
for arbitrary identifiers, evidence inventories, or candidate counts. JSON is never
byte-truncated, and candidates are never dropped to satisfy a payload limit.

## Envelope and omissions

All prior envelope fields retain their meaning except the versioned projections
specified here. `schema_version` is 4 and `representation` is `compact` or
`details`. `scope`, `code_revision`, `target`, `filters`, `conclusion`,
`candidate_selection`, `integrity`, `uncertainty`, and
`seed_guidance` remain available. Target file contents remain omitted as in v3.

Distinguish four independent kinds of omission:

| Metadata                              | Meaning                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detail_omissions`                    | Representation omitted bodies or summarized evidence. `results`, `best`, `shared_diagnostics`, and `source_versions` disclose where compact rules apply; `compact_fields` lists affected body fields and `preview_limits` gives the limits. This does not mean evidence is unavailable. |
| `pagination`                          | Matches outside this page. Existing `offset`, `limit`, `total`, and `has_more` are joined by `returned`, nullable `next_offset`, and `total_basis: "evaluated_matches"`.                                                                                                                |
| `candidate_selection`                 | Indexed versus materialized candidate artifacts, omitted candidates, and materialized/omitted overlap support. These are processing omissions, not pagination.                                                                                                                          |
| `completeness` and `project_coverage` | Evidence and coverage state. Flags remain unchanged. Their `issues` fields are compact diagnostic summaries by default and complete redacted arrays in detail mode. All other coverage fields/tokens remain unchanged.                                                                  |

The default page size is 25. `--all` changes that default to 1,000; explicit
`--limit` overrides it. Separate internal budgets default to 500 candidate
artifacts and 500 support artifacts. `--all` does not bypass these budgets.
Pagination totals count matches in the evaluated set, not complete repository
history. Follow `next_offset` with the original options for another page.

`follow_up` provides artifact inspection, narrower attribution, and detail-mode
guidance once per envelope. Human output provides equivalent guidance.

## Source-version summary

Compact `source_versions` is `{ "count": 2, "digest": "sha256:..." }`.
It summarizes the complete evaluated source-version collection, including
materialized overlap-support artifacts, independently of the requested page.
Detail mode retains the original array of `{ artifact_id, version_token }`.
Each candidate's own `version_token` remains available in both representations.

Canonical hashing is SHA-256 over UTF-8 JSON of `[artifact_id, version_token]`
tuples sorted by artifact ID, then version token, using ordinal JavaScript string
comparison (`<` / `>`), with duplicates retained and no whitespace. The digest
is prefixed with `sha256:` and uses lowercase hexadecimal. `count` counts all
entries, including duplicates. For example, `[]` hashes to
`sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
Reordering equivalent inputs leaves the digest unchanged; changing a support
artifact version changes it. The digest detects changed source state; it does
not provide historical snapshot retrieval. Processing-budget omissions still
appear separately in `candidate_selection` and completeness diagnostics.

## Best candidate and migration

`best` follows `representation`: compact by default and rich with `--details`.
It uses the same candidate projection as `results`, even when outside the
requested page or when that page is empty. There is no `best_result_offset`
or second-query offset verification protocol.

For a line explanation, request `--json --details --limit 1` and read rich
`best` directly when present. Null means no single best was selected, including
ambiguity, omitted candidate evaluation, or no matches. Never substitute
`results[0]` for a null best: limiting an ambiguous result to one row does not
resolve the tie. Inspect conclusion, provisional claims, candidate selection,
and completeness even when best is present.

In v3, consumers could read `best.plan_support.plan` directly. In v4 they must
request `--details` to keep doing so. Compact `plan_support` retains historical
event IDs, state, and `base_sha`, while the full plan remains in detailed best
and results. Omitted bodies are available through detail mode; unavailable
bodies stay null or carry an explicit unavailable state in either mode.

`--limit 1` limits result rows, not narrative bytes or shared diagnostics.
To expand more, increase the limit or follow `pagination.next_offset`, keeping
the target and original `--project`, `--scope`, `--branch`, `--origin`,
`--touching`, and `--at` options. To inspect one artifact, use its project and
artifact identities with `show`; `why` has no artifact-ID filter.

Repeated queries read current history. `--at` fixes the code revision but does
not freeze artifact history or overlap adjudication. No persistent snapshot or
expected-version query parameter is introduced by schema v4.

## Matching JSON examples

The following valid JSON excerpts show the same checkpoint on an empty result
page (`--offset 2 --limit 1`); unshown fields are excluded only to shorten these
examples. Best remains available. The compact candidate's missing body is a
presentation omission, while its null `source_plan` is unavailable evidence.
The historical label and identity match in both modes.

```json
{
  "schema_version": 4,
  "representation": "compact",
  "conclusion": "supported",
  "best": {
    "artifact_id": "candidate",
    "source_event_id": "closed-event",
    "version_token": "a",
    "label": "Session expiration",
    "kind": "checkpoint",
    "confidence": "exact",
    "plan_support": {
      "anchor_event_id": "plan-event",
      "source_event_id": "plan-event",
      "content_event_id": "plan-event",
      "state": "available",
      "base_sha": "abc123"
    },
    "checkpoint": { "n": 1 },
    "source_plan": null,
    "evidence_counts": {
      "plan_decisions": 1,
      "checkpoint_decisions": 0,
      "checkpoint_uncertainty": 0
    },
    "manifest_files": {
      "items": [{ "text": "src/auth.ts", "length": 11, "truncated": false }],
      "total": 1,
      "omitted": 0
    }
  },
  "results": [],
  "source_versions": {
    "count": 2,
    "digest": "sha256:2d326d8a07b2d5cf9e2dbc314af5839a4e3e6e1494b575364280a256b167fbb5"
  },
  "detail_omissions": {
    "results": true,
    "best": true,
    "shared_diagnostics": true,
    "source_versions": true,
    "compact_fields": [
      "plan_support.plan",
      "source_plan.content",
      "checkpoint",
      "enrichment.plan",
      "enrichment.checkpoint_summary"
    ],
    "preview_limits": { "items": 10, "characters": 240 }
  },
  "pagination": {
    "offset": 2,
    "limit": 1,
    "total": 2,
    "returned": 0,
    "total_basis": "evaluated_matches",
    "has_more": false,
    "next_offset": null
  }
}
```

With `--details`, the corresponding excerpt is:

```json
{
  "schema_version": 4,
  "representation": "details",
  "conclusion": "supported",
  "best": {
    "artifact_id": "candidate",
    "source_event_id": "closed-event",
    "version_token": "a",
    "label": "Session expiration",
    "kind": "checkpoint",
    "confidence": "exact",
    "plan_support": {
      "anchor_event_id": "plan-event",
      "source_event_id": "plan-event",
      "content_event_id": "plan-event",
      "state": "available",
      "plan": {
        "label": "Session expiration",
        "base_sha": "abc123",
        "task": "Expire idle sessions",
        "decisions": [
          { "decision": "Use idle expiry", "reason": "Limit inactive access", "revision_n": 0 }
        ]
      }
    },
    "checkpoint": {
      "n": 1,
      "summary": "Added idle session expiry",
      "decisions": [],
      "uncertainty": []
    },
    "source_plan": null,
    "manifest_files": ["src/auth.ts"]
  },
  "results": [],
  "source_versions": [
    { "artifact_id": "candidate", "version_token": "a" },
    { "artifact_id": "support", "version_token": "z" }
  ],
  "detail_omissions": {
    "results": false,
    "best": false,
    "shared_diagnostics": false,
    "source_versions": false,
    "compact_fields": [
      "plan_support.plan",
      "source_plan.content",
      "checkpoint",
      "enrichment.plan",
      "enrichment.checkpoint_summary"
    ],
    "preview_limits": { "items": 10, "characters": 240 }
  },
  "pagination": {
    "offset": 2,
    "limit": 1,
    "total": 2,
    "returned": 0,
    "total_basis": "evaluated_matches",
    "has_more": false,
    "next_offset": null
  }
}
```

## Performance scope

Compaction reduces serialized payload size and downstream parsing volume.
Projection happens after evidence hydration, resolution, and pagination, so
it does not promise fewer database reads, less Git/resolver work, or lower peak
memory. Exact byte-size equality tests independently enlarge omitted narratives
from 1 KiB to 1 MiB while keeping exposed identities, labels, and counts fixed.
Representative compact/detail payload measurements are separate from those
invariance tests; total size still depends on candidate and evidence counts.
