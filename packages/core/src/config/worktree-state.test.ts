import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLinkedWorktree, createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { readOnlyWorktreeState, worktreeState } from './load.js';
import { clearCommonDirCache, commonConfigLocation } from './source.js';

const personal = JSON.stringify({
  schema_version: 6,
  install: { agents: ['claude-code'], scope: 'personal' },
});

describe('worktreeState', () => {
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

  it('reports an ungoverned worktree as uninitialized even with a stray .orcaops dir', async () => {
    await mkdir(path.join(main.path, '.orcaops', 'artifacts'), { recursive: true });
    expect((await worktreeState(main.path)).kind).toBe('uninitialized');
  });

  it('reports an enabled sibling with no data as empty, without touching the disk', async () => {
    const shared = await commonConfigLocation(main.path);
    await mkdir(path.dirname(shared.configPath), { recursive: true });
    await writeFile(shared.configPath, personal, 'utf8');

    const state = await readOnlyWorktreeState(linked.path);
    expect(state.kind).toBe('enabled');
    expect(state.kind === 'enabled' && state.hot.empty).toBe(true);
    // Probing created nothing.
    await expect(access(path.join(linked.path, '.orcaops'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports hot data once an artifact directory or cache exists', async () => {
    const shared = await commonConfigLocation(main.path);
    await mkdir(path.dirname(shared.configPath), { recursive: true });
    await writeFile(shared.configPath, personal, 'utf8');
    await mkdir(path.join(linked.path, '.orcaops', 'artifacts', 'a1'), { recursive: true });
    const state = await worktreeState(linked.path);
    expect(state.kind === 'enabled' && state.hot.empty).toBe(false);
    expect(state.kind === 'enabled' && state.hot.artifacts).toBe(true);
    // The main worktree is still empty: hot state is per worktree.
    const mainState = await worktreeState(main.path);
    expect(mainState.kind === 'enabled' && mainState.hot.empty).toBe(true);
  });

  it('reports broken instead of guessing when the governing config is unusable', async () => {
    await mkdir(path.join(main.path, '.orcaops'), { recursive: true });
    await writeFile(path.join(main.path, '.orcaops', 'config.json'), '{ nope', 'utf8');
    const state = await worktreeState(main.path);
    expect(state.kind).toBe('broken');
    expect(state.kind === 'broken' && state.error.message).toMatch(/not valid JSON/);
  });
});
