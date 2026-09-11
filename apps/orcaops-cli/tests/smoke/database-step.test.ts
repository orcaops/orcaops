import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { readProjectArtifact } from '@orcaops/storage/history/database';

import { fixture, inventory } from '../helpers/database-history.js';

const execute = promisify(execFile);
it('reads a historical step brief through the executable without application writes', async () => {
  const f = await fixture();
  const id = await f.capture(undefined, { task: 'Visible task\rspoofed[31m task' });
  const stepId = readProjectArtifact(f.writer, id)!.thread.plan!.plan_steps[0].step_id;
  await f.recordFiles(id, ['src/retained.ts']);
  const before = await inventory(f.temporary);
  const run = (args: string[]) =>
    execute(
      process.execPath,
      [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), 'step', 'brief', ...args],
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
  const json = await run([stepId, '--json']);
  expect(JSON.parse(json.stdout)).toMatchObject({
    ok: true,
    schema_version: 3,
    artifact_id: id,
    step: { step_id: stepId, label: 'Retained evidence' },
    claim_state: { state: 'unclaimed' },
    related_closed_checkpoints: [],
    completeness: { complete: true },
  });
  const human = await run([stepId]);
  expect(human.stdout).toContain(`Step brief — Retained evidence (artifact ${id})`);
  expect(human.stdout).toContain('claim state:  unclaimed');
  await expect(run(['no-such-step', '--json'])).rejects.toMatchObject({ code: 1 });
  expect(await inventory(f.temporary)).toEqual(before);
});
