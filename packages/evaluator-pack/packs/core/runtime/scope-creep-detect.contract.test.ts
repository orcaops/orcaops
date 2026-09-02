import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvaluatorResultEnvelopeSchema, EvaluatorSchema } from '@orcaops/evaluator-protocol';

/**
 * LLM contract test for core/scope-creep-detect. See
 * non-goals-violated.contract.test.ts for the rationale on contract-
 * vs runtime-style tests for LLM evaluators.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../packs/core');
const specPath = path.join(packRoot, 'evaluators', 'scope-creep-detect.eval.yaml');

describe('core/scope-creep-detect (LLM contract)', () => {
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

  it('synthetic envelope (pass with structured body) validates against EvaluatorResultEnvelopeSchema', () => {
    const envelope = {
      schema: 'orcaops.evaluator_result/v1' as const,
      verdict: 'pass' as const,
      body: 'PASS\n\nCheckpoint stays within the declared scope; no creep detected.',
      raw: { creep_detected: false },
    };
    const result = EvaluatorResultEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(true);
  });
});
