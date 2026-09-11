import { expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { CapturePlanInputSchema } from '../../schema/capture-input.js';
import { digest } from '../event-integrity.js';
import {
  assertSamePlanCaptureInput,
  planCaptureCommand,
  planCaptureInput,
  preparePlanCaptureCommand,
  preparePlanCaptureInput,
  restorePlanCaptureInput,
} from './plan-capture-input.js';

function request() {
  return {
    authored: CapturePlanInputSchema.parse({
      idempotency_key: 'original:plan',
      task: 'Capture original plan intent',
      label: 'Original plan',
      plan_steps: [
        {
          text: 'Keep the original identity',
          label: 'Keep identity',
          acceptance_criteria: [{ text: 'Original IDs survive' }],
        },
      ],
    }),
    sourcePlan: {
      source_ref: { kind: 'local' as const, locator: '/original/plan.md' },
      content: 'Original source plan',
      hash: digest(Buffer.from('Original source plan')),
      baseline: null,
    },
  };
}

it('detaches and freezes original authored fields and source-plan input', () => {
  const input = request();
  const prepared = preparePlanCaptureInput(input, []);
  const retained = planCaptureInput(prepared);
  input.authored.task = 'Changed';
  input.authored.plan_steps[0]!.acceptance_criteria[0]!.text = 'Changed criterion';
  input.sourcePlan.content = 'Changed pin';
  expect(retained.authored.task).toBe('Capture original plan intent');
  expect(retained.authored.plan_steps[0]!.acceptance_criteria[0]!.text).toBe(
    'Original IDs survive'
  );
  expect(retained.sourcePlan?.content).toBe('Original source plan');
  expect(() => {
    retained.authored.plan_steps[0]!.text = 'mutated';
  }).toThrow();
  expect(retained.requestHash).toBe(digest(Buffer.from(retained.requestBytes)));
});

it('compares complete original values and preserves meaningful ordered arrays', () => {
  const input = request();
  const original = preparePlanCaptureInput(input, []);
  const reordered = preparePlanCaptureInput(
    { sourcePlan: input.sourcePlan, authored: { ...input.authored } },
    []
  );
  expect(() => assertSamePlanCaptureInput(reordered, original)).not.toThrow();
  for (const changed of [
    { ...input, authored: { ...input.authored, task: 'Different task' } },
    { ...input, sourcePlan: null },
    { ...input, authored: { ...input.authored, touched_scope: ['b', 'a'] } },
  ])
    expect(() =>
      assertSamePlanCaptureInput(preparePlanCaptureInput(changed, []), original)
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
});

it('refuses authored secrets before dropped schema fields and preserves explicit refusal policy', () => {
  const token = 'ghp_' + 'a'.repeat(36);
  const input = { ...request(), ignored: token };
  expect(() => preparePlanCaptureInput(input, [])).toThrow(
    expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
  );
  const allowed = request();
  allowed.authored.task = token;
  const prepared = preparePlanCaptureInput(allowed, [token]);
  const row = planCaptureInput(prepared);
  expect(
    planCaptureInput(restorePlanCaptureInput(row.requestBytes, row.requestHash)).authored.task
  ).toBe(token);
});

it('rejects a missing original key without minting a new one', () => {
  const input = request();
  delete (input.authored as Partial<typeof input.authored>).idempotency_key;
  expect(() => preparePlanCaptureInput(input, [])).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
});

it('restores only the exact retained canonical request and checksum', () => {
  const original = planCaptureInput(preparePlanCaptureInput(request(), []));
  for (const [bytes, hash] of [
    [original.requestBytes, 'f'.repeat(64)],
    [' ' + original.requestBytes, digest(Buffer.from(' ' + original.requestBytes))],
    ['{"authored":{}}', digest(Buffer.from('{"authored":{}}'))],
  ])
    expect(() => restorePlanCaptureInput(bytes!, hash!)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
});

it('retains minted identities without accepting fabricated preparation handles', () => {
  const input = preparePlanCaptureInput(request(), []);
  const identity = {
    originalOperationId: uuidv7(),
    admissionOperationId: uuidv7(),
    artifactId: uuidv7(),
    planEventId: uuidv7(),
  };
  const original = { ...identity };
  const command = preparePlanCaptureCommand(input, identity);
  identity.artifactId = uuidv7();
  expect(planCaptureCommand(command)).toMatchObject(original);
  expect(() => planCaptureInput({ kind: 'prepared-plan-capture-input' })).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(() => planCaptureCommand({ kind: 'prepared-plan-capture-command' })).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(() =>
    preparePlanCaptureCommand(input, { ...identity, originalOperationId: 'other' })
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
