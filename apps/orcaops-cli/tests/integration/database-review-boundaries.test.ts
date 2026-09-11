import { afterEach, expect, it, vi } from 'vitest';

import { resolveDatabaseHistoryScope } from '../../../../packages/project-scope/src/database-scope.js';
import { closeDatabaseReviewScope } from '../../../../packages/review-engine/src/database/source-scope.js';
import { HistoryError } from '../../../../packages/storage/dist/history/authority.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { createReview } from '../helpers/database-review.js';
import { makeAgent } from '../support/test-agent.js';

afterEach(() => vi.restoreAllMocks());

it.each(['argument', 'environment'] as const)(
  'resolves a relative %s root from the actual invocation cwd',
  async (mode) => {
    const f = await fixture();
    const reviewId = await createReview(f, null);
    const before = await inventory(f.temporary);
    const agent = makeAgent({
      cwd: f.temporary,
      env: {
        ORCAOPS_DATA_DIR: f.root,
        ORCAOPS_DISABLE_DRAIN: '1',
        ...(mode === 'environment' ? { ORCAOPS_ROOT: 'main' } : {}),
      },
    });
    const result = await agent.runRaw([
      'review',
      'state',
      'health',
      '--review',
      reviewId,
      '--json',
      ...(mode === 'argument' ? ['--root', 'main'] : []),
    ]);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema_version: 3,
      review_id: reviewId,
      project_id: f.authority.projectId,
      status: 'HEALTHY',
    });
    expect(await inventory(f.temporary)).toEqual(before);
  },
  20_000
);

it('keeps explicit absolute root precedence over a different environment root', async () => {
  const f = await fixture();
  const reviewId = await createReview(f, null);
  const before = await inventory(f.temporary);
  const result = await makeAgent({
    cwd: f.temporary,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_ROOT: f.linked, ORCAOPS_DISABLE_DRAIN: '1' },
  }).runRaw(['review', 'state', 'health', '--root', f.main, '--review', reviewId, '--json']);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).review_id).toBe(reviewId);
  expect(await inventory(f.temporary)).toEqual(before);
}, 20_000);

it('preserves a genuine history diagnosis when the owned reader also fails to close', async () => {
  const f = await fixture();
  const scope = await resolveDatabaseHistoryScope({ cwd: f.main, root: f.root, profile: 'exact' });
  const primary = new HistoryError(
    'HISTORY_UNEXPECTED_OWNER',
    'Retain original evidence ownership'
  );
  const closing = new Error('controlled reader close failure');
  const close = scope.close;
  scope.close = () => {
    close();
    throw closing;
  };
  expect(() => closeDatabaseReviewScope(scope, primary)).toThrow(
    expect.objectContaining({ code: 'HISTORY_UNEXPECTED_OWNER', message: primary.message })
  );
  expect(f.writer.read(() => true).value).toBe(true);
}, 20_000);
