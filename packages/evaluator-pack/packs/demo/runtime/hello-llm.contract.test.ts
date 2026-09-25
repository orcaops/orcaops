import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvaluatorResultEnvelopeV2Schema, EvaluatorSchema } from '@orcaops/evaluator-protocol';

/**
 * LLM contract test for demo/hello-llm. See
 * core/non-goals-violated.contract.test.ts for rationale.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../packs/demo');
const specPath = path.join(packRoot, 'evaluators', 'hello-llm.eval.yaml');

describe('demo/hello-llm (LLM contract)', () => {
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

  it('synthetic envelope (info — demo greeting) validates against EvaluatorResultEnvelopeV2Schema', () => {
    const envelope = {
      schema: 'orcaops.evaluator_result/v2' as const,
      verdict: 'info' as const,
      body: 'INFO\n\nHello from the demo LLM evaluator.',
    };
    const result = EvaluatorResultEnvelopeV2Schema.safeParse(envelope);
    expect(result.success).toBe(true);
  });
});
