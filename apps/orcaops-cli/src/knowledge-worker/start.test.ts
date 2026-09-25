import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isSameScript } from './start.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('recognising the entry this process runs', () => {
  it('matches the entry through the symlink a global install runs it by', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-entry-'));
    directories.push(directory);
    const script = path.join(directory, 'bin', 'orcaops.js');
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, '');
    const link = path.join(directory, 'orcaops');
    await symlink(script, link);

    expect(isSameScript(link, script)).toBe(true);
    expect(isSameScript(script, script)).toBe(true);
  });

  it('refuses another script, whether or not it exists', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-entry-'));
    directories.push(directory);
    const script = path.join(directory, 'orcaops.js');
    await writeFile(script, '');
    const other = path.join(directory, 'vitest.mjs');
    await writeFile(other, '');

    expect(isSameScript(other, script)).toBe(false);
    expect(isSameScript(path.join(directory, 'missing.js'), script)).toBe(false);
  });
});
