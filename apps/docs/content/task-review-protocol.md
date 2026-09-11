---
description: 'Integrate or diagnose the bounded forensic-first Task Review engine, payloads, states, and failure contracts.'
---

# Task Review protocol

Task Review is a bounded, forensic-first two-lane routine. One reviewer authors
both passes from engine-served inputs: a capture-blind forensic pass over the
eligible diff, followed by a capture-grounded account pass that curates the
causal Story. The CLI builds and pins the inputs, enforces ordering and limits,
validates both submissions, derives code ownership, merges the two lenses, and
renders the result. It never calls a model.

## Task Review status dimensions

The routine reports these dimensions independently:

| Dimension            | Meaning                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Run outcome          | `FULL`, `DEGRADED`, or `FAILED` describes lane completion and whether core outputs were produced.                  |
| Ownership label      | `DERIVED`, `DEGRADED_ATTRIBUTION`, or `CODE_ONLY` describes whether changed rows could be assigned to Story Parts. |
| Current Story status | `OK`, `ABSENT`, `STALE`, or `INVALID` describes the authoritative installed Story reader boundary.                 |

`FULL`, `DERIVED`, and `OK` mean that the routine completed and its Story is
reader-ready for the current floor. They do not mean that every defect was
found, every finding was confirmed, or the branch is safe to merge.

## Interpretation boundaries

- **Forensic findings** are unadjudicated reviewer attention, not confirmed
  defects or a merge verdict.
- **Evidence boundary:** the forensic lane sees only the served diff; the
  account lane sees only the served capture corpus and current-run facts.
- **Assistance and provenance:** isolation, repairs, execution-profile fields,
  executable identity, attempts, and input hashes remain visible in the
  terminal run record.

## Evidence and independence

The forensic lane is capture-blind by construction. It receives the changed-file
inventory and literal eligible diff, but no plan, checkpoints, prior findings, or
account. The account lane is code-blind: it receives captured intent, decisions,
uncertainty, verification, evaluator outcomes, and current-run facts, but it does
not inspect the repository. This separation prevents either lens from silently
borrowing the other lens's conclusions.

Independence is derived from recorded facts, not asserted by the reviewer. The
run record retains the executable identity, declared lane isolation, optional
execution-profile provenance, and every repair attempt. Unknown identity stays
unknown. Prior audits, findings reports, review comments, generated artifacts,
and design documents are prior art; using them outside the served inputs would
cross the bounded routine's evidence boundary.

## Supported routine lifecycle

### 1. Start the run

```bash
orcaops review routine-start \
  --branch <branch> \
  --json
```

`routine-start` checks or builds the healthy floor, builds the dossier, pins the
run inputs, mints an immutable run ID, and serves the forensic payload and its
contract in one JSON envelope. An optional `--execution-profile-json` may record
known host, model, effort, launcher, and instruction identity with field-level
provenance. Unknown values remain `null`.

If the floor is unhealthy or the complete forensic/account inputs exceed their
ceilings, no review payload is minted. Narrow the review scope or change the
configured cap; do not review partial evidence.

### 2. Submit the forensic lane

Read the served forensic payload once, in order. Submit at most three concrete
findings and one question, anchored only to changed paths in that payload:

```bash
orcaops review routine-submit \
  --branch <branch> \
  --run <run-id> \
  --lane forensic \
  --isolation sequential \
  --input - \
  --json
```

```json
{
  "findings": [
    {
      "claim": "A concrete behavior-level defect or risk.",
      "file": "src/example.ts",
      "related_files": [],
      "severity": "CAUTION",
      "confidence": "HIGH"
    }
  ],
  "questions": []
}
```

The account payload is unavailable until the forensic lane is terminal:
accepted, or rejected after its one repair is spent. Asking early returns
`TWOLANE_ROUTINE_ORDER`; it does not reveal account context or consume repair
credit.

### 3. Submit the account lane

The account payload gives every in-scope completed checkpoint a `k#` alias and
every citable captured record a `c#` alias. The reviewer must place every
completed checkpoint in exactly one nested Part and use only those aliases:

```bash
orcaops review routine-submit \
  --branch <branch> \
  --run <run-id> \
  --lane account \
  --isolation sequential \
  --input - \
  --json
```

```json
{
  "schema_version": 1,
  "overview": {
    "text": "A concise branch-level causal account.",
    "citations": ["c3"]
  },
  "acts": [
    {
      "title": "Introduce the behavior",
      "parts": [
        {
          "title": "Implement the bounded change",
          "checkpoints": ["k1"],
          "interpretation": "Why this checkpoint belongs in this Part.",
          "citations": ["c3"]
        }
      ]
    }
  ],
  "questions": []
}
```

An accepted account submission finalizes the run in the same response. Each lane
has one independent repair. Diagnostics name the exact shape, membership, alias,
or limit violation to fix; minting another run to evade an exhausted repair is
not part of the protocol.

## Retained run state

The project database retains run identity, pinned inputs, served-input receipts,
submissions, attempts, and workflow transitions. Comments keep append-only revision
history and exact review targets. These records are read through the review
commands and Watch; there is no mutable `.orcaops/reviews` run directory to edit.

Floor and Story evidence are immutable files. Their database publications record
the evidence kind, exact identity, and content hash. Evidence is written durably
before a transaction can select it. Git snapshot retention uses immutable refs;
changing the selected publication changes a database row, not an existing ref.

