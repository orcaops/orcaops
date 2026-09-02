import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_SCOPED_CITATION_KINDS,
  CITATION_KIND,
  COMMENT_AUTHOR,
  COMMENT_STATUS,
  COMPLETION_GLYPH,
  COMPLETION_STATE,
  COVERAGE_VERDICT,
  DIFF_SIDE,
  FINDING_DISPOSITION,
  FINDING_KIND,
  FINDING_ORIGIN,
  FINDING_SCOPE,
  LANDMARK,
  LANDMARK_GLYPH,
  PROMPT_DISPOSITION,
  PROMPT_STATE,
  REVIEW_ITEM_STATE,
  REVIEWABLE_VERDICTS,
  SEVERITY,
  STATEMENT_SHAPE,
  THREAD_DISPOSITION,
  UNASSIGNED_INSPECTION_ACTION,
  UNCERTAINTY_DISPOSITION,
  UNCERTAINTY_STATE,
} from './enums.js';

// These tests pin the vocabulary contract exactly. A diff here means the
// contract itself changed — treat it as such.
const sorted = (v: readonly string[]) => [...v].sort();

describe('vocabulary — exact member sets', () => {
  it('7 finding kinds', () => {
    expect(sorted(Object.values(FINDING_KIND))).toEqual(
      sorted([
        'CAPTURE_GAP',
        'STALE_EVIDENCE',
        'UNRESOLVED_UNCERTAINTY',
        'VERIFICATION_GAP',
        'CAPTURE_QUALITY_GAP',
        'INTENT_DIVERGENCE',
        'SCOPE_DEVIATION',
      ])
    );
  });

  it('finding scope / origin', () => {
    expect(sorted(Object.values(FINDING_SCOPE))).toEqual(['CAPTURE', 'CODE']);
    expect(sorted(Object.values(FINDING_ORIGIN))).toEqual(['CANDIDATE_PROMOTED', 'LLM_NATIVE']);
  });

  it('severity levels', () => {
    expect(sorted(Object.values(SEVERITY))).toEqual(['CAUTION', 'CRITICAL', 'INFO', 'REVIEW']);
  });

  it('coverage verdicts, reviewable = MATCHED + UNEXPLAINED', () => {
    expect(sorted(Object.values(COVERAGE_VERDICT))).toEqual([
      'EXCLUDED',
      'MATCHED',
      'UNEXPLAINED',
      'UNREVIEWABLE',
    ]);
    expect(sorted(REVIEWABLE_VERDICTS)).toEqual(['MATCHED', 'UNEXPLAINED']);
  });

  it('completion states + glyphs', () => {
    expect(sorted(Object.values(COMPLETION_STATE))).toEqual([
      'partial',
      'reviewed',
      'skipped',
      'unread',
      'visited',
    ]);
    expect(COMPLETION_GLYPH.unread).toBe('○');
    expect(COMPLETION_GLYPH.visited).toBe('◐');
    expect(COMPLETION_GLYPH.partial).toBe('⊙');
    expect(COMPLETION_GLYPH.reviewed).toBe('✓');
    expect(COMPLETION_GLYPH.skipped).toBe('⊘');
  });

  it('dispositions — finding / section / uncertainty (no dismiss)', () => {
    expect(sorted(Object.values(FINDING_DISPOSITION))).toEqual([
      'ACKNOWLEDGE',
      'DISMISS',
      'REOPEN',
      'RESOLVE',
    ]);
    expect(sorted(Object.values(THREAD_DISPOSITION))).toEqual(['PARTIAL', 'SKIP', 'VISIT']);
    expect(sorted(Object.values(UNCERTAINTY_DISPOSITION))).toEqual([
      'ACKNOWLEDGE',
      'REOPEN',
      'RESOLVE',
    ]);
    expect(Object.values(UNCERTAINTY_DISPOSITION)).not.toContain('DISMISS');
    expect(sorted(Object.values(UNCERTAINTY_STATE))).toEqual(['ACKNOWLEDGED', 'OPEN', 'RESOLVED']);
  });

  it('statement shapes', () => {
    expect(sorted(Object.values(STATEMENT_SHAPE))).toEqual([
      'GROUNDED',
      'RECORDED_UNCERTAINTY',
      'SYNTHESIS',
    ]);
  });

  it('landmarks + glyphs', () => {
    expect(sorted(Object.values(LANDMARK))).toEqual([
      'CROSS_THREAD',
      'IN_SCOPE_UNEXPLAINED',
      'LATER_TOUCH',
      'OFF_PLAN',
      'PLAN_REVISION',
    ]);
    expect(LANDMARK_GLYPH.PLAN_REVISION).toBe('↺');
    expect(LANDMARK_GLYPH.CROSS_THREAD).toBe('⇄');
    expect(LANDMARK_GLYPH.OFF_PLAN).toBe('◇');
    expect(LANDMARK_GLYPH.LATER_TOUCH).toBe('↩');
    expect(LANDMARK_GLYPH.IN_SCOPE_UNEXPLAINED).toBe('⊘');
  });

  /**
   * The pin is a tripwire for accidental contract growth, not a freeze —
   * widening it is legitimate when new captured provenance needs plumbing.
   * Every compose consumer filters citations through an explicit kind
   * allowlist, so an added kind is inert there until a consumer opts in.
   */
  it('12 citation kinds', () => {
    expect(sorted(Object.values(CITATION_KIND))).toEqual([
      'ACCEPTANCE_CRITERION',
      'CHECKPOINT_ALTERNATIVE',
      'CHECKPOINT_DECISION',
      'CHECKPOINT_UNCERTAINTY',
      'CHECKPOINT_VERIFICATION',
      'CRITERION_EVIDENCE',
      'EVALUATOR_RUN',
      'PLAN_ALTERNATIVE',
      'PLAN_DECISION',
      'PLAN_NON_GOAL',
      'PLAN_STEP',
      'SUMMARY',
    ]);
  });

  /**
   * The cp-scoping split drives `formatCitationId`'s cp-required /
   * cp-forbidden throw, so it is pinned alongside the kind list: an
   * artifact-scoped kind that drifts into this set starts throwing on every
   * plan-level citation, and a checkpoint-scoped one that drifts out mints ids
   * with no locus.
   */
  it('checkpoint-scoped kinds are exactly the five with a cp locus', () => {
    expect(sorted([...CHECKPOINT_SCOPED_CITATION_KINDS])).toEqual([
      'CHECKPOINT_ALTERNATIVE',
      'CHECKPOINT_DECISION',
      'CHECKPOINT_UNCERTAINTY',
      'CHECKPOINT_VERIFICATION',
      'CRITERION_EVIDENCE',
    ]);
  });

  it('comment status + author, diff side', () => {
    expect(sorted(Object.values(COMMENT_STATUS))).toEqual(['open', 'resolved']);
    expect(sorted(Object.values(COMMENT_AUTHOR))).toEqual(['agent', 'reviewer']);
    expect(sorted(Object.values(DIFF_SIDE))).toEqual(['add', 'delete']);
  });

  it('review item states', () => {
    expect(sorted(Object.values(REVIEW_ITEM_STATE))).toEqual([
      'ACKNOWLEDGED',
      'CONFLICT',
      'DISMISSED',
      'INFORMATIONAL',
      'INSPECTED',
      'OPEN',
      'RESOLVED',
      'STALE',
    ]);
  });

  it('pins v2 prompt, coverage, and Unassigned state actions', () => {
    expect(sorted(Object.values(PROMPT_DISPOSITION))).toEqual([
      'ACKNOWLEDGE',
      'DISMISS',
      'REOPEN',
      'RESOLVE',
    ]);
    expect(sorted(Object.values(PROMPT_STATE))).toEqual([
      'ACKNOWLEDGED',
      'DISMISSED',
      'OPEN',
      'RESOLVED',
    ]);
    expect(Object.values(UNASSIGNED_INSPECTION_ACTION)).toEqual(['MARK_INSPECTED']);
  });
});
