import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { restoreConfigIfAbsent } from './uninstall.js';

describe('uninstall purge recovery', () => {
  let dataRoot: string;
  let configPath: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-purge-restore-'));
    configPath = path.join(dataRoot, 'config.json');
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('restores the prior config when the target remains absent', async () => {
    await restoreConfigIfAbsent(dataRoot, configPath, 'prior config');
    expect(await readFile(configPath, 'utf8')).toBe('prior config');
  });

  it('preserves an intervening config instead of restoring over it', async () => {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(configPath, 'intervening config', 'utf8');

    await restoreConfigIfAbsent(dataRoot, configPath, 'prior config');

    expect(await readFile(configPath, 'utf8')).toBe('intervening config');
  });
});
