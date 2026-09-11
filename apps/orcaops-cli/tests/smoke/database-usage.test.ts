import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';
import { tokens, usageObservation } from '../helpers/database-usage.js';

const execute = promisify(execFile);
it('reads SQLite usage through the executable with exact and estimate labels', async () => {
  const f = await fixture();
  const id = await f.capture();
  await usageObservation(f.writer, id, 10);
  await usageObservation(f.writer, id, 20, {
    baseline_kind: 'checkpoint_open',
    delta_usage: tokens(10),
  });
  const before = await inventory(f.temporary);
  const run = (flags: string[]) =>
    execute(
      process.execPath,
      [
        fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)),
        'usage',
        '--artifact',
        id,
        ...flags,
      ],
      {
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
      }
    );
  const json = await run(['--json']);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    schema_version: 3,
    artifact_id: id,
    usage: { accounting: { status: 'exact', totals: tokens(20) } },
  });
  const human = await run([]);
  expect(human.stdout).toContain('Exact selected session totals: in 20');
  expect(human.stdout).toContain('estimate (not additive): in 10');
  expect(await inventory(f.temporary)).toEqual(before);
});
