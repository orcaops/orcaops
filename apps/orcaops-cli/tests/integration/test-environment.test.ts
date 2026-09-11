import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';

import { makeAgent } from '../support/test-agent.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('integration storage isolation', () => {
  it('resolves the default history into the setup fixture', async () => {
    const root = await normalizeHistoryRoot();
    expect(root.resolvedRoot).toBe(await realpath(process.env.ORCAOPS_DATA_DIR!));
    const result = await makeAgent({ cwd: process.cwd() }).runRaw(['--help']);
    expect(result.exitCode).toBe(0);
  });

  it.each<Record<string, string>>([
    { ORCAOPS_DATA_DIR: path.join(homedir(), '.orcaops') },
    { ORCAOPS_DATA_DIR: '', XDG_DATA_HOME: '' },
    { ORCAOPS_DATA_DIR: '', XDG_DATA_HOME: homedir() },
    { XDG_CACHE_HOME: path.join(homedir(), '.cache') },
    { XDG_STATE_HOME: '' },
  ])('refuses unsafe storage overrides %j before running the CLI', async (env) => {
    // Help is read-only even on an unguarded baseline.
    await expect(makeAgent({ cwd: process.cwd(), env }).runRaw(['--help'])).rejects.toThrow(
      /Test storage isolation/
    );
  });

  it('refuses a temporary symlink that leads to user history', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-isolation-'));
    directories.push(directory);
    await symlink(homedir(), path.join(directory, 'home'), 'junction');
    const agent = makeAgent({
      cwd: directory,
      env: { ORCAOPS_DATA_DIR: path.join(directory, 'home', '.orcaops') },
    });
    await expect(agent.runRaw(['--help'])).rejects.toThrow(/Test storage isolation/);
  });

  it('accepts a temporary data override and the XDG data fallback', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-isolation-'));
    directories.push(directory);
    const overrides: Record<string, string>[] = [
      { ORCAOPS_DATA_DIR: path.join(directory, 'missing', 'history') },
      { ORCAOPS_DATA_DIR: '', XDG_DATA_HOME: directory },
    ];
    for (const env of overrides) {
      const result = await makeAgent({ cwd: directory, env }).runRaw(['--help']);
      expect(result.exitCode).toBe(0);
    }
  });

  it('refuses a dangling history symlink', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-isolation-'));
    directories.push(directory);
    const alias = path.join(directory, 'history');
    await symlink(path.join(directory, 'missing'), alias, 'junction');
    await expect(
      makeAgent({ cwd: directory, env: { ORCAOPS_DATA_DIR: alias } }).runRaw(['--help'])
    ).rejects.toThrow(/Test storage isolation/);
  });
});
