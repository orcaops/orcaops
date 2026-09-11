import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';
import { createReview } from '../helpers/database-review.js';

const execute = promisify(execFile);

it('replays the canonical journal identically through the CLI and the one-shot Node sidecar', async () => {
  const f = await fixture();
  await createReview(f, 'main');
  const before = await inventory(f.temporary);
  const args = ['review', 'journal', '--branch', 'main', '--json'];
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
  const ledger = JSON.parse(cli.stdout) as Record<string, unknown>;
  expect(ledger).toMatchObject({ sections: [], findings: [], coverage: [], prompts: [] });
  expect(typeof ledger.ledger_generation).toBe('string');
  // The retired archive mirror was the only producer of a warnings channel.
  expect(ledger).not.toHaveProperty('warnings');
  expect(JSON.parse(sidecar.stdout)).toEqual(ledger);
  expect(await inventory(f.temporary)).toEqual(before);
});

it('dispatches review pane identically through the CLI and the one-shot Node sidecar', async () => {
  const f = await fixture();
  await createReview(f, 'main');
  const before = await inventory(f.temporary);
  // The review has no published floor, so the pane is not yet available; both
  // compiled entry points must reach the verb and agree on the envelope.
  const args = ['review', 'pane', '--branch', 'main', '--json'];
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
  ).catch((error: { stdout: string }) => error);
  const sidecar = await execute(
    process.execPath,
    [
      fileURLToPath(new URL('../../../../packages/watch-data/dist/sidecar.js', import.meta.url)),
      ...args,
    ],
    options
  ).catch((error: { stdout: string }) => error);
  expect(JSON.parse(cli.stdout)).toMatchObject({ ok: false, code: 'REVIEW_NOT_FOUND' });
  expect(JSON.parse(sidecar.stdout)).toEqual(JSON.parse(cli.stdout));
  expect(await inventory(f.temporary)).toEqual(before);
});
