# dossier-gate

**Source:** `SYNTHETIC_MINIMAL_FIXTURE` — wholly fabricated. Nothing here is
derived from a recorded review.

## What it models

Two review subjects driven end to end through the two-lane pipeline:

- `demo-service` — an in-house service change captured across three threads.
- `demo-library` — an external dependency change reviewed by the same harness.

Both use synthetic personas, generic file names and opaque capture ids.

## Contents (`slice/`)

| File                                      | Shape                                  |
| ----------------------------------------- | -------------------------------------- |
| `<subject>-dossier-v1.json.gz`            | `DossierV1` (`src/dossier.ts`)         |
| `<subject>-account-projection-v1.json.gz` | `AccountProjection` (`src/dossier.ts`) |

## What the consuming tests need

`src/twolaneSlice.test.ts` loads the dossier and projection for each subject,
authors the account-lane Story and forensic-lane payloads in code over them,
and drives those through the submission contract, prompt-alias boundary,
merge/render pipeline, and the two lane contracts. It does not assert on the
fixture's prose. The structural properties it does depend on:

- every checkpoint in `accountCore.checkpoints` is closed, so a Story can cover
  each one exactly once;
- every checkpoint can be cited through a decision, an uncertainty, a plan step
  or a ledger row, and at least one checkpoint carries a decision;
- `accountCore.ledger` has at least one row, so a Part citation can acknowledge
  it and a disposition other than `OUTSTANDING` survives the render;
- `file_index` lists at least two distinct non-capture paths; the tests take the
  first as the primary anchored file and anchor forensic findings only to
  non-capture paths.

## Regenerating

Rebuild the two files per subject from the content model above, then validate
each against the producer schema it claims to satisfy:

1. Build a `DossierV1` and an `AccountProjection` at `DOSSIER_SCHEMA_VERSION`,
   preserving the properties listed above.
2. Parse both with `dossierV1Schema` and `accountProjectionSchema` (exported
   from `src/dossier.ts`). They are strict, so an unknown or missing key fails
   loudly rather than reaching the tests.
3. Write each as pretty-printed JSON and gzip it. The `.gz` members are
   excluded from formatting.
4. Run `src/twolaneSlice.test.ts`.
