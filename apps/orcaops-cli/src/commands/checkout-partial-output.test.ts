import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import { createDatabaseCheckoutAction } from './checkout.js';

afterEach(() => vi.restoreAllMocks());
it('reports partial checkout when only the original binding committed', async () => {
  const identity = { operationId: uuidv7(), focusOperationId: uuidv7(), artifactId: uuidv7() };
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const action = createDatabaseCheckoutAction({
    prepare: async () => ({
      prepared: {},
      identity,
      authority: {},
      shellKey: { kind: 'codex_session', value: 'original' },
    }),
    openWriter: async () => ({ close() {} }),
    publish: async () => ({
      operationId: identity.operationId,
      artifactId: identity.artifactId,
      binding: {
        replayed: false,
        value: {
          artifactId: identity.artifactId,
          executionVersion: 2,
          bindingGeneration: 2,
          focusOperationId: identity.focusOperationId,
        },
        counters: { writeSequence: 2, intentChangeCounter: 1 },
      },
      focus: {
        state: 'failed',
        operationId: identity.focusOperationId,
        publication: null,
        error: new ProjectDatabaseError('STALE_CONTEXT', 'The original focus slot changed'),
      },
    }),
  } as unknown as Parameters<typeof createDatabaseCheckoutAction>[0]);
  await expect(action({ artifactId: identity.artifactId, json: true })).rejects.toMatchObject({
    code: 1,
  });
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toMatchObject({
    ok: false,
    action: 'partial',
    binding: { state: 'committed' },
    focus: { state: 'failed', publication: null },
    operation_id: identity.operationId,
    focus_operation_id: identity.focusOperationId,
  });
});
