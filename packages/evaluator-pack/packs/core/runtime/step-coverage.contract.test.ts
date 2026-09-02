import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvaluatorResultEnvelopeSchema, EvaluatorSchema } from '@orcaops/evaluator-protocol';

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

function parseSpec() {
  return EvaluatorSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
}

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
      schema: 'orcaops.evaluator_result/v1' as const,
      verdict: 'violation' as const,
      body: 'Step "tests" claimed 42 tests; the delivered suite has 2.',
      raw: { under_delivered: ['crit-1'] },
    };
    expect(EvaluatorResultEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});
