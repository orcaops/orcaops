import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { SKILL_TEMPLATES } from '@orcaops/adapters';
import type { SemanticAction } from '@orcaops/core';
import {
  CaptureAcknowledgeInputSchema,
  CaptureCheckpointAbandonInputSchema,
  CaptureCheckpointCloseInputSchema,
  CaptureCheckpointOpenInputSchema,
  CapturePlanInputSchema,
  CapturePlanReviseInputSchema,
  CapturePrePrCheckInputSchema,
  CaptureRunEvaluatorsInputSchema,
  CaptureSummaryInputSchema,
} from '@orcaops/storage';

import { renderNextActions } from './next-actions-render.js';

const INPUT_SCHEMAS: Record<string, z.ZodType> = {
  'capture plan': CapturePlanInputSchema,
  'capture plan revise': CapturePlanReviseInputSchema,
  'capture checkpoint open': CaptureCheckpointOpenInputSchema,
  'capture checkpoint close': CaptureCheckpointCloseInputSchema,
  'capture checkpoint abandon': CaptureCheckpointAbandonInputSchema,
  'capture summary': CaptureSummaryInputSchema,
  'capture pre-pr-check': CapturePrePrCheckInputSchema,
  'capture run-evaluators': CaptureRunEvaluatorsInputSchema,
  'capture acknowledge': CaptureAcknowledgeInputSchema,
  finish: CaptureSummaryInputSchema,
};

interface InputExample {
  source: string;
  command: string;
  body: string;
}

const HEREDOC =
  /orcaops (capture [a-z -]+?|finish) (?:--[^\n]*?)?--input - [^\n]*<<'EOF'\n([\s\S]*?)\n\s*EOF\b/g;

function heredocExamples(source: string, text: string): InputExample[] {
  return [...text.matchAll(HEREDOC)].map((match) => ({
    source,
    command: match[1]!.trim(),
    body: dedent(match[2]!),
  }));
}

function dedent(body: string): string {
  const lines = body.split('\n');
  const indent = Math.min(
    ...lines.filter((line) => line.trim() !== '').map((line) => /^ */.exec(line)![0].length)
  );
  return lines.map((line) => line.slice(indent)).join('\n');
}

function schemaFor(example: InputExample): z.ZodType {
  const schema = INPUT_SCHEMAS[example.command];
  if (!schema) throw new Error(`${example.source}: no input schema for "${example.command}"`);
  return schema;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of path) value = (value as Record<PropertyKey, unknown> | undefined)?.[key];
  return value;
}

const isPlaceholder = (value: unknown) =>
  typeof value === 'string' && /^<[^>]+>$/.test(value.trim());

const isElided = (input: unknown) =>
  typeof input === 'object' &&
  input !== null &&
  Object.values(input).some((value) => typeof value === 'string' && value.trim() === '...');

function realIssues(example: InputExample) {
  const input: unknown = parseYaml(example.body);
  const result = schemaFor(example).safeParse(input);
  if (result.success) return [];
  const elided = isElided(input);
  return result.error.issues
    .filter(
      (issue) =>
        issue.code === 'unrecognized_keys' ||
        (!elided && !isPlaceholder(valueAt(input, issue.path)))
    )
    .map((issue) => `${example.source}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

const skillExamples = SKILL_TEMPLATES.flatMap((skill) =>
  heredocExamples(
    `skill ${skill.id}`,
    typeof skill.body === 'function' ? skill.body('orcaops') : skill.body
  )
);

const STEP = '01a0d3de-cca5-7d39-8440-21c76b6f4596';
const CRITERION = '01a0d3de-cca6-7271-ab13-5db0ffe03929';
const base = { artifact_id: '01a0d3de-cca5-75e4-b075-254f6aae6ee1', effect: 'e' };
const closeWithCriteria = {
  ...base,
  verb: 'checkpoint-close' as const,
  checkpoint_n: 1,
  step_ids: [STEP],
  criterion_ids: [CRITERION],
};
const nextActions: SemanticAction[] = [
  { ...base, verb: 'checkpoint-open', step_ids: [STEP] },
  { ...base, verb: 'checkpoint-open', step_ids: [STEP, CRITERION] },
  {
    ...base,
    verb: 'checkpoint-open',
    step_ids: [STEP],
    retry_reason: 'open-rejected',
    policy_exception_refs: ['core/checkpoint-scope-density'],
  },
  closeWithCriteria,
  { ...base, verb: 'checkpoint-close', checkpoint_n: 1, step_ids: [] },
  { ...base, verb: 'checkpoint-abandon', checkpoint_n: 1 },
  { ...base, verb: 'finish' },
  { ...base, verb: 'evaluator-rerun', evaluator_phase: 'pre-pr' },
  { ...base, verb: 'evaluator-rerun', evaluator_phase: 'checkpoint-close', checkpoint_n: 1 },
  { ...base, verb: 'evaluator-rerun', evaluator_phase: 'post-plan' },
];
const templateExamples = renderNextActions(nextActions).flatMap((action, index) =>
  heredocExamples(`next action ${index} (${action.verb})`, action.command)
);

describe('capture input examples agents are told to send', () => {
  it('finds a heredoc example for every capture verb the skills document', () => {
    expect(new Set(skillExamples.map((example) => example.command))).toEqual(
      new Set([
        'capture plan',
        'capture plan revise',
        'capture checkpoint open',
        'capture checkpoint close',
        'capture checkpoint abandon',
        'capture summary',
        'capture pre-pr-check',
        'finish',
      ])
    );
    expect(templateExamples).toHaveLength(nextActions.length);
  });

  it('parses every skill heredoc example under its capture input schema', () => {
    expect(skillExamples.flatMap(realIssues)).toEqual([]);
  });

  it('parses the verification fragment the checkpoint skill shows', () => {
    const checkpoint = SKILL_TEMPLATES.find((skill) => skill.id === 'checkpoint')!;
    const text =
      typeof checkpoint.body === 'function' ? checkpoint.body('orcaops') : checkpoint.body;
    const fragment = /```yaml\n(verification:[\s\S]*?)```/.exec(text)?.[1];
    expect(fragment).toBeDefined();
    const parsed = CaptureCheckpointCloseInputSchema.safeParse({
      summary: 'close',
      ...(parseYaml(fragment!) as object),
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('parses every rendered next-action capture template under its input schema', () => {
    expect(templateExamples.flatMap(realIssues)).toEqual([]);
  });
});
