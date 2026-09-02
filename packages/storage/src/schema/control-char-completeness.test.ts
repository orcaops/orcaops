import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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
} from './capture-input.js';
import {
  AgentUsageSnapshotPayloadSchema,
  InlineUsageRecordSchema,
  SidecarUsageRecordSchema,
  SourcePlanLinkPayloadSchema,
} from './usage-ledger.js';
import { identifierText, proseText, textPolicyOf } from '../text/control-chars.js';

/**
 * STRUCTURAL completeness guard. A fixture-based test only exercises the
 * fields a hand-written sample happens to include, so a bare `z.string()`
 * field added to any capture schema slips through it. This instead
 * walks each capture-input schema's actual shape (peeling optional/nullable/
 * default + array + nested object) and FAILS if any string leaf is a bare
 * `z.string()` that carries neither the `proseText` (strip) nor `identifierText`
 * (reject) policy marker. So forgetting to wrap a new author-facing field is a
 * red test, not a silent control-char hole.
 */
function findBareStringLeaves(schema: z.ZodType, path: string, out: string[]): void {
  // proseText / identifierText stamp a policy in textPolicyRegistry → OK.
  if (textPolicyOf(schema) !== undefined) return;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    findBareStringLeaves(schema.unwrap() as z.ZodType, path, out);
    return;
  }
  if (schema instanceof z.ZodArray) {
    findBareStringLeaves(schema.element as z.ZodType, `${path}[]`, out);
    return;
  }
  if (schema instanceof z.ZodRecord) {
    findBareStringLeaves(schema.keyType as z.ZodType, `${path}{key}`, out);
    findBareStringLeaves(schema.valueType as z.ZodType, `${path}{value}`, out);
    return;
  }
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape)) {
      findBareStringLeaves(child as z.ZodType, path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }
  // A bare string with no text policy is the regression we guard against. Any
  // other leaf (number, enum, boolean, …) is not an author-facing string.
  if (schema instanceof z.ZodString) out.push(path);
}

const CAPTURE_SCHEMAS: Record<string, z.ZodType> = {
  CapturePlanInputSchema,
  CapturePlanReviseInputSchema,
  CaptureCheckpointOpenInputSchema,
  CaptureCheckpointCloseInputSchema,
  CaptureCheckpointAbandonInputSchema,
  CaptureSummaryInputSchema,
  CaptureRunEvaluatorsInputSchema,
  CapturePrePrCheckInputSchema,
  CaptureAcknowledgeInputSchema,
};

// The usage ledger joins the pushed snapshot (its strings ride the same wire
// assert), so its payload schemas carry the same structural invariant.
const USAGE_PAYLOAD_SCHEMAS: Record<string, z.ZodType> = {
  AgentUsageSnapshotPayloadSchema,
  SourcePlanLinkPayloadSchema,
  InlineUsageRecordSchema,
  SidecarUsageRecordSchema,
};

describe('usage-ledger control-char policy completeness (structural)', () => {
  for (const [name, schema] of Object.entries(USAGE_PAYLOAD_SCHEMAS)) {
    it(`${name}: every string field is proseText or identifierText (no bare z.string())`, () => {
      const bare: string[] = [];
      findBareStringLeaves(schema, '', bare);
      expect(bare).toEqual([]);
    });
  }
});

describe('capture-input control-char policy completeness (structural)', () => {
  for (const [name, schema] of Object.entries(CAPTURE_SCHEMAS)) {
    it(`${name}: every string field is proseText or identifierText (no bare z.string())`, () => {
      const bare: string[] = [];
      findBareStringLeaves(schema, '', bare);
      expect(bare).toEqual([]);
    });
  }

  it('NEGATIVE CONTROL: the walker flags a bare z.string() (proves it is not vacuous)', () => {
    const bad = z.object({
      oops: z.string().min(1), // bare — should be flagged
      nested: z.object({ alsoBad: z.string() }),
      fine: z.number(),
      kind: z.enum(['a', 'b']),
    });
    const bare: string[] = [];
    findBareStringLeaves(bad, '', bare);
    expect(bare.sort()).toEqual(['nested.alsoBad', 'oops']);
  });

  it('NEGATIVE CONTROL: proseText / identifierText fields are NOT flagged', () => {
    const good = z.object({
      summary: proseText(),
      id: identifierText(),
      tags: z.array(proseText(z.string())).default([]),
      maybeId: identifierText().optional(),
    });
    const bare: string[] = [];
    findBareStringLeaves(good, '', bare);
    expect(bare).toEqual([]);
  });
});
