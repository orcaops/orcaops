# Review truth and anchor-contract confirmation protocol

This protocol was frozen before any confirmation review or semantic-anchor
output was generated. It confirms the merge-blocking deterministic truth and
anchor-authoring contracts. It is not a diff-only comparison, a general review
optimization exercise, or a product-readiness claim for semantic anchors.

## Frozen execution

- Use only the branch-built CLI and canonical task-review skill recorded in
  `FREEZE.json`; never substitute a global installation.
- Export the recorded `ORCAOPS_BUILD_COMMIT` and `ORCAOPS_BUILD_DIRTY` values so
  every run reports the frozen build identity. Absolute paths are diagnostic;
  the runtime fingerprint is the comparison identity.
- Pass the frozen field-level execution profile at routine start. Every value is
  `EVALUATION_REGISTERED`; unknown host facts remain null.
- Perform one capture-blind ordered forensic pass, one ordered account pass, and
  an opt-in ordered semantic-anchor pass after successful finalization.
- One repair is available independently to each lane and anchor generation. Do
  not mint replacement runs or generations to evade a terminal attempt budget.
- Recheck each subject's branch, HEAD, committed diff, tracked working diff,
  status, untracked inventory, and config before and after its run. Stop on
  drift.
- Do not change code, schemas, skill text, profile, subjects, policy, ceilings,
  rubric, or model settings after the first run begins. A change invalidates the
  complete affected round and requires a newly committed freeze.
- The confirmation fixture directory is covered by the repository's explicit
  `packages/review-engine/fixtures/**` stub policy. It is harness evidence, not
  eligible review text, and must remain disclosed in the exclusion inventory.

## Mechanical gates

These are deterministic engine properties. They do not assess semantic truth.

1. Every finalized run with composed ownership reports a non-null summary whose
   partitions satisfy:

   `reviewable_rows = attributed_rows + ambiguous_rows + contested_rows + unattributed_rows`

   The final response and immutable run record must match exactly. A failed run
   without composed ownership must keep the summary null.

2. Every finalized run records the UTF-8 byte count of the policy-eligible
   forensic diff, the exact decimal-byte tier and budget, elapsed milliseconds,
   and PASS/MISSED status. The frozen subjects must not silently change tiers.
3. Every command reports the frozen runtime fingerprint. Paths may differ, but
   fingerprint drift, source-commit drift, or dirty-state drift blocks the set.
   Field-level execution-profile values and their provenance must round-trip.
4. READY anchor preparation uses receipt/input schema v4 and the complete
   policy-eligible target space. Historical prepared inputs are unsupported,
   never migrated or interpreted as current.
5. Semantic submissions, attempts, targets, models, manifests, and pointers are
   schema v3. Immutable installation and current-generation rerender validation
   must pass without fallback to historical generations.
6. Authored submissions may be sparse, but the installed model contains every
   eligible item exactly once as ANCHORED, ASSESSED_UNANCHORED, or
   NO_ANCHOR_PROPOSED with the required epistemic origin. The confirmation must
   exercise at least one neutral omission.
7. Every positive target explicitly records WHOLE_BLOCK or FOCUS. FOCUS may
   contain both delete and add sides. If a well-shaped focus is geometrically
   invalid, the block association remains installed with null focus,
   REJECTED_INVALID status, and a structured warning; malformed scope or unknown
   blocks still reject.
8. The large stub-heavy subject must reach READY when its complete
   policy-eligible payload fits the profile even though its full pinned diff is
   above the transport ceiling. Excluded files remain a per-file disclosure and
   never re-enter model input.
9. Clean first-pass, normalized first-pass, accepted-with-focus-warning,
   repaired, and terminal outcomes are recorded separately for forensic,
   account, and semantic submissions.

## Human-adjudicated semantic gates

The engine does not decide these. Adjudication uses the installed Story and
anchor model only after the run is mechanically valid.

1. Each overview is an accurate branch-head summary grounded in
   verification-grade evidence for proof/completion claims. It must agree with
   every Act and Part and must not turn successful current-run acceptance into a
   stale absence question.
2. The synthetic stub-heavy Story keeps the preregistered handoff -> execution
   -> verdict relationship explicit and contiguous as one Part, adjacent Parts
   in one Act, or adjacent Acts with an explicit phase transition.
3. In the synthetic library patch, direct decisions about `onRecordUpdate`,
   omitted-field insert behavior, and deterministic update tests navigate to
   the relevant implementation or test blocks. Focus usefulness is scored
   separately from correct block association.
4. Rejected `buildUpdateSet` alternatives have no ANCHORED target unless changed
   code explicitly encodes the rejection constraint. The chosen implementation
   alone is insufficient evidence.
5. Statements that backend A/B tests were not executed locally, future
   validation, evaluation limitations, and other process/absence claims have no
   ANCHORED target unless changed code directly enforces the statement.
6. Code-specific uncertainties may associate broadly with the implementation or
   test block that creates the described condition. Such navigation does not
   mark the uncertainty resolved.

## Subject-specific expectations

### Synthetic library patch

- The known backend A/B falsy-static-default defect remains a directional
  forensic ranking challenge, not a deterministic discovery gate.
- A contradicted finding, invalid related-files structure, lifecycle failure,
  or false direct association blocks. Missing the known bug is recorded but does
  not trigger tuning inside the frozen set.

### Synthetic stub-heavy repository

- Successful Story authoring and Story -> READY preparation are mandatory; this
  closes the previously unscored gate.
- The handoff -> execution -> verdict semantic gate is mandatory.
- The prepared payload must use the policy-eligible diff and disclose the large
  excluded inventory without serving its text.

### Synthetic active changeset

- The overview must describe the completed truthfulness and anchor-contract arc,
  not merely enumerate checkpoints.
- At least one sparse omission and both target scopes must be exercised across
  the confirmation set; this subject may supply whichever case the earlier runs
  did not naturally produce.

## Stop and result rules

- Stop a subject on drift, an unhealthy floor, a typed size refusal that
  contradicts the frozen profile, exhausted lane repair, corrupt current
  generation, or runtime fingerprint mismatch.
- Record raw counts, hashes, timing, normalization, warnings, repair use, and
  human decisions. Do not summarize percentages without denominators.
- Mechanical failure blocks confirmation. A human semantic failure blocks only
  the named semantic gate, but no implementation change is permitted until all
  three frozen runs finish and the failed round is preserved.
- If any tuning is chosen afterward, commit a new protocol freeze and execute a
  fresh full round. Never replace or rewrite this evidence.
