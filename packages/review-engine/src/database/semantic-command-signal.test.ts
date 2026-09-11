import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('cancels public writer waits and preserves committed receipts with invocation listener cleanup', async () => {
  const probe = fileURLToPath(new URL('../../tests/semantic-signal-probe.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [probe], {
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
    timeout: 75_000,
  });
  expect(stdout).toContain('"phase":"actual-public-SIGINT"');
  expect(stdout).toContain('"phase":"original-retry-late-signal"');
  expect(stdout).toContain('"status":"PASS"');
}, 80_000);
