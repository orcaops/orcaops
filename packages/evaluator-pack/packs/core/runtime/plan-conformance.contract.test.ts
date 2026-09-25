import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvaluatorResultEnvelopeV2Schema, EvaluatorSchema } from '@orcaops/evaluator-protocol';
import { makeContext, makePlanStep, runLlmFixture } from '@orcaops/evaluator-sdk';

import { respond } from './_test-llm-response.js';

/**
 * LLM contract test for the three core/plan-conformance-* siblings.
 * LLM evaluators can't be exercised by runFixture (no recorded
 * cassettes), so the contract scope is the static surface:
 *
 *   1. Each spec YAML parses against EvaluatorSchema, at the right phase.
 *   2. engine.kind === 'llm', severity === 'warn', and — critically —
 *      filters.when_llm === 'required' so the spec explicitly declares that
 *      these checks require an executed provider. The runner records a skip
 *      whenever an LLM engine has no provider.
 *   3. All three share ONE prompt file, and it exists.
 *   4. A synthetic envelope (the shape the judge emits) validates.
 *
 * Live LLM behaviour (the no-source-plan INFO short-circuit, the
 * declared-exclusion-vs-silent-gap rubric) is exercised at the CLI capture
 * layer with a real client; this guards the spec layer.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../packs/core');

const SPECS = [
  { file: 'plan-conformance-post-plan.eval.yaml', phase: 'post-plan' },
  { file: 'plan-conformance-revision.eval.yaml', phase: 'post-plan-revision' },
  { file: 'plan-conformance-pre-pr.eval.yaml', phase: 'pre-pr' },
] as const;

const SHARED_PROMPT = 'prompts/plan-conformance.prompt.md';
const sharedPrompt = readFileSync(path.resolve(packRoot, SHARED_PROMPT), 'utf8');

const COVERING_STEP = makePlanStep(1, 'rate-limit the token endpoint');

const fixture = (response: string) =>
  runLlmFixture({
    context: makeContext({
      evaluator_ref: 'core/plan-conformance-pre-pr',
      phase: 'pre-pr',
      plan: { ...makeContext().plan, plan_steps: [COVERING_STEP] },
    }),
    promptBody: sharedPrompt,
    additionalContextSections: ['source-plan', 'acceptance-criteria'],
    response,
  });

describe('core/plan-conformance-* (LLM contract)', () => {
  for (const { file, phase } of SPECS) {
    describe(file, () => {
      const specPath = path.join(packRoot, 'evaluators', file);

      it('parses against EvaluatorSchema at the expected phase', () => {
        const parsed = EvaluatorSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
        expect(parsed.phase).toBe(phase);
        expect(parsed.severity).toBe('warn');
      });

      it('id honours the `plan-conformance-` stem (the digest hoist depends on it)', () => {
        // The digest (isPlanConformanceRef) identifies conformance evaluators
        // by the `/plan-conformance-` substring to hoist their row. A rename
        // that drops the stem would silently stop hoisting — guard it here.
        // Feeding the pinned plan no longer depends on the name: that follows
        // the spec's `additional_context_sections: [source-plan]`.
        const parsed = EvaluatorSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
        expect(parsed.id.startsWith('plan-conformance-')).toBe(true);
      });

      it('is an LLM engine sharing the conformance prompt, gated when_llm=required', () => {
        const parsed = EvaluatorSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
        expect(parsed.engine.kind).toBe('llm');
        if (parsed.engine.kind !== 'llm') throw new Error('unreachable');
        expect(parsed.engine.prompt_file).toBe(SHARED_PROMPT);
        expect(parsed.engine.additional_context_sections).toEqual([
          'source-plan',
          'acceptance-criteria',
        ]);
        // Keep the provider requirement explicit in the evaluator contract;
        // the runner also enforces it from engine.kind at dispatch time.
        expect(parsed.filters?.when_llm).toBe('required');
        // 120s timeout: a large source-plan pin (~56KB) exceeded
        // the 30s default and errored with no verdict. Lock the override so a
        // regression back to the default is caught at the spec layer.
        expect(parsed.engine.timeout_ms).toBe(120000);
      });
    });
  }

  it('the shared prompt file exists', () => {
    expect(existsSync(path.resolve(packRoot, SHARED_PROMPT))).toBe(true);
  });

  it('requires per-obligation rubric representation and makes omissions violations', () => {
    expect(sharedPrompt).toContain('Judge this per obligation, not per step');
    expect(sharedPrompt).toMatch(
      /A step marked `NO ACCEPTANCE CRITERIA RECORDED`\s+represents nothing/
    );
    expect(sharedPrompt).toMatch(
      /unrepresented in the rubric[\s\S]+this evaluator warns rather than blocks/
    );
    expect(sharedPrompt).toContain(
      '- **unrepresented:** "<source obligation>" — planned by step "<step label>"'
    );
  });

  it('synthetic conformance envelope validates against EvaluatorResultEnvelopeV2Schema', () => {
    const envelope = {
      schema: 'orcaops.evaluator_result/v2' as const,
      verdict: 'violation' as const,
      body:
        'VIOLATION\n\n## plan conformance\n\nCovered: 1/2. Declared exclusions: 0. ' +
        'Silent gaps / shrunk: 1.\n- **silent gap:** "rate-limit metrics" — not planned and not a non-goal.',
      raw: { covered: 1, total: 2, declared_exclusions: 0, silent_gaps: 1 },
    };
    expect(EvaluatorResultEnvelopeV2Schema.safeParse(envelope).success).toBe(true);
  });

  it('documents the findings block in a form that is inert when echoed', () => {
    expect(sharedPrompt).toContain('```orcaops-findings');
    expect(fixture(sharedPrompt).findings).toEqual({ status: 'absent' });
  });

  it('asks for no conclusion, because it compares plan text against plan text', () => {
    // A conclusion states whether an expectation was MET. This check never
    // looks at delivery, so a conclusion from it would be an assertion about
    // work it did not inspect.
    expect(sharedPrompt).toContain('Never set `conclusion`');
  });

  it('reads a narrowed obligation out of a response without moving its verdict', () => {
    const prose = 'The source asks for rate-limit metrics; no step plans them.';
    const narrowing = {
      title: 'unrepresented: "p95 under 200ms"',
      detail: 'The covering step records no criterion stating a latency bound.',
      locations: [{ kind: 'plan-step' as const, step_id: COVERING_STEP.step_id }],
    };
    const withFindings = fixture(respond({ prose, verdict: 'VIOLATION', findings: [narrowing] }));
    const withoutFindings = fixture(respond({ prose, verdict: 'VIOLATION' }));

    expect(withFindings.verdict).toBe('violation');
    expect(withoutFindings.verdict).toBe(withFindings.verdict);
    expect(withoutFindings.findings).toEqual({ status: 'absent' });
    expect(withFindings.findings).toEqual({ status: 'ok', findings: [narrowing] });
  });

  it('the no-source-plan short-circuit still yields INFO and no findings', () => {
    const shortCircuit = fixture(
      respond({
        prose:
          'No source plan was pinned for this artifact; plan-level conformance was not checked.',
        verdict: 'INFO',
      })
    );
    expect(shortCircuit.verdict).toBe('info');
    expect(shortCircuit.findings).toEqual({ status: 'absent' });
  });
});
