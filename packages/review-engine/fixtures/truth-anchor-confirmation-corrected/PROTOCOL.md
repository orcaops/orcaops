# Corrected review truth and anchor-contract confirmation protocol

This second protocol was frozen after the first immutable confirmation round
identified two deterministic contract defects. The first round remains at
`truth-anchor-confirmation`; this round verifies only the committed
corrections and the original merge-blocking gates. It is not a
diff-only comparison, general review optimization exercise, or semantic-anchor
product-readiness claim.

## Frozen execution

- Use only the branch-built CLI and canonical task-review skill recorded in
  `FREEZE.json`; never substitute a global installation.
- Export the recorded `ORCAOPS_BUILD_COMMIT` and `ORCAOPS_BUILD_DIRTY` values.
  Absolute paths remain diagnostic. The path-independent runtime fingerprint
  and compiled-runtime manifest hash are the executable-content identity.
- Pass the frozen field-level execution profile at routine start. Every known
  value is `EVALUATION_REGISTERED`; unknown host facts remain null.
- Perform one capture-blind ordered forensic pass, one ordered account pass,
  and an opt-in ordered semantic-anchor pass after successful finalization.
- One repair remains available independently to each lane and anchor
  generation. Do not mint replacements to evade a terminal attempt budget.
- Recheck branch, HEAD, committed diff, tracked working diff, status, untracked
  inventory, and config before and after every subject. Stop on drift.
- Do not change implementation, schemas, skill text, profile, subjects,
  policy, ceilings, rubric, or model settings after this freeze is committed.
  Any change invalidates the complete round and requires a new freeze.
- Both confirmation fixture directories are covered by the explicit
  `packages/review-engine/fixtures/**` stub policy. They must remain disclosed
  harness evidence rather than model-served review text.

## Mechanical gates

These are deterministic engine properties. They do not assess semantic truth.

1. Every finalized run with composed ownership reports a non-null summary whose
   partitions satisfy:

   `reviewable_rows = attributed_rows + ambiguous_rows + contested_rows + unattributed_rows`

   The response and immutable run record must match. Failed runs without
   composed ownership keep the summary null.

2. Every finalized run records policy-eligible forensic input bytes, exact
   decimal-byte tier and budget, elapsed milliseconds, and PASS/MISSED status.
   A budget miss is retained as measured evidence, not rewritten as success.
3. Every command reports the frozen path-independent runtime fingerprint and
   compiled-runtime manifest hash. The identity must bind the CLI package and
   recursive internal-package compiled `dist` closure, remain stable across
   equivalent installation paths, and match from start through anchoring.
   Source-commit or dirty-state drift blocks the set. Field-level execution
   profile values and provenance must round-trip.
4. Authored Story input and installed StoryReviewModel v3 apply the same
   8-word/120-Unicode-codepoint title contract. Historical v2 reading remains
   an explicit compatibility path rather than weakening v3 validation.
5. READY anchor preparation uses receipt/input schema v4 and the complete
   policy-eligible target space. Historical prepared inputs are unsupported,
   never migrated or interpreted as current.
6. Semantic submissions, attempts, targets, models, manifests, and pointers use
   schema v3. Immutable installation and current-generation rerender validation
   must pass without fallback to historical generations.
7. Authored semantic submissions may be sparse, but every installed model
   contains each eligible item exactly once as ANCHORED,
   ASSESSED_UNANCHORED, or NO_ANCHOR_PROPOSED with its required epistemic
   origin. The set must exercise at least one neutral omission.
8. Every positive target explicitly records WHOLE_BLOCK or FOCUS. A valid
   two-sided focus is resolved atomically. Geometrically invalid optional focus
   preserves the block with structured REJECTED_INVALID state; malformed scope
   or unknown blocks still reject.
9. The stub-heavy subject must reach READY from its complete policy-eligible
   payload even though its full pinned diff exceeds the transport ceiling.
   Excluded files remain per-file disclosures and never re-enter model input.
10. Clean first-pass, normalized first-pass, accepted-with-focus-warning,
    repaired, and terminal outcomes are reported separately for forensic,
    account, and semantic submissions.

## Human-adjudicated semantic gates

The engine does not decide these. Adjudication uses only mechanically valid,
installed Story and anchor models.

1. Every overview accurately represents branch-head behavior, grounds proof or
   completion claims in verification-grade evidence, agrees with all Acts and
   Parts, and does not turn successful current-run acceptance into a stale
   absence question.
2. The synthetic stub-heavy Story keeps the preregistered handoff -> execution
   -> verdict relation explicit and contiguous as one Part, adjacent Parts in
   one Act, or adjacent Acts with an explicit phase transition.
3. In the synthetic library patch, direct decisions about `onRecordUpdate`,
   omitted-field insert behavior, and deterministic update tests navigate to
   relevant implementation or test blocks. Focus usefulness is separate from
   block correctness.
4. Rejected `buildUpdateSet` alternatives have no ANCHORED target unless changed
   code explicitly encodes the rejection constraint. The chosen implementation
   alone is insufficient evidence.
5. Statements that backend A/B tests were not executed locally, future
   validation, evaluation limitations, and other process/absence claims have no
   ANCHORED target unless changed code directly enforces the statement.
6. Code-specific uncertainties may navigate broadly to the implementation or
   test block that creates the described condition. Navigation never marks an
   uncertainty resolved.

## Subject-specific expectations

### Synthetic library patch

- The known backend A/B falsy-static-default defect remains a directional
  forensic ranking challenge, not a deterministic discovery gate.
- A contradicted finding, malformed related-files structure, lifecycle failure,
  or false direct association blocks. A miss is recorded without tuning.

### Synthetic stub-heavy repository

- Story authoring, the handoff -> execution -> verdict relation, and Story ->
  READY preparation are mandatory.
- The payload must serve the policy-eligible diff and disclose the excluded
  inventory without serving excluded text.

### Synthetic active changeset

- The overview must describe the completed truthfulness and anchor-contract arc
  rather than enumerate checkpoints.
- The forensic lane must no longer report the two corrected deterministic
  defects from the first round.
- At least one sparse omission and both target scopes must be exercised across
  the three subjects.

## Stop and result rules

- Stop a subject on identity drift, unhealthy floor, unexpected size refusal,
  exhausted lane repair, corrupt current generation, or runtime fingerprint or
  compiled-manifest mismatch.
- Record raw counts, hashes, timing, normalization, warnings, repair use, and
  human decisions. Do not report percentages without denominators.
- Mechanical failure blocks confirmation. Human semantic failure blocks only
  its named gate, but no tuning is permitted until all three runs finish and
  the round is preserved.
- The corrected round passes only if every original mechanical and semantic
  gate passes. It never erases or rewrites the first failed round.
