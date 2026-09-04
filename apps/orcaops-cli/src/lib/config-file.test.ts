import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearCommonDirCache, commonConfigLocation, Repo } from '@orcaops/core';
import { createLinkedWorktree, createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  displayConfigPath,
  openConfigForScope,
  openEffectiveConfig,
  refuseTrackedPersonalTransition,
  trackedProjectInstallPaths,
  writeConfigDocument,
} from './config-file.js';

const personal = JSON.stringify({
  schema_version: 6,
  install: { agents: ['claude-code'], scope: 'personal' },
});

describe('config-file', () => {
  let main: TempRepo;
  let linked: TempRepo;

  beforeEach(async () => {
    clearCommonDirCache();
    main = await createTempRepo({ initialBranch: 'main' });
    linked = await createLinkedWorktree(main.path);
  });
  afterEach(async () => {
    await linked.cleanup();
    await main.cleanup();
    clearCommonDirCache();
  });

  it('shows a worktree config repo-relative and the shared one absolute', async () => {
    const shared = await commonConfigLocation(linked.path);
    expect(displayConfigPath(shared, linked.path)).toBe(shared.configPath);
    expect(path.isAbsolute(displayConfigPath(shared, linked.path))).toBe(true);
    const worktree = await openConfigForScope(main.path, 'project').catch(() => null);
    expect(worktree).toBeNull();
    expect(
      displayConfigPath(
        { ...shared, origin: 'worktree', configPath: path.join(main.path, '.orcaops/config.json') },
        main.path
      )
    ).toBe(path.join('.orcaops', 'config.json'));
  });

  it('opens the shared config from a linked worktree and writes it back in place', async () => {
    const shared = await commonConfigLocation(linked.path);
    await mkdir(path.dirname(shared.configPath), { recursive: true });
    await writeFile(shared.configPath, personal, 'utf8');

    const document = await openEffectiveConfig(linked.path);
    expect(document.location.origin).toBe('common');
    // Containment is the common dir: a worktree-rooted check would refuse
    // the file the resolver just selected.
    expect(document.location.containmentRoot).toBe(shared.containmentRoot);
    document.raw.archive = { enabled: false };
    await writeConfigDocument(document);

    const after = JSON.parse(await readFile(shared.configPath, 'utf8')) as {
      archive: { enabled: boolean };
      install: { scope: string };
    };
    expect(after.archive.enabled).toBe(false);
    expect(after.install.scope).toBe('personal');
  });

  it('reports an uninitialized repository as UNINITIALIZED', async () => {
    await expect(openEffectiveConfig(linked.path)).rejects.toMatchObject({
      code: 'UNINITIALIZED',
    });
  });

  it('targets the destination scope, not the effective source', async () => {
    const shared = await commonConfigLocation(main.path);
    await mkdir(path.dirname(shared.configPath), { recursive: true });
    await writeFile(shared.configPath, personal, 'utf8');
    // Effective source is the shared personal config; a project destination
    // is still the (absent) worktree file.
    await expect(openConfigForScope(main.path, 'project')).rejects.toMatchObject({
      code: 'UNINITIALIZED',
    });
    expect((await openConfigForScope(main.path, 'personal')).location.origin).toBe('common');
  });

  it('names only the tracked install files, and points the refusal at update', async () => {
    await mkdir(path.join(main.path, '.orcaops'), { recursive: true });
    await writeFile(path.join(main.path, '.orcaops', 'config.json'), '{}', 'utf8');
    await writeFile(path.join(main.path, '.orcaops', 'install.json'), '{}', 'utf8');
    execFileSync('git', ['add', '.orcaops/config.json'], { cwd: main.path });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'cfg'], {
      cwd: main.path,
    });

    const tracked = await trackedProjectInstallPaths(new Repo(main.path), [
      path.join('.orcaops', 'config.json'),
      path.join('.orcaops', 'install.json'),
    ]);
    expect(tracked).toEqual([path.join('.orcaops', 'config.json')]);

    const err = refuseTrackedPersonalTransition(tracked);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('.orcaops/config.json');
    expect(err.message).toContain('orcaops update --scope personal');
  });
});
