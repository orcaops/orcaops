import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { inputFile } from '@orcaops/test-harness';

import { fixture, inventory } from '../helpers/database-history.js';
import { plantBlockViolation } from '../support/test-helpers.js';

const execute = promisify(execFile);
it('returns BLOCKED and exit one from the executable without changing history', async () => {
  const f = await fixture();
  const env = {
    ...process.env,
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_DISABLE_DRAIN: '1',
    NODE_DISABLE_COMPILE_CACHE: '1',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    CODEX_SESSION_ID: 'blocked-summary-session',
    XDG_STATE_HOME: f.temporary + '/state',
  };
  const run = (args: string[]) =>
    execute(
      process.execPath,
      [fileURLToPath(new URL('../../bin/orcaops.js', import.meta.url)), ...args],
      { cwd: f.main, env, timeout: 30_000 }
    );
  const planned = await run([
    'capture',
    'plan',
    '--no-llm',
    '--input',
    inputFile(
      JSON.stringify({
        idempotency_key: 'blocked-plan',
        task: 'Retain blocked work',
        label: 'Blocked work',
        plan_steps: [{ text: 'Verify the change', label: 'Verify' }],
      })
    ),
  ]);
  const { artifact_id } = JSON.parse(planned.stdout) as { artifact_id: string };
  await plantBlockViolation({
    fixture: f,
    artifactId: artifact_id,
    evaluatorRef: 'test-pack/api-stub',
  });
  const before = await inventory(f.temporary);
  await expect(
    run([
      'capture',
      'summary',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: 'blocked-summary',
          artifact_id,
          outcome: 'Attempted completion',
        })
      ),
    ])
  ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"code":"BLOCKED"') });
  expect(await inventory(f.temporary)).toEqual(before);
}, 60_000);
