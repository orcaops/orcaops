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

## Run and artifact layout

Every run is self-contained beneath:

```text
.orcaops/reviews/<branch-slug>/twolane/<run-id>/
```

The directory contains:

| Artifact                                                                  | Contract                                                                                                                                                                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-v1.json`                                                             | Mutable routine state while lanes are active; terminal outcome and time after finalization. (Container name fixed at v1; the contract version lives in `schema_version` — currently 2.) |
| `dossier-v1.json`, `account-projection-v1.json`, `forensic-input-v1.json` | Pinned inputs whose hashes are recorded by the run.                                                                                                                                     |
| `coverage-v1.json`, `diff.patch`                                          | The optional attribution snapshot and exact eligible diff used for ownership and rendering.                                                                                             |
| `lane-forensic.md`, `lane-account.md`                                     | The inputs served to the reviewer in enforced order.                                                                                                                                    |
| `accepted-forensic.json`, `accepted-account.json`                         | The validated terminal lane submissions when present.                                                                                                                                   |
| `review.md`, `brief.json`                                                 | Concise rendered outputs.                                                                                                                                                               |
| `composed-story-v2.json`                                                  | The deterministic merged Story before reader-model projection.                                                                                                                          |
| `story-review-model-v4.json`                                              | The primary installed Story model, including engine-derived Part ownership and residue.                                                                                                 |
| `run-record-v1.json`                                                      | Immutable disclosure of inputs, attempts, repairs, isolation, runtime identity, latency, outcome, outputs, hashes, and optional semantic-anchor preparation.                            |

Current routine contract versions are run schema 2, slice state schema 5, Story
review model schema 4, current Story pointer schema 1, durable review-state
version 4, and floor producer version 11.

## Finalization and current Story installation

Finalization validates accepted lane state, composes the Story, derives
ownership, renders the concise artifacts, writes the Story model, and then
writes `run-record-v1.json` before marking `run-v1.json` terminal. `FULL` has
both accepted lanes. A terminal run may instead be explicitly `DEGRADED` or
`FAILED`; a failed run cannot install a current Story.

After a non-failed terminal run is durable, the engine publishes the branch-wide
pointer:

```text
.orcaops/reviews/<branch-slug>/twolane/current-story-v1.json
```

The pointer names the run ID, finalization time, floor input hash, model file,
and model SHA-256. Publication happens under the review-state lock. A newer
valid terminal pointer wins; a missing or invalid pointer can be repaired by a
valid terminal run.

## Reader contract

Readers resolve exactly the run named by `current-story-v1.json`. They validate
the pointer schema, safe run path, agreement between `run-v1.json` and
`run-record-v1.json`, terminal non-failed outcome, model hash, canonical Story
model bytes, branch identity, and floor input hash. They never select a run by
modification time, scan backward for an older valid run, or treat an unpointed
model as current.

Resolution returns:

- `OK` when the pointer and model are valid for the current floor;
- `ABSENT` when no current pointer exists;
- `STALE` when a fully validated model belongs to a different floor;
- `INVALID` when the pointer, terminal record, hash, or model contract fails.

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

| Code                             | Meaning and response                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `TWOLANE_ROUTINE_ORDER`          | Finish the forensic lane before requesting or submitting account context.                     |
| `SLICE_PAYLOAD_SHAPE`            | Fix the exact strict-schema paths named by the diagnostic.                                    |
| `SLICE_ROUTINE_LIMITS`           | Reduce counts or word lengths and remove banned severities.                                   |
| `SLICE_UNKNOWN_FILE`             | Anchor forensic content only to changed files served in the payload.                          |
| `SLICE_UNKNOWN_CITATION`         | Use only engine-issued `c#` aliases.                                                          |
| `SLICE_OVERVIEW_ALIAS_LEAK`      | Remove bracketed prompt-local aliases from overview prose; keep them in `overview.citations`. |
| `STORY_CHECKPOINT_UNCLAIMED`     | Place every completed checkpoint in exactly one Part.                                         |
| `STORY_CHECKPOINT_DUPLICATED`    | Remove duplicate Part membership.                                                             |
| `STORY_UNKNOWN_CHECKPOINT_REF`   | Use only served completed-checkpoint `k#` aliases.                                            |
| `STORY_OPEN_OR_ABANDONED_MEMBER` | Remove open or abandoned checkpoints from Part membership.                                    |
| `SLICE_SUBMIT_AFTER_ACCEPT`      | Do not resubmit a lane that is already accepted.                                              |
| `TWOLANE_ATTEMPT_BUDGET`         | The lane's one repair is spent; do not mint a replacement run.                                |

Finalization failures are classified. Every finalize code arrives after a valid
account submission: the lane remains accepted, and neither resubmitting the
lane nor replacing the run is ever the remedy. All codes except the
`STORY_COMPOSE_FAILED` fallback are deterministic — retrying reproduces them,
so fix what the diagnostic names instead of retrying.

| Finalize code                       | What broke                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `TWOLANE_EXECUTABLE_IDENTITY_DRIFT` | The finalizing executable is not the one that started the run; rerun finalization with the original build.              |
| `PINNED_DIFF_UNREADABLE`            | `diff.patch` is recorded in `input_shas` but unreadable, so Part ranges cannot be validated; restore the run directory. |
| `STORY_MODEL_CATALOG_INVALID`       | The composed Story references identities absent from its citation and ledger catalogs.                                  |
| `STORY_MODEL_PROJECTION_INVALID`    | Projecting the composed Story into the review model failed.                                                             |
| `STORY_MODEL_RANGES_UNRESOLVED`     | Part code ranges could not be resolved against the pinned diff.                                                         |
| `STORY_MODEL_INVARIANT`             | The composed model violates a Story review-model invariant.                                                             |
| `PART_OWNERSHIP_INVARIANT`          | Part ownership derivation broke its coverage invariant.                                                                 |
| `STORY_MODEL_SCHEMA_INVALID`        | The composed model fails schema validation.                                                                             |
| `STORY_COMPOSE_FAILED`              | Unclassified engine failure — the one code where retrying finalization once is the right first move.                    |

If current Story publication fails after outputs become terminal, the run
record remains durable and the failure is reported separately rather than
silently selecting another Story.

JSON envelopes are the source of truth. A command can execute successfully while
returning `accepted: false` with diagnostics, so callers must not infer lane
acceptance from the process exit code alone.
