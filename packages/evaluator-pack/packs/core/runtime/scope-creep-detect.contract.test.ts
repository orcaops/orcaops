import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvaluatorResultEnvelopeV2Schema, EvaluatorSchema } from '@orcaops/evaluator-protocol';
import { makeContext, runLlmFixture } from '@orcaops/evaluator-sdk';

import { respond } from './_test-llm-response.js';

/**
 * LLM contract test for core/scope-creep-detect. See
 * non-goals-violated.contract.test.ts for the rationale on contract-
 * vs runtime-style tests for LLM evaluators.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../packs/core');
const specPath = path.join(packRoot, 'evaluators', 'scope-creep-detect.eval.yaml');
const promptBody = readFileSync(
  path.join(packRoot, 'prompts', 'scope-creep-detect.prompt.md'),
  'utf8'
);

const fixture = (response: string) =>
  runLlmFixture({
    context: makeContext({ evaluator_ref: 'core/scope-creep-detect' }),
    promptBody,
    additionalContextSections: [],
    response,
  });

describe('core/scope-creep-detect (LLM contract)', () => {
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

  it('synthetic envelope (pass with structured body) validates against EvaluatorResultEnvelopeV2Schema', () => {
    const envelope = {
      schema: 'orcaops.evaluator_result/v2' as const,
      verdict: 'pass' as const,
      body: 'PASS\n\nCheckpoint stays within the declared scope; no creep detected.',
      raw: { creep_detected: false },
    };
    const result = EvaluatorResultEnvelopeV2Schema.safeParse(envelope);
    expect(result.success).toBe(true);
  });

  it('documents the findings block in a form that is inert when echoed', () => {
    expect(promptBody).toContain('```orcaops-findings');
    expect(fixture(promptBody).findings).toEqual({ status: 'absent' });
  });

  it('reads drifted files out of a response without moving its verdict', () => {
    const prose = '`src/billing/invoice.ts` is outside every plan step.';
    const drift = {
      key: 'drift/src/billing/invoice.ts',
      title: 'src/billing/invoice.ts is outside what the plan said would be touched',
      detail: 'No plan step mentions invoicing.',
      locations: [{ kind: 'file' as const, path: 'src/billing/invoice.ts' }],
    };
    const withFindings = fixture(respond({ prose, verdict: 'VIOLATION', findings: [drift] }));
    const withoutFindings = fixture(respond({ prose, verdict: 'VIOLATION' }));

    expect(withFindings.verdict).toBe('violation');
    expect(withoutFindings.verdict).toBe(withFindings.verdict);
    expect(withoutFindings.findings).toEqual({ status: 'absent' });
    expect(withFindings.findings).toEqual({ status: 'ok', findings: [drift] });
  });
});
