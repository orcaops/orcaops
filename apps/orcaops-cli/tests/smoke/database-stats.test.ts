import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { fixture, inventory } from '../helpers/database-history.js';
import { tokens, usageObservation } from '../helpers/database-usage.js';

const execute = promisify(execFile);
it('reads scoped statistics through the executable without application writes', async () => {
  const f = await fixture();
  const id = await f.capture(undefined, { task: 'Visible task\rspoofed[31m task' });
  await f.recordFiles(id, ['src/retained.ts']);
  await usageObservation(f.writer, id, 10);
  const before = await inventory(f.temporary);
  const run = (flags: string[]) =>
    execute(
      process.execPath,
      [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), 'stats', ...flags],
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
    artifacts: { total: 1, by_status: { active: 1 } },
    checkpoints: { total: 1, by_status: { closed: 1 } },
    coding_sessions: { total: 1, tokens: tokens(10) },
    hygiene: { diff_attributed_pct: null, closed_cp_without_completed_steps: 1 },
    completeness: { complete: true },
  });
  expect(JSON.stringify(JSON.parse(json.stdout))).not.toContain('Visible task');
  const human = await run([]);
  expect(human.stdout).toContain('Store stats');
  expect(human.stdout).toContain('artifacts:   1 (active=1)');
  expect(human.stdout).toContain('coding sessions: 1 (in 10 / out 0');
  await expect(run(['--all-projects', '--json'])).rejects.toMatchObject({ code: 1 });
  expect(await inventory(f.temporary)).toEqual(before);
});
