import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';

const execute = promisify(execFile);
it('resumes an exact task through the executable without writing focus or cache', async () => {
  const f = await fixture();
  const id = await f.capture();
  const before = await inventory(f.temporary);
  const result = await execute(
    process.execPath,
    [
      fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)),
      'resume',
      '--artifact',
      id,
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
    resolved: true,
    artifact_id: id,
    project_id: f.authority.projectId,
    resolution_via: 'explicit',
    eligibility: { state: 'eligible' },
  });
  expect(await inventory(f.temporary)).toEqual(before);
});
