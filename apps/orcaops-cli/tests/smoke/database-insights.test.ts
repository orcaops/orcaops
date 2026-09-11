import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';

const execute = promisify(execFile);
it('reads decisions and current loose ends through the executable without application writes', async () => {
  const f = await fixture();
  const id = await f.capture(undefined, {
    decisions: [
      {
        decision: 'Use retained database history',
        reason: 'Keep original evidence',
        revision_n: 0,
      },
    ],
  });
  const before = await inventory(f.temporary);
  const run = (args: string[]) =>
    execute(
      process.execPath,
      [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), ...args],
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
  for (const command of ['decisions', 'loose-ends']) {
    const result = await run([
      command,
      '--project',
      f.authority.projectId,
      '--artifact',
      id,
      '--json',
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      schema_version: 3,
      results: [expect.objectContaining({ artifact_id: id, project_id: f.authority.projectId })],
      completeness: { complete: true },
      page: { inspected: 1, returned: 1 },
    });
    const scoped = await run([
      command,
      '--scope',
      'project',
      '--branch',
      'main',
      '--origin',
      'captured',
      '--limit',
      '1',
      '--json',
    ]);
    expect(JSON.parse(scoped.stdout).results[0].artifact_id).toBe(id);
    await expect(run([command, '--all-projects', '--json'])).rejects.toMatchObject({ code: 1 });
  }
  expect(await inventory(f.temporary)).toEqual(before);
});
