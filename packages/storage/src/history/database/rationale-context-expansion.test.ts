import { afterEach, expect, it } from 'vitest';

import { appendProjectCorrection } from './knowledge-corrections.js';
import { expandProjectRationaleContext } from './rationale-context-expansion.js';
import { expandProjectRationale, RATIONALE_EXPORT_SOURCE_BYTES } from './rationale-expansion.js';
import { readProjectRationale } from './rationale-read.js';
import { parseRationaleSelector, rationaleSelector } from './rationale-selector.js';
import { instructionSource } from '../../../tests/knowledge-authority-store.js';
import {
  BY_OWNER,
  discardKnowledgeStores,
  knowledgeStore,
} from '../../../tests/knowledge-store.js';
import {
  closeCapture,
  decision,
  interpret,
  planCapture,
} from '../../../tests/rationale-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

it('distinguishes unresolved evidence from qualifications outside the returned page', async () => {
  const { handle } = await knowledgeStore();
  const capture = await closeCapture(
    handle,
    await planCapture(handle, 'Delivery policy', []),
    ['Retain delivery leases.'],
    ['src/delivery.ts']
  );
  const interpreted = await interpret(handle, capture, 0);
  await decision(
    handle,
    interpreted.source_origin.source_id,
    capture.fields[0]!.text,
    capture.fields[0]!.path
  );
  const read = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    boundary: 'now',
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  const account = read.items.find(
    (item) => item.form === 'recorded_capture' && item.account.kind === 'decision'
  )!;
  const result = expandProjectRationaleContext(handle, account.reference).value;
  expect(result.status).toBe('available');
  if (!('qualifications' in result)) throw new Error('Missing context');
  expect(result.pagination.next_cursor).toBeNull();
  expect(result.completeness.unreturned_qualifications).toBe(0);
  expect(result.completeness.complete).toBe(false);
  expect(result.completeness.reasons).toContainEqual(
    expect.objectContaining({ code: 'unresolved_qualification_evidence_or_authority' })
  );
  expect(
    result.completeness.reasons.some((reason) => reason.code === 'qualifications_outside_page')
  ).toBe(false);
});

it('recovers current corrections beyond the first page in an explicit artifact scope', async () => {
  const { handle } = await knowledgeStore();
  const capture = await closeCapture(
    handle,
    await planCapture(handle, 'Cache policy', []),
    ['Retain cached responses.'],
    ['src/cache.ts']
  );
  const interpreted = await interpret(handle, capture, 0);
  const targets = [];
  for (let index = 0; index < 6; index++)
    targets.push(
      await decision(
        handle,
        interpreted.source_origin.source_id,
        `Cache policy ${index}.`,
        capture.fields[0]!.path
      )
    );
  const boundary = handle.read(() => null).counters.writeSequence;
  const original = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    boundary: 'now',
    observation: boundary,
  }).value.items.find((item) => item.account.kind === 'decision')!;
  const corrected =
    'Do not cache private responses; the recorded claim excluded the privacy exception.';
  const source = await instructionSource(handle, corrected);
  const actionId = uuidv7();
  await appendProjectCorrection(handle, {
    operationId: uuidv7(),
    attributedTo: BY_OWNER,
    secretAllow: [],
    action: {
      action_id: actionId,
      targets: [targets[5]!],
      scope: { kind: 'artifact', artifact_id: capture.plan.artifactId },
      source_id: source,
      authorization: null,
      expected_state: { kind: 'initial' },
      kind: 'factual_correction',
      corrected_account: corrected,
    },
  });
  const read = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    boundary,
    observation: handle.read(() => null).counters.writeSequence,
    authorityArtifactId: capture.plan.artifactId,
  }).value;
  const item = read.items.find((item) => item.account.kind === 'decision')!;
  expect(item.reference).toBe(original.reference);
  expect(item.knowledge_keys).toHaveLength(6);
  const first = expandProjectRationaleContext(handle, item.reference, {
    limit: 4,
    artifact: capture.plan.artifactId,
  }).value;
  expect(first.status).toBe('available');
  if (!('qualifications' in first)) throw new Error('Missing context');
  expect(first.qualifications).toHaveLength(4);
  expect(JSON.stringify(first.qualifications)).not.toContain(corrected);
  expect(first.selection).toMatchObject({
    scope: { kind: 'artifact', artifact_id: capture.plan.artifactId },
    mode: 'current',
    observation_ceiling: handle.read(() => null).counters.writeSequence,
  });
  expect(first.completeness.complete).toBe(false);
  const second = expandProjectRationaleContext(handle, item.reference, {
    cursor: first.pagination.next_cursor!,
    limit: 4,
    artifact: capture.plan.artifactId,
  }).value;
  if (!('qualifications' in second)) throw new Error('Missing next context page');
  expect(second.qualifications).toHaveLength(2);
  expect(second.pagination.next_cursor).toBeNull();
  expect(second.qualifications[1]?.corrections).toContainEqual({
    action_id: actionId,
    status: 'available',
    action: expect.objectContaining({ corrected_account: corrected }),
  });
  const full = expandProjectRationaleContext(handle, item.reference, {
    export: true,
    artifact: capture.plan.artifactId,
  }).value;
  expect(full).toMatchObject({
    qualifications: expect.arrayContaining(second.qualifications),
    pagination: { total: 6, returned: 6, next_cursor: null },
  });
  expect(() =>
    expandProjectRationaleContext(handle, read.items[0]!.reference + 'x', {
      cursor: first.pagination.next_cursor!,
    })
  ).toThrow();
  await planCapture(handle, 'Unrelated work', []);
  expect(() =>
    expandProjectRationaleContext(handle, item.reference, {
      cursor: first.pagination.next_cursor!,
      artifact: capture.plan.artifactId,
    })
  ).toThrow('history changed');
  expect(expandProjectRationaleContext(handle, item.reference).value.status).toBe('available');
});

