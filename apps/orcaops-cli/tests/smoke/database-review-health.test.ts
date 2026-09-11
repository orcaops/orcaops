import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';
import { createReview } from '../helpers/database-review.js';

const execute = promisify(execFile);
it('reads identical canonical review health through the CLI and one-shot Node sidecar', async () => {
  const f = await fixture(),
    reviewId = await createReview(f, null),
    before = await inventory(f.temporary);
  const args = [
    'review',
    'state',
    'health',
    '--project',
    f.authority.projectId,
    '--review',
    reviewId,
    '--json',
  ];
  const options = {
    cwd: f.main,
    env: {
      ...process.env,
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_DISABLE_DRAIN: '1',
      NODE_DISABLE_COMPILE_CACHE: '1',
    },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  };
  const cli = await execute(
    process.execPath,
    [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), ...args],
    options
  );
  const sidecar = await execute(
    process.execPath,
    [
      fileURLToPath(new URL('../../../../packages/watch-data/dist/sidecar.js', import.meta.url)),
      ...args,
    ],
    options
  );
  expect(JSON.parse(cli.stdout)).toMatchObject({
    schema_version: 3,
    status: 'HEALTHY',
    review_id: reviewId,
    branch: null,
  });
  expect(JSON.parse(sidecar.stdout)).toEqual(JSON.parse(cli.stdout));
  expect(await inventory(f.temporary)).toEqual(before);
});
