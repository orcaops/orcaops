import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

import * as scope from '@orcaops/project-scope/history/database';
import { uuidv7 } from '@orcaops/storage';

import {
  decode,
  type RestoredFixture,
  restoreFixture,
  snapshot,
} from '../../../storage/tests/database-fixture.mjs';
import * as runtime from '../runtimeIdentity.js';
import { executeDatabaseSemanticCommand } from './semantic-command.js';
import * as publisher from './semantic-publish.js';

vi.mock('@orcaops/project-scope/history/database', async (original) => ({
  ...(await original<typeof scope>()),
}));
vi.mock('../runtimeIdentity.js', async (original) => ({ ...(await original<typeof runtime>()) }));
vi.mock('./semantic-publish.js', async (original) => ({ ...(await original<typeof publisher>()) }));
const candidate = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtures: RestoredFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.cleanup();
});
async function fixture() {
  const filename = path.join(
    candidate,
    'packages/storage/src/history/database/fixtures/semantic-review.json'
  );
  const f = await restoreFixture(candidate, filename);
  fixtures.push(f);
  const original = decode(JSON.parse(await readFile(filename, 'utf8')).semanticInput) as {
    reviewId: string;
    runId: string;
    submissionBytes: Uint8Array;
  };
  const operationId = uuidv7();
  const argv = [
    'review',
    'semantic-anchor-submit',
    '--project',
    f.authority.projectId,
    '--review',
    original.reviewId,
    '--run',
    original.runId,
    '--profile',
    'semantic-anchor-profile-v1',
    '--input',
    '-',
    '--operation-id',
    operationId,
  ];
  const context = {
    cwd: f.temporary,
    env: { ORCAOPS_DATA_DIR: f.authority.resolvedRoot, ORCAOPS_ROOT: f.temporary },
    runtime: {
      packageRoot: path.join(candidate, 'packages/review-engine'),
      entrypointPath: path.join(candidate, 'packages/review-engine/dist/run.js'),
    },
  };
  return { ...f, original, operationId, argv, context };
}
it('keeps the original invocation and authored bytes across runtime observation', async () => {
  const f = await fixture();
  const originalArgs = [...f.argv];
  const originalContext = structuredClone(f.context);
  const bytes = Buffer.from(f.original.submissionBytes);
  const observe = runtime.observeReviewExecutableIdentity;
  vi.spyOn(runtime, 'observeReviewExecutableIdentity').mockImplementationOnce(async (...args) => {
    f.argv.fill('changed');
    f.context.cwd = '/changed';
    f.context.env.ORCAOPS_DATA_DIR = '/changed';
    f.context.env.ORCAOPS_ROOT = '/changed';
    f.context.runtime.packageRoot = '/changed';
    f.context.runtime.entrypointPath = '/changed';
    bytes.fill(0xff);
    return observe(...args);
  });
  const result = await executeDatabaseSemanticCommand(f.argv, f.context, { preparedBytes: bytes });
  expect(result).toMatchObject({
    ok: true,
    operation_id: f.operationId,
    review_id: f.original.reviewId,
    run_id: f.original.runId,
  });
  const replay = await executeDatabaseSemanticCommand(originalArgs, originalContext, {
    preparedBytes: f.original.submissionBytes,
  });
  expect(replay.receipt).toEqual(result.receipt);
  expect(replay.replayed).toBe(true);
}, 20_000);
it('refuses publication when the authority reader cannot close', async () => {
  const f = await fixture();
  const before = snapshot(f.Database, f.file);
  const resolve = scope.resolveDatabaseHistoryScope;
  vi.spyOn(scope, 'resolveDatabaseHistoryScope').mockImplementationOnce(async (...args) => {
    const selected = await resolve(...args);
    return {
      ...selected,
      close() {
        selected.close();
        throw new Error('reader close failed');
      },
    };
  });
  const publish = vi.spyOn(publisher, 'publishDatabaseSemanticGeneration');
  await expect(
    executeDatabaseSemanticCommand(f.argv, f.context, { preparedBytes: f.original.submissionBytes })
  ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
  expect(publish).not.toHaveBeenCalled();
  expect(snapshot(f.Database, f.file)).toEqual(before);
});
it('retains a known committed receipt when cancellation stops its subsequent history read', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const publish = publisher.publishDatabaseSemanticGeneration;
  const publication = vi
    .spyOn(publisher, 'publishDatabaseSemanticGeneration')
    .mockImplementationOnce(async (...args) => {
      const committed = await publish(...args);
      controller.abort();
      return committed;
    });
  const result = await executeDatabaseSemanticCommand(f.argv, f.context, {
    preparedBytes: f.original.submissionBytes,
    signal: controller.signal,
  });
  expect(result).toMatchObject({
    ok: false,
    accepted: true,
    replayed: false,
    history: { status: 'UNAVAILABLE', code: 'CANCELLED' },
  });
  const before = snapshot(f.Database, f.file);
  const replay = await executeDatabaseSemanticCommand(f.argv, f.context, {
    preparedBytes: f.original.submissionBytes,
  });
  expect(replay).toMatchObject({ ok: true, replayed: true, receipt: result.receipt });
  expect(publication).toHaveBeenCalledTimes(1);
  expect(snapshot(f.Database, f.file)).toEqual(before);
}, 20_000);
