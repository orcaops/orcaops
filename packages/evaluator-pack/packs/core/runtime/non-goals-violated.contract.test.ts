import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvaluatorResultEnvelopeV2Schema, EvaluatorSchema } from '@orcaops/evaluator-protocol';
import { makeContext, runLlmFixture } from '@orcaops/evaluator-sdk';

import { respond } from './_test-llm-response.js';

/**
 * LLM contract test for core/non-goals-violated. A live model is not
 * reproducible, so the contract scope is what we CAN assert without one:
 *
 *   1. The spec YAML parses against EvaluatorSchema.
 *   2. engine.kind === 'llm' and engine.prompt_file resolves to an
 *      existing file relative to the pack root.
 *   3. A synthetic envelope (the shape the LLM would emit) validates
 *      against EvaluatorResultEnvelopeV2Schema.
 *   4. The prompt's own findings example is inert when echoed, and a real
 *      response carrying a findings block yields findings without moving
 *      the verdict.
 *
 * Live LLM integration is exercised at the CLI capture layer with
 * a real LLM client; this contract test guards the static surface.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../packs/core');
const specPath = path.join(packRoot, 'evaluators', 'non-goals-violated.eval.yaml');
const promptBody = readFileSync(
  path.join(packRoot, 'prompts', 'non-goals-violated.prompt.md'),
  'utf8'
);

const fixture = (response: string) =>
  runLlmFixture({
    context: makeContext({ evaluator_ref: 'core/non-goals-violated' }),
    promptBody,
    additionalContextSections: [],
    response,
  });

describe('core/non-goals-violated (LLM contract)', () => {
  it('spec parses against EvaluatorSchema', () => {
    const raw = readFileSync(specPath, 'utf8');
    const parsed = parseYaml(raw);
    const result = EvaluatorSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('prompt judges the observed changed files and names paths the agent did not report', () => {
    const parsed = EvaluatorSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
    if (parsed.engine.kind !== 'llm') throw new Error('expected an llm engine');
    const prompt = readFileSync(path.resolve(packRoot, parsed.engine.prompt_file), 'utf8');
    expect(prompt).toContain('Changed files observed by git');
    expect(prompt).toContain('Observed but NOT reported by the agent');
  });

  it('engine.kind=llm and engine.prompt_file resolves to an existing file', () => {
    const raw = readFileSync(specPath, 'utf8');
    const parsed = EvaluatorSchema.parse(parseYaml(raw));
    expect(parsed.engine.kind).toBe('llm');
    if (parsed.engine.kind !== 'llm') throw new Error('unreachable');
    const promptPath = path.resolve(packRoot, parsed.engine.prompt_file);
    expect(existsSync(promptPath)).toBe(true);
  });

  it('synthetic envelope shape (violation with structured body) validates against EvaluatorResultEnvelopeV2Schema', () => {
    const envelope = {
      schema: 'orcaops.evaluator_result/v2' as const,
      verdict: 'violation' as const,
      body: 'VIOLATION\n\n## findings\n- summary mentions refactoring auth middleware (non-goal)',
      raw: { violated_non_goals: ['do not change the auth middleware'] },
    };
    const result = EvaluatorResultEnvelopeV2Schema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('documents the findings block in a form that is inert when echoed', () => {
    // Non-vacuity first: an absent section would satisfy the echo assertion
    // for the wrong reason.
    expect(promptBody).toContain('```orcaops-findings');
    expect(fixture(promptBody).findings).toEqual({ status: 'absent' });
  });

  it('reads a crossed non-goal out of a response without moving its verdict', () => {
    const prose = 'The checkpoint rewrites the session refresh path, which a non-goal named.';
    const withFindings = fixture(
      respond({
        prose,
        verdict: 'VIOLATION',
        findings: [
          {
            title: '"do not touch the auth middleware" was crossed by src/auth/session.ts',
            detail: 'The checkpoint rewrites the session refresh path.',
            locations: [{ kind: 'file', path: 'src/auth/session.ts' }],
          },
        ],
      })
    );
    const withoutFindings = fixture(respond({ prose, verdict: 'VIOLATION' }));

    expect(withFindings.verdict).toBe('violation');
    expect(withoutFindings.verdict).toBe(withFindings.verdict);
    expect(withoutFindings.findings).toEqual({ status: 'absent' });
    expect(withFindings.findings).toEqual({
      status: 'ok',
      findings: [
        {
          title: '"do not touch the auth middleware" was crossed by src/auth/session.ts',
          detail: 'The checkpoint rewrites the session refresh path.',
          locations: [{ kind: 'file', path: 'src/auth/session.ts' }],
        },
      ],
    });
  });
});
