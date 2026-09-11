import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';

const execute = promisify(execFile);
it('lists retained SQLite history through the executable with safe human and JSON output', async () => {
  const f = await fixture();
  const id = await f.capture(undefined, { task: 'Visible task\rspoofed\u001b[31m task' });
  const before = await inventory(f.temporary);
  const run = (flags: string[]) =>
    execute(
      process.execPath,
      [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), 'list', ...flags],
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
  const json = await run(['--json', '--limit', '1']);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    schema_version: 3,
    results: [expect.objectContaining({ artifact_id: id, state: 'planned' })],
    completeness: { complete: true },
    origin_counts: { matching: { captured: 1, imported: 0 } },
  });
  const human = await run(['--limit', '1']);
  expect(human.stdout).toContain('Visible task');
  expect(human.stdout).not.toContain('\r');
  expect(human.stdout).not.toContain(String.fromCharCode(27));
  expect(human.stdout).toContain('Matching: 1 captured, 0 imported.');
  expect(await inventory(f.temporary)).toEqual(before);
});
