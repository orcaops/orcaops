import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';

const execute = promisify(execFile);
it('inspects task status through the executable without changing application state', async () => {
  const f = await fixture();
  const id = await f.capture();
  const before = await inventory(f.temporary);
  const result = await execute(
    process.execPath,
    [
      fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)),
      'status',
      '--project',
      f.authority.projectId,
      '--json',
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
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    schema_version: 3,
    artifacts: [expect.objectContaining({ id, project_id: f.authority.projectId })],
    eligible_tasks: [expect.objectContaining({ artifact_id: id })],
    history: { state: 'available', complete: true },
  });
  expect(await inventory(f.temporary)).toEqual(before);
});
