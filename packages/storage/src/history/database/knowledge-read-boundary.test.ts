// A boundary is named or asked for, never guessed, and never later than what this store committed.
import { afterEach, expect, it } from 'vitest';

import { knowledgeBoundaryAt, knowledgeReadRequest } from './knowledge-read-boundary.js';
import { authorityStore } from '../../../tests/knowledge-authority-store.js';
import { counters, discardKnowledgeStores, read } from '../../../tests/knowledge-store.js';

afterEach(discardKnowledgeStores);

it('reads the committed write sequence as what now is', async () => {
  const store = await authorityStore();
  expect(read(store.handle, knowledgeBoundaryAt)).toBe(counters(store.handle).writeSequence);
});

it('asks for now rather than defaulting a boundary', async () => {
  const store = await authorityStore();
  const request = read(store.handle, (view) =>
    knowledgeReadRequest(view, { scope: store.project, mode: 'current', boundary: 'now' })
  );
  expect(request.knowledge_boundary).toBe(counters(store.handle).writeSequence);
  expect(request.implementation).toEqual({ kind: 'none_selected' });
  expect(request.exceptions_judged_at).toBeNull();
});

it('keeps the boundary, mode, implementation and applicability the caller named', async () => {
  const store = await authorityStore();
  const request = read(store.handle, (view) =>
    knowledgeReadRequest(view, {
      scope: store.artifact,
      mode: 'historical',
      boundary: 2,
      applicability: { environment: ['staging'] },
      exceptionsJudgedAt: '2026-09-17T12:00:00.000Z',
      exceptionConditions: { 'exception-1': true },
    })
  );
  expect(request).toMatchObject({
    scope: store.artifact,
    mode: 'historical',
    knowledge_boundary: 2,
    applicability: { environment: ['staging'] },
    exceptions_judged_at: '2026-09-17T12:00:00.000Z',
    exception_conditions: { 'exception-1': true },
  });
});

it('refuses a boundary later than the committed write sequence', async () => {
  const store = await authorityStore();
  const committed = counters(store.handle).writeSequence;
  expect(() =>
    read(store.handle, (view) =>
      knowledgeReadRequest(view, {
        scope: store.project,
        mode: 'historical',
        boundary: committed + 1,
      })
    )
  ).toThrow(
    expect.objectContaining({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('later than the committed write sequence'),
    })
  );
});

it.each([-1, 1.5, Number.NaN])('refuses %s as a write sequence', async (boundary) => {
  const store = await authorityStore();
  expect(() =>
    read(store.handle, (view) =>
      knowledgeReadRequest(view, { scope: store.project, mode: 'historical', boundary })
    )
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
