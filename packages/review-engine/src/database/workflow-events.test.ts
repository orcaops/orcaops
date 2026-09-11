import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { type JournalEvent, type ReviewedRow, reviewedRowsDigest } from '@orcaops/review-core';
import { uuidv7 } from '@orcaops/storage';

import { prepareReviewWorkflowEvents, workflowTarget } from './workflow-events.js';

const ts = '2026-01-01T00:00:00.000Z';
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const section = (threadKey = 'section') => ({ type: 'section', ts, threadKey, action: 'VISIT' });
const row: ReviewedRow = {
  file: 'source.ts',
  side: 'add',
  lineHash: 'exact-line-hash',
  line: 1,
  hunkKey: 'exact-hunk',
};
async function coverage() {
  const digest = await reviewedRowsDigest([row]);
  return {
    type: 'review_coverage',
    ts,
    action: 'RECORD_REVIEW_COVERAGE',
    floor_input_hash: 'exact-floor',
    ledger_generation: 'exact-ledger',
    threads: [
      {
        threadKey: 'section',
        coveredRows: [row],
        coveredRowsDigest: digest,
        completedRows: [row],
        completedRowsDigest: digest,
      },
    ],
  };
}
const lifecycle = {
  type: 'review_lifecycle',
  ts,
  action: 'PARTIAL',
  review_basis: 'FLOOR_ONLY',
  floor_input_hash: 'exact-floor',
  story_generation: null,
  ledger_generation: 'exact-ledger',
  actor: 'REVIEWER',
  source: 'WATCH',
  remaining_work: 'Inspect the remaining changes.',
};
function request(...values: unknown[]) {
  return {
    events: values.map((value) => ({ revisionId: uuidv7(), bytes: bytes(value) })),
    secretAllow: [],
  };
}

it('preserves exact source bytes and distinct event occurrences in a same-target batch', async () => {
  const input = request(section(), { ...section(), action: 'PARTIAL', reason: 'Continue later.' });
  const original = input.events.map((event) => ({ ...event, bytes: Buffer.from(event.bytes) }));
  const pending = prepareReviewWorkflowEvents(input);
  input.events[0]!.bytes.fill(0);
  input.events[1]!.revisionId = uuidv7();
  input.events.reverse();
  const result = await pending;
  expect(result.map((record) => record.revisionId)).toEqual(
    original.map((event) => event.revisionId)
  );
  expect(result.map((record) => record.bytes)).toEqual(original.map((event) => event.bytes));
  expect(result.map((record) => record.sha256)).toEqual(
    original.map((event) => createHash('sha256').update(event.bytes).digest('hex'))
  );
  expect(result[0]!.targetKey).toBe(result[1]!.targetKey);
  expect(result.map((record) => record.source)).toEqual(
    original.map((event, position) => ({
      kind: 'authored',
      eventId: event.revisionId,
      fieldPath: 'events',
      position,
    }))
  );
});

it('keeps original target families and delimiter-containing keys distinct', () => {
  const events: JournalEvent[] = [
    { type: 'section', ts, threadKey: 'finding:a', action: 'VISIT' },
    { type: 'finding', ts, findingKey: 'finding:a', action: 'ACKNOWLEDGE' },
    { type: 'prompt', ts, promptKey: 'finding:a', action: 'ACKNOWLEDGE' },
    {
      type: 'unassigned',
      ts,
      action: 'MARK_INSPECTED',
      target: { kind: 'AMBIGUOUS_HUNK', hunkKey: 'finding:a' },
    },
  ];
  expect(new Set(events.map(workflowTarget)).size).toBe(events.length);
});

it('refuses duplicate revision identities before returning an authored batch', async () => {
  const input = request(section('a'), section('b'));
  input.events[1]!.revisionId = input.events[0]!.revisionId;
  await expect(prepareReviewWorkflowEvents(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it.each(['coverage', 'lifecycle'])('refuses mixed %s and ordinary events', async (kind) => {
  const event = kind === 'coverage' ? await coverage() : lifecycle;
  await expect(prepareReviewWorkflowEvents(request(section(), event))).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  const [prepared] = await prepareReviewWorkflowEvents(request(event));
  expect(prepared!.value).toEqual(event);
});

it.each(['covered', 'completed'])(
  'refuses a forged %s row set behind a retained digest',
  async (kind) => {
    const event = await coverage();
    const thread = event.threads[0]!;
    if (kind === 'covered') thread.coveredRows = [{ ...row, lineHash: 'other-content' }];
    else thread.completedRows = [{ ...row, lineHash: 'other-content' }];
    await expect(prepareReviewWorkflowEvents(request(event))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  }
);

it('checks gap-row digests without rewriting authored row order or duplicates', async () => {
  const rows = [row, { ...row, line: 2 }, row];
  const event = {
    type: 'unassigned',
    ts,
    action: 'MARK_INSPECTED',
    target: {
      kind: 'GAP_ROWS',
      coveredRows: rows,
      coveredRowsDigest: await reviewedRowsDigest(rows),
    },
  };
  const input = request(event);
  const [prepared] = await prepareReviewWorkflowEvents(input);
  expect(prepared!.bytes).toEqual(input.events[0]!.bytes);
  expect(prepared!.value).toEqual(event);
  event.target.coveredRowsDigest = 'forged';
  await expect(prepareReviewWorkflowEvents(request(event))).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
});

it('retains the original cancellation signal across asynchronous digest preparation', async () => {
  const input = request(await coverage());
  const original = new AbortController();
  const options = { signal: original.signal };
  const pending = prepareReviewWorkflowEvents(input, options);
  options.signal = new AbortController().signal;
  original.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
});

it('copies the whole batch before asynchronous digests can observe caller changes', async () => {
  const input = request(await coverage());
  const original = Buffer.from(input.events[0]!.bytes);
  const pending = prepareReviewWorkflowEvents(input);
  input.events[0]!.bytes.fill(0);
  input.events.splice(0);
  expect((await pending)[0]!.bytes).toEqual(original);
});

it('refuses escaped discarded secret values even in a later event', async () => {
  const secret = 'ghp_' + 'A'.repeat(36);
  const escaped = Array.from(secret)
    .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  const input = request(section(), { ...section(), action: 'PARTIAL', reason: 'Continue later.' });
  input.events[1]!.bytes = Buffer.from(
    input.events[1]!.bytes.toString().replace('"reason":', `"reason":"${escaped}","reason":`)
  );
  await expect(prepareReviewWorkflowEvents(input)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
});

it('refuses sparse event and allowlist inputs without silently dropping holes', async () => {
  const input = request(section());
  input.events.length = 2;
  await expect(prepareReviewWorkflowEvents(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const other = request(section());
  other.secretAllow.length = 1;
  await expect(prepareReviewWorkflowEvents(other)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
