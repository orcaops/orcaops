import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  EvaluatorSchema,
  parseMarkdownVerdict,
  parseVerdictSentinel,
} from '@orcaops/evaluator-protocol';

/**
 * Cross-pack contract between every shipped LLM prompt and the verdict
 * parser that reads its responses.
 *
 * The defect this guards: prompts used to instruct verdict-FIRST while the
 * parser took the LAST standalone verdict line, and three of them carried
 * fenced examples containing bare verdict tokens the fence-blind parser
 * counted as real. A run's recorded verdict could differ from the verdict its
 * own body stated. Nothing in the repo compared the two, so it stayed
 * invisible — these assertions are that comparison.
 */

const PACKS_ROOT = path.resolve(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'packs'
);

interface ShippedLlmEvaluator {
  ref: string;
  promptPath: string;
  sections: readonly string[];
}

function shippedLlmEvaluators(): ShippedLlmEvaluator[] {
  const found: ShippedLlmEvaluator[] = [];
  for (const packId of readdirSync(PACKS_ROOT)) {
    const evaluatorsDir = path.join(PACKS_ROOT, packId, 'evaluators');
    let entries: string[];
    try {
      entries = readdirSync(evaluatorsDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.eval.yaml')) continue;
      const specPath = path.join(evaluatorsDir, file);
      const spec = EvaluatorSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
      if (spec.engine.kind !== 'llm') continue;
      found.push({
        ref: `${packId}/${spec.id}`,
        promptPath: path.resolve(PACKS_ROOT, packId, spec.engine.prompt_file),
        sections: spec.engine.additional_context_sections,
      });
    }
  }
  return found.sort((a, b) => a.ref.localeCompare(b.ref));
}

const EVALUATORS = shippedLlmEvaluators();

/** Drop every ```orcaops-verdict block, leaving the prose the model imitates. */
function withoutSentinelBlocks(body: string): string[] {
  const kept: string[] = [];
  let inside = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!inside && /^`{3,}[ \t]*orcaops-verdict[ \t]*$/.test(trimmed)) {
      inside = true;
      continue;
    }
    if (inside) {
      if (/^`{3,}[ \t]*$/.test(trimmed)) inside = false;
      continue;
    }
    kept.push(line);
  }
  return kept;
}

describe('shipped LLM prompts ↔ verdict parser', () => {
  it('finds every shipped LLM evaluator', () => {
    // A guard on the guard: if discovery silently returned nothing, every
    // assertion below would vacuously pass.
    expect(EVALUATORS.length).toBeGreaterThanOrEqual(8);
  });

  for (const { ref, promptPath, sections } of EVALUATORS) {
    describe(ref, () => {
      const prompt = readFileSync(promptPath, 'utf8');

      it('teaches the verdict sentinel', () => {
        expect(parseVerdictSentinel(prompt)).not.toBeNull();
      });

      it('its own documented example parses to a verdict', () => {
        // The prompt shows the model a shape. If that shape does not parse,
        // a model following instructions perfectly still yields
        // NO_VERDICT_LINE.
        expect(parseMarkdownVerdict(prompt)).not.toBeNull();
      });

      it('writes no bare verdict token outside a sentinel block', () => {
        // Bare-line parsing is the fallback tier and is fence-blind, so a
        // standalone token anywhere in an example teaches a shape whose
        // meaning depends on where it lands in the response.
        const stray = withoutSentinelBlocks(prompt).filter((line) =>
          ['PASS', 'VIOLATION', 'INFO'].includes(line.trim())
        );
        expect(stray).toEqual([]);
      });

      it('declares its context sections explicitly', () => {
        expect(Array.isArray(sections)).toBe(true);
        expect(new Set(sections).size).toBe(sections.length);
      });
    });
  }
});
