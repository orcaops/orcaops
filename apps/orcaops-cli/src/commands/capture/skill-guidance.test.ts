import { describe, expect, it } from 'vitest';

import { orcaopsCaptureSkill, orcaopsPrePrSkill, type SkillTemplate } from '@orcaops/adapters';
import { EvaluatorRunPayloadSchema } from '@orcaops/evaluator-protocol';

const bodyText = (skill: SkillTemplate): string =>
  typeof skill.body === 'function' ? skill.body('orcaops') : skill.body;

describe('evaluator result guidance', () => {
  it('uses fields accepted by the evaluator-run schema', () => {
    const run = EvaluatorRunPayloadSchema.parse({
      schema: 'orcaops.evaluator_run/v1',
      run_id: '01a0698f-59d4-77ea-8eaf-a44dd3fd496d',
      artifact_id: '01a0698f-55e2-7387-83d3-e2d4210caa26',
      evaluator_ref: 'core/plan-conformance-pre-pr',
      package_id: 'core',
      evaluator_id: 'plan-conformance-pre-pr',
      phase: 'pre-pr',
      severity: 'warn',
      run_status: 'completed',
      verdict: 'violation',
      body: 'VIOLATION',
      ts: '2026-09-03T23:16:37.460Z',
    });

    for (const skill of [orcaopsCaptureSkill, orcaopsPrePrSkill]) {
      const body = bodyText(skill);
      for (const field of ['evaluator_ref', 'run_status', 'verdict'] as const) {
        expect(body, `${skill.id}: ${field}`).toContain(`"${field}"`);
        expect(run[field]).toBeDefined();
      }
      expect(body, skill.id).not.toMatch(/"evaluator"\s*:/);
      expect(body, skill.id).not.toMatch(/"status"\s*:\s*"violation"/);
    }
  });
});
