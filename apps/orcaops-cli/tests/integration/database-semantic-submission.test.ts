import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import {
  decode,
  type RestoredFixture,
  restoreFixture,
  snapshot,
} from '../../../../packages/storage/tests/database-fixture.mjs';
import { makeAgent } from '../support/test-agent.js';

const candidate = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtures: RestoredFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
it('publishes semantic input through registered dispatch and replays the original receipt with unavailable evidence', async () => {
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
  await writeFile(path.join(f.temporary, 'input.json'), original.submissionBytes);
  const agent = makeAgent({
    cwd: f.temporary,
    env: { ORCAOPS_DATA_DIR: f.authority.resolvedRoot, ORCAOPS_DISABLE_DRAIN: '1' },
  });
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
    'input.json',
    '--operation-id',
    operationId,
    '--json',
  ];
  const published = await agent.runRaw(argv);
  expect(published.exitCode, published.stderr || published.stdout).toBe(0);
  const result = JSON.parse(published.stdout);
  expect(result).toMatchObject({
    ok: true,
    operation_id: operationId,
    run_id: original.runId,
    accepted: true,
    replayed: false,
    history: { status: 'AVAILABLE' },
  });
  const committed = snapshot(f.Database, f.file);
  await rm(path.join(path.dirname(f.file), 'evidence'), { recursive: true });
  const repeated = await agent.runRaw(argv);
  expect(repeated.exitCode, repeated.stderr || repeated.stdout).toBe(1);
  expect(JSON.parse(repeated.stdout)).toMatchObject({
    ok: false,
    accepted: true,
    replayed: true,
    receipt: result.receipt,
    history: { status: 'UNAVAILABLE' },
  });
  expect(snapshot(f.Database, f.file)).toEqual(committed);
  await writeFile(path.join(f.temporary, 'input.json'), '{}');
  const different = await agent.runRaw(argv);
  expect(different.exitCode, different.stderr).toBe(1);
  expect(JSON.parse(different.stdout)).toMatchObject({
    ok: false,
    code: 'IDEMPOTENCY_CONFLICT',
    operation_id: operationId,
  });
  expect(snapshot(f.Database, f.file)).toEqual(committed);
}, 20_000);