Current routine contract versions are run schema 2, slice state schema 5, Story
review model schema 4, and floor producer version 11.

## Finalization and current Story selection

Finalization validates accepted lane state, composes the Story and derives its
ownership outside the database transaction. `FULL` has both accepted lanes. A
terminal run may instead be explicitly `DEGRADED` or `FAILED`; a failed run cannot
select a current Story.

The publication transaction checks the expected run and version before selecting
the prepared Story. A stale run cannot replace the current Story or overwrite
newer review progress. Older accepted publications remain retained with their
exact run, floor, model, and anchor identities.

## Reader contract

Readers resolve exactly the selected Story publication. They validate its
retained run owner, sealed run revision, terminal non-failed outcome, model
hash, canonical Story model bytes, branch identity, and floor input hash. They
never select a run by modification time, scan backward for an older valid run,
or treat an unselected model as current.

Resolution returns:

- `OK` when the selected publication and model are valid for the current floor;
- `ABSENT` when no Story publication is selected;
- `STALE` when a fully validated model belongs to a different floor;
- `INVALID` when the selection, terminal record, hash, or model contract fails.

A stale model may be shown best-effort, but status—not model presence—controls
authority. Orcaops Watch reads this same engine-owned boundary and preserves the
installed Story's Acts, Parts, owned diffs, residue, findings, and questions.

## Failure diagnostics and bounded repairs

Start-time refusals mint no payload and spend no repair:

| Code                         | Meaning and response                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FORENSIC_TRANSPORT_CEILING` | The eligible diff exceeds the fixed forensic transport ceiling. Narrow ordinary review scope, or explicitly stub committed corpora and generated fixtures with `review.stub_paths`; raising `review.max_diff_bytes` does not raise this ceiling. |
| `ACCOUNT_CORPUS_CEILING`     | The complete capture corpus exceeds its ceiling. Narrow scope or raise the ceiling; the account is never clipped.                                                                                                                                |
| `REVIEW_DIFF_TRUNCATED`      | The floor contains only a partial review diff because it exceeded `review.max_diff_bytes`. Narrow scope or raise that collection cap, then rebuild with a complete eligible diff before reviewing.                                               |

Ordering and submission diagnostics are repairable only as stated:

| Code                           | Meaning and response                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `TWOLANE_ROUTINE_ORDER`        | Finish the forensic lane before requesting or submitting account context.                     |
| `SLICE_PAYLOAD_SHAPE`          | Fix the exact strict-schema paths named by the diagnostic.                                    |
| `SLICE_ROUTINE_LIMITS`         | Reduce counts or word lengths and remove banned severities.                                   |
| `SLICE_UNKNOWN_FILE`           | Anchor forensic content only to changed files served in the payload.                          |
| `SLICE_UNKNOWN_CITATION`       | Use only engine-issued `c#` aliases.                                                          |
| `SLICE_OVERVIEW_ALIAS_LEAK`    | Remove bracketed prompt-local aliases from overview prose; keep them in `overview.citations`. |
| `STORY_CHECKPOINT_UNCLAIMED`   | Place every completed checkpoint in exactly one Part.                                         |
| `STORY_CHECKPOINT_DUPLICATED`  | Remove duplicate Part membership.                                                             |
| `STORY_UNKNOWN_CHECKPOINT_REF` | Use only served completed-checkpoint `k#` aliases.                                            |
| `SLICE_SUBMIT_AFTER_ACCEPT`    | Do not resubmit a lane that is already accepted.                                              |
| `TWOLANE_ATTEMPT_BUDGET`       | The lane's one repair is spent; do not mint a replacement run.                                |

Finalization failures are classified. Every finalize code arrives after a valid
account submission: the lane remains accepted, and neither resubmitting the
lane nor replacing the run is ever the remedy. All codes except the
`STORY_COMPOSE_FAILED` fallback are deterministic — retrying reproduces them,
so fix what the diagnostic names instead of retrying.

| Finalize code                       | What broke                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `TWOLANE_EXECUTABLE_IDENTITY_DRIFT` | The finalizing executable is not the one that started the run; rerun finalization with the original build. |
| `STORY_MODEL_CATALOG_INVALID`       | The composed Story references identities absent from its citation and ledger catalogs.                     |
| `STORY_MODEL_PROJECTION_INVALID`    | Projecting the composed Story into the review model failed.                                                |
| `STORY_MODEL_RANGES_UNRESOLVED`     | Part code ranges could not be resolved against the pinned diff.                                            |
| `STORY_MODEL_INVARIANT`             | The composed model violates a Story review-model invariant.                                                |
| `PART_OWNERSHIP_INVARIANT`          | Part ownership derivation broke its coverage invariant.                                                    |
| `STORY_MODEL_SCHEMA_INVALID`        | The composed model fails schema validation.                                                                |
| `STORY_COMPOSE_FAILED`              | Unclassified engine failure — the one code where retrying finalization once is the right first move.       |

If current Story publication fails after outputs become terminal, the run
record remains durable and the failure is reported separately rather than
silently selecting another Story.

JSON envelopes are the source of truth. A command can execute successfully while
returning `accepted: false` with diagnostics, so callers must not infer lane
acceptance from the process exit code alone.
