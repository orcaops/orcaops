// Task Review vocabulary contract.
//
// These are the canonical tokens the floor, narrative, journal, comments,
// validator, and TUI key off. Do not rename, add, or drop members without
// changing the contract itself. `enums.test.ts` pins the exact member sets so
// an accidental edit fails loudly.
//
// Casing follows the contract: kinds/severities/dispositions are UPPER
// tokens; completion states and comment status are lowercase (as printed in
// the contract). Each enum is a frozen object so `z.enum(X)` in `schema.ts`
// consumes it directly, and the paired union type is derived from its values.

/** Review items — the 7 finding kinds. */
export const FINDING_KIND = {
  CAPTURE_GAP: 'CAPTURE_GAP',
  STALE_EVIDENCE: 'STALE_EVIDENCE',
  UNRESOLVED_UNCERTAINTY: 'UNRESOLVED_UNCERTAINTY',
  VERIFICATION_GAP: 'VERIFICATION_GAP',
  CAPTURE_QUALITY_GAP: 'CAPTURE_QUALITY_GAP',
  INTENT_DIVERGENCE: 'INTENT_DIVERGENCE',
  SCOPE_DEVIATION: 'SCOPE_DEVIATION',
} as const;
export type FindingKind = (typeof FINDING_KIND)[keyof typeof FINDING_KIND];

/** Finding scope — whether the concern is about the code or the capture. */
export const FINDING_SCOPE = {
  CODE: 'CODE',
  CAPTURE: 'CAPTURE',
} as const;
export type FindingScope = (typeof FINDING_SCOPE)[keyof typeof FINDING_SCOPE];

/**
 * Finding origin. `CANDIDATE_PROMOTED` = surfaced deterministically by
 * the floor then narrated; `LLM_NATIVE` = raised by the compose step itself.
 * `INTENT_DIVERGENCE`/`SCOPE_DEVIATION` are only ever `LLM_NATIVE` (validator).
 */
export const FINDING_ORIGIN = {
  CANDIDATE_PROMOTED: 'CANDIDATE_PROMOTED',
  LLM_NATIVE: 'LLM_NATIVE',
} as const;
export type FindingOrigin = (typeof FINDING_ORIGIN)[keyof typeof FINDING_ORIGIN];

/** Severity — orthogonal to confidence. */
export const SEVERITY = {
  INFO: 'INFO',
  REVIEW: 'REVIEW',
  CAUTION: 'CAUTION',
  CRITICAL: 'CRITICAL',
} as const;
export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

/** Coverage verdict over the live task diff. Reviewable = MATCHED + UNEXPLAINED. */
export const COVERAGE_VERDICT = {
  MATCHED: 'MATCHED',
  UNEXPLAINED: 'UNEXPLAINED',
  EXCLUDED: 'EXCLUDED',
  UNREVIEWABLE: 'UNREVIEWABLE',
} as const;
export type CoverageVerdict = (typeof COVERAGE_VERDICT)[keyof typeof COVERAGE_VERDICT];

/** The two reviewable verdicts ("reviewable = MATCHED + UNEXPLAINED"). */
export const REVIEWABLE_VERDICTS: readonly CoverageVerdict[] = [
  COVERAGE_VERDICT.MATCHED,
  COVERAGE_VERDICT.UNEXPLAINED,
];

/** Section completion state. Lowercase tokens, as printed in the contract. */
export const COMPLETION_STATE = {
  UNREAD: 'unread',
  VISITED: 'visited',
  PARTIAL: 'partial',
  REVIEWED: 'reviewed',
  SKIPPED: 'skipped',
} as const;
export type CompletionState = (typeof COMPLETION_STATE)[keyof typeof COMPLETION_STATE];

/** Glyphs for the completion states (`○ ◐ ⊙ ✓ ⊘`). */
export const COMPLETION_GLYPH: Readonly<Record<CompletionState, string>> = {
  [COMPLETION_STATE.UNREAD]: '○',
  [COMPLETION_STATE.VISITED]: '◐',
  [COMPLETION_STATE.PARTIAL]: '⊙',
  [COMPLETION_STATE.REVIEWED]: '✓',
  [COMPLETION_STATE.SKIPPED]: '⊘',
};

/** Finding disposition actions. */
export const FINDING_DISPOSITION = {
  ACKNOWLEDGE: 'ACKNOWLEDGE',
  RESOLVE: 'RESOLVE',
  DISMISS: 'DISMISS',
  REOPEN: 'REOPEN',
} as const;
export type FindingDisposition = (typeof FINDING_DISPOSITION)[keyof typeof FINDING_DISPOSITION];

