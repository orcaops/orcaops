import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvaluatorResultEnvelopeSchema, EvaluatorSchema } from '@orcaops/evaluator-protocol';

/**
 * LLM contract test for core/non-goals-violated. LLM evaluators
 * cannot be exercised by runFixture (the harness is command-engine
 * only — model output is non-deterministic without recorded
 * cassettes). The contract scope is what we CAN assert at the spec
 * layer:
 *
 *   1. The spec YAML parses against EvaluatorSchema.
 *   2. engine.kind === 'llm' and engine.prompt_file resolves to an
 *      existing file relative to the pack root.
 *   3. A synthetic envelope (the shape the LLM would emit) validates
 *      against EvaluatorResultEnvelopeSchema.
 *
 * Live LLM integration is exercised at the CLI capture layer with
 * a real LLM client; this contract test guards the static surface.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../packs/core');
const specPath = path.join(packRoot, 'evaluators', 'non-goals-violated.eval.yaml');

describe('core/non-goals-violated (LLM contract)', () => {
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

  it('synthetic envelope shape (violation with structured body) validates against EvaluatorResultEnvelopeSchema', () => {
    const envelope = {
      schema: 'orcaops.evaluator_result/v1' as const,
      verdict: 'violation' as const,
      body: 'VIOLATION\n\n## findings\n- summary mentions refactoring auth middleware (non-goal)',
      raw: { violated_non_goals: ['do not change the auth middleware'] },
    };
    const result = EvaluatorResultEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });
});
