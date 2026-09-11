import { rename } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { projectDatabasePath } from '@orcaops/storage/history/database';

import { buildProgram } from '../../src/cli/program.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { createReview } from '../helpers/database-review.js';
import { makeAgent } from '../support/test-agent.js';

it('reads exact branchless review health through registered CLI dispatch without writes', async () => {
  const f = await fixture(),
    reviewId = await createReview(f, null);
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const before = await inventory(f.temporary);
  const result = await agent.runRaw([
    'review',
    'state',
    'health',
    '--project',
    f.authority.projectId,
    '--review',
    reviewId,
    '--json',
  ]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    schema_version: 3,
    status: 'HEALTHY',
    project_id: f.authority.projectId,
    review_id: reviewId,
    branch: null,
  });
  expect(await inventory(f.temporary)).toEqual(before);
}, 20_000);
it('qualifies ambiguous branch reviews and honors the root override from outside Git', async () => {
  const f = await fixture(),
    first = await createReview(f, 'main');
  await createReview(f, 'main');
  const agent = makeAgent({
    cwd: f.temporary,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const before = await inventory(f.temporary);
  const ambiguous = await agent.runRaw([
    'review',
    'state',
    'health',
    '--root',
    f.main,
    '--branch',
    'main',
    '--json',
  ]);
  expect(ambiguous.exitCode, ambiguous.stderr).toBe(1);
  const result = JSON.parse(ambiguous.stdout);
  expect(result).toMatchObject({ code: 'REVIEW_SELECTION_REQUIRED', ok: false });
  expect(result.candidates).toHaveLength(2);
  const exact = await agent.runRaw([
    'review',
    'state',
    'health',
    '--project',
    f.authority.projectId,
    '--review',
    first,
    '--json',
  ]);
  expect(exact.exitCode, exact.stderr).toBe(0);
  expect(JSON.parse(exact.stdout).review_id).toBe(first);
  expect(await inventory(f.temporary)).toEqual(before);
}, 20_000);
it('reports a deleted registered database as missing history without replacement', async () => {
  const f = await fixture(),
    reviewId = await createReview(f, 'main');
  f.writer.close();
  const databasePath = projectDatabasePath(f.authority);
  await rename(databasePath, databasePath + '.retained');
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  try {
    const result = await agent.runRaw([
      'review',
      'state',
      'health',
      '--review',
      reviewId,
      '--json',
    ]);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'HISTORY_MISSING', ok: false });
    const fs = await import('node:fs/promises');
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rename(databasePath + '.retained', databasePath);
  }
}, 20_000);
it('retains the named cloud review status registration separately from local health', () => {
  const review = buildProgram({ cloudBaseUrl: 'https://example.invalid' }).commands.find(
    (command) => command.name() === 'review'
  )!;
  expect(review.commands.find((command) => command.name() === 'status')?.description()).toContain(
    "My open PRs' review state"
  );
  expect(
    review.commands
      .find((command) => command.name() === 'status')
      ?.options.map((option) => option.long)
  ).not.toContain('--review');
});