/** Section disposition actions. */
export const THREAD_DISPOSITION = {
  VISIT: 'VISIT',
  SKIP: 'SKIP',
  PARTIAL: 'PARTIAL',
} as const;
export type ThreadDisposition = (typeof THREAD_DISPOSITION)[keyof typeof THREAD_DISPOSITION];

/** Atomic v2 section-row coverage action. */
export const REVIEW_COVERAGE_ACTION = {
  RECORD_REVIEW_COVERAGE: 'RECORD_REVIEW_COVERAGE',
} as const;
export type ReviewCoverageAction =
  (typeof REVIEW_COVERAGE_ACTION)[keyof typeof REVIEW_COVERAGE_ACTION];

export const PROMPT_DISPOSITION = {
  ACKNOWLEDGE: 'ACKNOWLEDGE',
  RESOLVE: 'RESOLVE',
  DISMISS: 'DISMISS',
  REOPEN: 'REOPEN',
} as const;
export type PromptDisposition = (typeof PROMPT_DISPOSITION)[keyof typeof PROMPT_DISPOSITION];

export const PROMPT_STATE = {
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
} as const;
export type PromptState = (typeof PROMPT_STATE)[keyof typeof PROMPT_STATE];

export const UNASSIGNED_INSPECTION_ACTION = {
  MARK_INSPECTED: 'MARK_INSPECTED',
} as const;
export type UnassignedInspectionAction =
  (typeof UNASSIGNED_INSPECTION_ACTION)[keyof typeof UNASSIGNED_INSPECTION_ACTION];

/**
 * Uncertainty disposition actions — deliberately NO dismiss: "a captured
 * honest doubt is not dismissed".
 */
export const UNCERTAINTY_DISPOSITION = {
  ACKNOWLEDGE: 'ACKNOWLEDGE',
  RESOLVE: 'RESOLVE',
  REOPEN: 'REOPEN',
} as const;
export type UncertaintyDisposition =
  (typeof UNCERTAINTY_DISPOSITION)[keyof typeof UNCERTAINTY_DISPOSITION];

/** Replay-derived uncertainty state. An OPEN uncertainty gates `mark reviewed`. */
export const UNCERTAINTY_STATE = {
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
} as const;
export type UncertaintyState = (typeof UNCERTAINTY_STATE)[keyof typeof UNCERTAINTY_STATE];

/**
 * WHICH LENS THE REVIEWER ACTUALLY READ when they finished.
 *
 * `FLOOR_ONLY` is not a degraded mode. It records a completion made when no
 * current routine Story exists over the floor. `STORY` records the exact
 * content generation presented by the Story reader.
 *
 * The basis makes `story_generation` meaningfully nullable. A null generation
 * alone cannot distinguish "there was no current Story" from "the writer failed
 * to pin the Story it claims was read", so the schema binds the fields in both
 * directions.
 */
export const REVIEW_BASIS = {
  FLOOR_ONLY: 'FLOOR_ONLY',
  STORY: 'STORY',
} as const;
export type ReviewBasis = (typeof REVIEW_BASIS)[keyof typeof REVIEW_BASIS];

/** Epistemic statement shape carried by every narrative claim. */
export const STATEMENT_SHAPE = {
  GROUNDED: 'GROUNDED',
  SYNTHESIS: 'SYNTHESIS',
  RECORDED_UNCERTAINTY: 'RECORDED_UNCERTAINTY',
} as const;
export type StatementShape = (typeof STATEMENT_SHAPE)[keyof typeof STATEMENT_SHAPE];

/** Structural landmarks. */
export const LANDMARK = {
  PLAN_REVISION: 'PLAN_REVISION',
  CROSS_THREAD: 'CROSS_THREAD',
  OFF_PLAN: 'OFF_PLAN',
  LATER_TOUCH: 'LATER_TOUCH',
  IN_SCOPE_UNEXPLAINED: 'IN_SCOPE_UNEXPLAINED',
} as const;
export type Landmark = (typeof LANDMARK)[keyof typeof LANDMARK];

/** Glyphs for the landmarks (`↺ ⇄ ◇ ↩ ⊘`). */
export const LANDMARK_GLYPH: Readonly<Record<Landmark, string>> = {
  [LANDMARK.PLAN_REVISION]: '↺',
  [LANDMARK.CROSS_THREAD]: '⇄',
  [LANDMARK.OFF_PLAN]: '◇',
  [LANDMARK.LATER_TOUCH]: '↩',
  [LANDMARK.IN_SCOPE_UNEXPLAINED]: '⊘',
};

