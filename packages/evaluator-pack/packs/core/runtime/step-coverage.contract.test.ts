import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvaluatorResultEnvelopeV2Schema, EvaluatorSchema } from '@orcaops/evaluator-protocol';
import { makeContext, makePlanStep, runLlmFixture } from '@orcaops/evaluator-sdk';

import { respond } from './_test-llm-response.js';

/**
 * LLM contract test for core/step-coverage. See
 * non-goals-violated.contract.test.ts for the rationale on contract-
 * vs runtime-style tests for LLM evaluators.
 *
 * This is the only shipped evaluator that both reads the worktree and needs
 * all three delivery sections, so its spec-level posture — off by default,
 * command-filtered, provider required — is what keeps "opted into core" from
 * quietly meaning "opted into an LLM reading my files."
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../packs/core');
const specPath = path.join(packRoot, 'evaluators', 'step-coverage.eval.yaml');
const promptBody = readFileSync(path.join(packRoot, 'prompts', 'step-coverage.prompt.md'), 'utf8');

function parseSpec() {
  return EvaluatorSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
}

const CRITERION_ID = '019e0000-0000-7000-8000-0000000000c1';
const GRADED_STEP = {
  ...makePlanStep(1, 'cover the expiry path with tests'),
  acceptance_criteria: [{ criterion_id: CRITERION_ID, text: 'at least 42 fixture tests' }],
};

const fixture = (response: string) => {
  const spec = parseSpec();
  if (spec.engine.kind !== 'llm') throw new Error('unreachable');
  return runLlmFixture({
    context: makeContext({
      evaluator_ref: 'core/step-coverage',
      phase: 'pre-pr',
      plan: { ...makeContext().plan, plan_steps: [GRADED_STEP] },
    }),
    promptBody,
    additionalContextSections: spec.engine.additional_context_sections,
    response,
  });
};

describe('core/step-coverage (LLM contract)', () => {
  it('spec parses against EvaluatorSchema at pre-pr', () => {
    const parsed = parseSpec();
    expect(parsed.phase).toBe('pre-pr');
    expect(parsed.severity).toBe('warn');
  });

  it('engine.kind=llm and engine.prompt_file resolves to an existing file', () => {
    const parsed = parseSpec();
    expect(parsed.engine.kind).toBe('llm');
    if (parsed.engine.kind !== 'llm') throw new Error('unreachable');
    expect(existsSync(path.resolve(packRoot, parsed.engine.prompt_file))).toBe(true);
  });

  it('ships disabled and requires a provider', () => {
    const parsed = parseSpec();
    // Enabling a worktree-reading LLM evaluator must be its own explicit act.
    expect(parsed.default_enabled).toBe(false);
    expect(parsed.filters.when_llm).toBe('required');
  });

  it('declares the three delivery context sections its prompt reads', () => {
    // The prompt tells the model to grade criteria against the diff and to
    // treat done_criteria as hints. Drop a section here and the prompt asks
    // the model to reason over data it was never sent.
    const parsed = parseSpec();
    if (parsed.engine.kind !== 'llm') throw new Error('unreachable');
    expect([...parsed.engine.additional_context_sections].sort()).toEqual([
      'acceptance-criteria',
      'delivered-checkpoints',
      'diff-boundary',
    ]);
  });

  it('grants command-filtered tool access (it inspects the worktree)', () => {
    const parsed = parseSpec();
    if (parsed.engine.kind !== 'llm') throw new Error('unreachable');
    expect(parsed.engine.tool_policy?.mode).toBe('command-filtered');
  });

  it('synthetic envelope (under-delivery violation) validates', () => {
    const envelope = {
      schema: 'orcaops.evaluator_result/v2' as const,
      verdict: 'violation' as const,
      body: 'Step "tests" claimed 42 tests; the delivered suite has 2.',
      raw: { under_delivered: ['crit-1'] },
    };
    expect(EvaluatorResultEnvelopeV2Schema.safeParse(envelope).success).toBe(true);
  });

  it('documents the findings block in a form that is inert when echoed', () => {
    expect(promptBody).toContain('```orcaops-findings');
    expect(fixture(promptBody).findings).toEqual({ status: 'absent' });
  });

  it('maps each prose grade onto a conclusion, and names no fourth one', () => {
    // This is the only shipped evaluator that grades expectations, so its
    // three grades are what give `conclusion` a producer at all. A grade that
    // lost its mapping would go back to being prose nothing can read.
    for (const [grade, conclusion] of [
      ['Met', 'supported'],
      ['Under-delivered', 'contradicted'],
      ['Unverifiable', 'unresolved'],
    ] as const) {
      expect(promptBody).toMatch(new RegExp(`\`${conclusion}\` for ${grade}`));
    }
    // "Not assessed" is the absence of a finding; giving it a spelling would
    // let the model assert it.
    expect(promptBody).not.toContain('not-assessed');
    expect(promptBody).toContain('silence is not a grade');
  });

  it('reads a graded criterion out of a response without moving its verdict', () => {
    const prose = 'The step claimed 42 tests; the delivered suite has 2.';
    const graded = {
      key: `criterion/${CRITERION_ID}`,
      title: 'Criterion requires 42 fixture tests; the delivery has 2',
      detail: 'Counted the cases under tests/expiry/.',
      locations: [{ kind: 'acceptance-criterion' as const, criterion_id: CRITERION_ID }],
      conclusion: 'contradicted' as const,
    };
    const withFindings = fixture(respond({ prose, verdict: 'VIOLATION', findings: [graded] }));
    const withoutFindings = fixture(respond({ prose, verdict: 'VIOLATION' }));

    expect(withFindings.verdict).toBe('violation');
    expect(withoutFindings.verdict).toBe(withFindings.verdict);
    expect(withoutFindings.findings).toEqual({ status: 'absent' });
    expect(withFindings.findings).toEqual({ status: 'ok', findings: [graded] });
  });

  it('a met criterion is reported as supported, under a pass verdict', () => {
    // Absence of a finding may never be read as "the criterion is now met",
    // so `supported` under a pass is the shape that has to work.
    const met = {
      key: `criterion/${CRITERION_ID}`,
      title: 'Criterion is satisfied by the delivered tests',
      locations: [{ kind: 'acceptance-criterion' as const, criterion_id: CRITERION_ID }],
      conclusion: 'supported' as const,
    };
    const result = fixture(
      respond({ prose: 'Every graded criterion is met.', verdict: 'PASS', findings: [met] })
    );
    expect(result.verdict).toBe('pass');
    expect(result.findings).toEqual({ status: 'ok', findings: [met] });
  });
});
