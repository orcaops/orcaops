import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvaluatorResultEnvelopeV2Schema, EvaluatorSchema } from '@orcaops/evaluator-protocol';
import { makeContext, makePlanStep, runLlmFixture } from '@orcaops/evaluator-sdk';

import { respond } from './_test-llm-response.js';

/**
 * LLM contract test for core/sensitive-scope-flag. See
 * non-goals-violated.contract.test.ts for rationale.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../packs/core');
const specPath = path.join(packRoot, 'evaluators', 'sensitive-scope-flag.eval.yaml');
const promptBody = readFileSync(
  path.join(packRoot, 'prompts', 'sensitive-scope-flag.prompt.md'),
  'utf8'
);

const PLAN_STEP = makePlanStep(1, 'migrate the stored payment tokens');

const fixture = (response: string) =>
  runLlmFixture({
    context: makeContext({
      evaluator_ref: 'core/sensitive-scope-flag',
      plan: { ...makeContext().plan, plan_steps: [PLAN_STEP] },
    }),
    promptBody,
    additionalContextSections: [],
    response,
  });

describe('core/sensitive-scope-flag (LLM contract)', () => {
  it('spec parses against EvaluatorSchema', () => {
    const raw = readFileSync(specPath, 'utf8');
    const parsed = parseYaml(raw);
    const result = EvaluatorSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('engine.kind=llm and engine.prompt_file resolves to an existing file', () => {
    const raw = readFileSync(specPath, 'utf8');
    const parsed = EvaluatorSchema.parse(parseYaml(raw));
    expect(parsed.engine.kind).toBe('llm');
    if (parsed.engine.kind !== 'llm') throw new Error('unreachable');
    const promptPath = path.resolve(packRoot, parsed.engine.prompt_file);
    expect(existsSync(promptPath)).toBe(true);
  });

  it('synthetic envelope (info — declarative flag) validates against EvaluatorResultEnvelopeV2Schema', () => {
    const envelope = {
      schema: 'orcaops.evaluator_result/v2' as const,
      verdict: 'info' as const,
      body: 'INFO\n\nplan.touched_scope includes `auth`; reviewer should re-look at auth-related changes.',
      raw: { flagged_scopes: ['auth'] },
    };
    const result = EvaluatorResultEnvelopeV2Schema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('documents the findings block in a form that is inert when echoed', () => {
    expect(promptBody).toContain('```orcaops-findings');
    expect(fixture(promptBody).findings).toEqual({ status: 'absent' });
  });

  it('reads an unaddressed concern out of a response without moving its verdict', () => {
    const prose = 'Nothing in the plan says how the token migration is reversed.';
    const gap = {
      key: 'rollback',
      title: 'No step says how this is reversed',
      detail: 'The plan step migrates payment tokens and names no way back.',
      locations: [{ kind: 'plan-step' as const, step_id: PLAN_STEP.step_id }],
    };
    const withFindings = fixture(respond({ prose, verdict: 'VIOLATION', findings: [gap] }));
    const withoutFindings = fixture(respond({ prose, verdict: 'VIOLATION' }));

    expect(withFindings.verdict).toBe('violation');
    expect(withoutFindings.verdict).toBe(withFindings.verdict);
    expect(withoutFindings.findings).toEqual({ status: 'absent' });
    expect(withFindings.findings).toEqual({ status: 'ok', findings: [gap] });
  });

  it('the three keys the prompt fixes are the three concerns it checks', () => {
    // The keys are what makes "this gap again" the same finding across runs,
    // so a prompt that renamed a concern without renaming its key would
    // silently mint a second identity for the same thing.
    for (const concern of ['idempotency', 'rollback', 'test-coverage']) {
      expect(promptBody).toContain(`\`${concern}\``);
    }
  });
});