/** Citation kinds — what a `cite:` id can point at in the captured record. */
export const CITATION_KIND = {
  CHECKPOINT_DECISION: 'CHECKPOINT_DECISION',
  CHECKPOINT_UNCERTAINTY: 'CHECKPOINT_UNCERTAINTY',
  /**
   * A rejected alternative recorded on a checkpoint decision
   * (`alternatives_considered`) — the RULED-OUT evidence. Rendered by the
   * two-lane account, the Watch detail pane, and its reader model.
   */
  CHECKPOINT_ALTERNATIVE: 'CHECKPOINT_ALTERNATIVE',
  /**
   * Evidence recorded at checkpoint close for one plan-time acceptance
   * criterion (`done_criteria[].evidence`). Carries `parent` = the
   * `ACCEPTANCE_CRITERION` citation its `criterion_id` resolves to; the
   * parent is ABSENT when the criterion is not in scope (a criterion dropped
   * by a later plan revision), and the evidence still rides.
   */
  CRITERION_EVIDENCE: 'CRITERION_EVIDENCE',
  /**
   * One verified-close evidence record (`verification[]`): a command the agent
   * ran fresh at close and its exit code. Checkpoint-grain PROOF that a
   * completion claim was exercised — distinct from `EVALUATOR_RUN`, which is
   * the artifact-scoped evaluator verdict log.
   */
  CHECKPOINT_VERIFICATION: 'CHECKPOINT_VERIFICATION',
  PLAN_STEP: 'PLAN_STEP',
  PLAN_NON_GOAL: 'PLAN_NON_GOAL',
  /**
   * A plan-time architectural decision (`plan.decisions`) — the choice captured
   * where it is made, distinct from the per-chunk `CHECKPOINT_DECISION`.
   * Artifact-scoped: a plan decision belongs to a plan revision, not a
   * checkpoint.
   */
  PLAN_DECISION: 'PLAN_DECISION',
  /**
   * A rejected alternative recorded on a PLAN decision. A separate kind from
   * `CHECKPOINT_ALTERNATIVE` is structural, not cosmetic: alternative kinds
   * inherit their parent's scoping, and `formatCitationId` throws for a
   * checkpoint-scoped kind with a null `cp`.
   */
  PLAN_ALTERNATIVE: 'PLAN_ALTERNATIVE',
  ACCEPTANCE_CRITERION: 'ACCEPTANCE_CRITERION',
  SUMMARY: 'SUMMARY',
  EVALUATOR_RUN: 'EVALUATOR_RUN',
} as const;
export type CitationKind = (typeof CITATION_KIND)[keyof typeof CITATION_KIND];

/**
 * Citation kinds that are scoped to a specific checkpoint (their `cite:` id
 * carries a `cp<n>` locus). The rest are artifact-scoped. The citation-id
 * grammar in `keys.ts` enforces this split.
 */
export const CHECKPOINT_SCOPED_CITATION_KINDS: readonly CitationKind[] = [
  CITATION_KIND.CHECKPOINT_DECISION,
  CITATION_KIND.CHECKPOINT_UNCERTAINTY,
  CITATION_KIND.CHECKPOINT_ALTERNATIVE,
  CITATION_KIND.CRITERION_EVIDENCE,
  CITATION_KIND.CHECKPOINT_VERIFICATION,
];

/** Reviewer comment status. Local-first concept; lowercase tokens. */
export const COMMENT_STATUS = {
  OPEN: 'open',
  RESOLVED: 'resolved',
} as const;
export type CommentStatus = (typeof COMMENT_STATUS)[keyof typeof COMMENT_STATUS];

/** Comment glyph (`✎`). */
export const COMMENT_GLYPH = '✎';

/** Who authored a comment or reply — the reviewer, or the agent responding via the skill. */
export const COMMENT_AUTHOR = {
  REVIEWER: 'reviewer',
  AGENT: 'agent',
} as const;
export type CommentAuthor = (typeof COMMENT_AUTHOR)[keyof typeof COMMENT_AUTHOR];

/**
 * Diff side for a line anchor. Tokens match the line-hash primitive's `kind`
 * argument (`'add' | 'delete'`) so an anchor feeds `lineHash` with no mapping.
 */
export const DIFF_SIDE = {
  ADD: 'add',
  DELETE: 'delete',
} as const;
export type DiffSide = (typeof DIFF_SIDE)[keyof typeof DIFF_SIDE];

/** Normalized review-item state. Source-specific actions decide which transitions are legal. */
export const REVIEW_ITEM_STATE = {
  INFORMATIONAL: 'INFORMATIONAL',
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
  INSPECTED: 'INSPECTED',
  STALE: 'STALE',
  CONFLICT: 'CONFLICT',
} as const;
export type ReviewItemState = (typeof REVIEW_ITEM_STATE)[keyof typeof REVIEW_ITEM_STATE];
