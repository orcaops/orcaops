import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { runRetentionGit } from './git-process.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tracedGit(events: unknown[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'retention-git-trace-'));
  roots.push(root);
  const trace = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  await writeFile(
    path.join(root, 'git'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(3, ${JSON.stringify(trace)});\n`,
    { mode: 0o700 }
  );
  vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH ?? ''}`);
  return runRetentionGit(root, ['hash-object', '-w', '--stdin'], { traceFlush: true });
}

it('reads hardware flushes from legacy Git data events', async () => {
  await expect(
    tracedGit([{ event: 'data', category: 'fsync', key: 'fsync/hardware-flush', value: '1' }])
  ).resolves.toMatchObject({ hardwareFlushes: 1 });
});

it('reads hardware flushes from Git counter events', async () => {
  await expect(
    tracedGit([{ event: 'counter', category: 'fsync', name: 'hardware-flush', count: 1 }])
  ).resolves.toMatchObject({ hardwareFlushes: 1 });
});

it('does not treat writeout or unrelated counters as hardware flushes', async () => {
  await expect(
    tracedGit([
      { event: 'counter', category: 'fsync', name: 'writeout-only', count: 1 },
      { event: 'counter', category: 'other', name: 'hardware-flush', count: 1 },
      { event: 'data', category: 'fsync', key: 'fsync/writeout-only', value: '1' },
    ])
  ).resolves.toMatchObject({ hardwareFlushes: 0 });
});

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'invalid'])(
  'rejects an invalid hardware flush count %s in either trace format',
  async (count) => {
    await expect(
      tracedGit([{ event: 'counter', category: 'fsync', name: 'hardware-flush', count }])
    ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
    await expect(
      tracedGit([
        { event: 'data', category: 'fsync', key: 'fsync/hardware-flush', value: String(count) },
      ])
    ).rejects.toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
  }
);
