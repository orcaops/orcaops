import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('preserves original non-UUID step identity through compiled publication and completion metadata', () => {
  const candidate = fileURLToPath(new URL('../../../../../', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [path.join(candidate, 'packages/storage/tests/step-identity-control.mjs'), candidate],
    { encoding: 'utf8', env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } }
  );
  expect(JSON.parse(output)).toMatchObject({
    ok: true,
    originalStepId: 'original non-UUID step',
    checks: [
      'actual initial non-UUID identity publication',
      'actual closed non-UUID completion',
      'retained thread and metadata exact identities',
    ],
  });
});
