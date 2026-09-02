import { describe, expect, it } from 'vitest';

import { orcaopsCaptureSkill } from './orcaops-capture.js';
import { orcaopsCheckpointSkill } from './orcaops-checkpoint.js';
import { orcaopsFinishSkill } from './orcaops-finish.js';
import { orcaopsPrePrSkill } from './orcaops-pre-pr.js';
import { orcaopsSummarySkill } from './orcaops-summary.js';
import { DEFAULT_PREFIX } from '../refs.js';
import type { SkillTemplate } from '../types.js';

/** A skill body is `string | ((prefix) => string)`; resolve to the default-prefix text. */
const bodyText = (s: SkillTemplate): string =>
  typeof s.body === 'function' ? s.body(DEFAULT_PREFIX) : s.body;

/**
 * Pins skill-body ergonomics so they can't silently regress:
 *   - the policy_exceptions example uses the pack-prefixed ref.
 *   - no skill hand-supplies an idempotency_key (it's auto-minted).
 *   - pre-pr does not present artifact_id as the sole required input.
 */
const mutatingSkills = [
  orcaopsCaptureSkill,
  orcaopsCheckpointSkill,
  orcaopsSummarySkill,
  orcaopsPrePrSkill,
];

describe('skill-body ergonomics', () => {
  it('policy_exceptions example uses the pack-prefixed evaluator ref', () => {
    expect(bodyText(orcaopsCheckpointSkill)).toContain('core/checkpoint-scope-density');
    // No bare-name policy_exceptions example — the matcher requires the prefix.
    expect(bodyText(orcaopsCheckpointSkill)).not.toMatch(
      /"evaluator":\s*"checkpoint-scope-density"/
    );
  });

  it('no mutating-capture skill hand-supplies an idempotency_key heredoc', () => {
    for (const skill of mutatingSkills) {
      expect(bodyText(skill), skill.id).not.toMatch(/"idempotency_key":\s*"</);
      expect(bodyText(skill), skill.id).not.toMatch(/never\*{0,2}\s*omit it/i);
    }
  });

  it('pre-pr presents artifact_id as optional, not the entire input', () => {
    expect(bodyText(orcaopsPrePrSkill)).not.toContain('the entire input');
    expect(bodyText(orcaopsPrePrSkill)).toMatch(/artifact_id[^\n]*optional/i);
  });

  it('summary skill documents the supersede token + error codes', () => {
    const body = bodyText(orcaopsSummarySkill);
    expect(body).toContain('SUMMARY_ALREADY_CAPTURED');
    expect(body).toContain('prior_summary_event_id');
    expect(body).toContain('STALE_SUMMARY');
  });

  it('finish limits amendments to wording-only replacements', () => {
    const body = bodyText(orcaopsFinishSkill);
    expect(body).toContain('prior_summary_event_id');
    expect(body).toContain('repeat every previously accepted warning exactly');
    expect(body).toMatch(/Adding, removing, or changing an\s+acceptance is refused/);
  });

  it('closing skills distinguish pauses from finalized digest results', () => {
    const finish = bodyText(orcaopsFinishSkill);
    expect(finish).toContain('`status: needs_attention`');
    expect(finish).toContain('`finalization_status` is absent when finish pauses');
    expect(finish).toContain('`idempotency_status: replay`');

    const summary = bodyText(orcaopsSummarySkill);
    expect(summary).toContain('A successful summary automatically materializes');
    expect(summary).toContain('`finalization_status: finalized_without_digest`');
    expect(summary).not.toContain('Immediately run:');
  });

  it('--source-plan is attach-by-default with out-of-repo + materialize-then-pin', () => {
    const body = bodyText(orcaopsCaptureSkill);
    // attach-by-default reframe (the "optional" framing is gone from this section)
    expect(body).toContain('if a plan document exists anywhere, pass');
    // out-of-repo blessed + the confabulated excuse named verbatim
    expect(body).toContain('Out-of-repo paths are fully supported');
    expect(body).toContain('is never a reason to skip the pin');
    // the observed failure response is forbidden
    expect(body).toContain('never respond to a path error by re-running');
    // materialize-then-pin + now-or-never
    expect(body).toContain('to a temp file and pin that');
    expect(body).toContain('The pin happens at initial capture only');
  });
});