it('uses explicit current scope without inferring it from the source artifact', async () => {
  const { handle } = await knowledgeStore();
  const capture = await planCapture(handle, 'Cache policy', ['Retain the privacy exception.']);
  const read = readProjectRationale(handle, {
    candidates: [{ artifactId: capture.plan.artifactId, eventId: capture.eventId }],
    boundary: 'now',
    observation: handle.read(() => null).counters.writeSequence,
  }).value;
  const item = read.items[0]!;
  expect(parseRationaleSelector(item.reference)).toMatchObject({ kind: 'capture' });
  expect(expandProjectRationaleContext(handle, item.reference).value).toMatchObject({
    status: 'available',
    selection: { scope: { kind: 'project', project_id: handle.authority.projectId } },
  });
  const foreign = await knowledgeStore();
  expect(expandProjectRationaleContext(foreign.handle, item.reference).value.status).toBe(
    'unavailable'
  );
});

it('does not return context when its source is restricted or its field is missing', async () => {
  const { handle } = await knowledgeStore();
  const capture = await planCapture(handle, 'Private policy', ['Retain private responses.']);
  await interpret(handle, capture, 0, true);
  const token = rationaleSelector({
    kind: 'capture',
    id: capture.eventId,
    path: 'plan_steps.0.acceptance_criteria.0.text',
  });
  expect(expandProjectRationaleContext(handle, token).value.status).toBe('unavailable');
  const open = await planCapture(handle, 'Public policy', ['Keep public responses.']);
  const altered = rationaleSelector({
    kind: 'capture',
    id: open.eventId,
    path: 'plan_steps.0.acceptance_criteria.99.text',
  });
  expect(expandProjectRationaleContext(handle, altered).value.status).toBe('unavailable');
});

it('exports a small exact account from a source larger than the ordinary read allowance', async () => {
  const { handle } = await knowledgeStore();
  const capture = await closeCapture(
    handle,
    await planCapture(handle, 'Storage policy', []),
    [
      { decision: 'Use WAL.', reason: 'Keep readers responsive.' },
      { decision: 'Retain audit detail.', reason: 'Audit detail. '.repeat(85_000) },
    ],
    ['src/storage.ts']
  );
  const account = {
    path: 'decisions.0.decision',
    kind: 'decision',
    wording: 'Use WAL.',
    reason: 'Keep readers responsive.',
    alternatives: [],
  };
  const token = rationaleSelector({ kind: 'capture', id: capture.eventId, path: account.path });
  expect(expandProjectRationale(handle, token).value.status).toBe('unavailable');
  expect(expandProjectRationale(handle, token, RATIONALE_EXPORT_SOURCE_BYTES).value).toMatchObject({
    status: 'available',
    content: account,
  });
});
