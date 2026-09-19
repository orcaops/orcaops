import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inventory } from './database-history.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const repo = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inventory-locks-'));
  roots.push(root);
  await mkdir(path.join(root, '.git/objects'), { recursive: true });
  await mkdir(path.join(root, '.git/refs/heads'), { recursive: true });
  await writeFile(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(root, '.git/refs/heads/main'), 'a'.repeat(40) + '\n');
  await writeFile(path.join(root, 'tracked.txt'), 'content\n');
  return root;
};

describe('fixture inventory', () => {
  it('ignores the lock files git writes while it works', async () => {
    const root = await repo();
    const quiet = await inventory(root);

    await writeFile(path.join(root, '.git/objects/maintenance.lock'), '');
    await writeFile(path.join(root, '.git/index.lock'), '');
    await writeFile(path.join(root, '.git/refs/heads/main.lock'), 'b'.repeat(40) + '\n');
    const busy = await inventory(root);

    expect(busy).toEqual(quiet);
    expect(Object.keys(busy).filter((entry) => entry.endsWith('.lock'))).toEqual([]);
  });

  it('keeps a lock file that belongs to the work tree rather than to git', async () => {
    const root = await repo();
    await writeFile(path.join(root, 'package-lock.json'), '{}\n');
    await writeFile(path.join(root, 'src.lock'), 'held\n');
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested/deploy.lock'), 'held\n');

    expect(Object.keys(await inventory(root))).toEqual(
      expect.arrayContaining(['package-lock.json', 'src.lock', path.join('nested', 'deploy.lock')])
    );
  });
});
