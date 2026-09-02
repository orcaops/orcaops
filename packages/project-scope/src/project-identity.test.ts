import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Repo } from '@orcaops/core';

import {
  ensureProjectId,
  PROJECT_ID_CONFIG_KEY,
  ProjectIdentityConfigLockTimeoutError,
} from './project-identity.js';

interface FakeRepoState {
  value: string | null;
  set?: (value: string) => Promise<void>;
}

function fakeRepo(commonDir: string, state: FakeRepoState): Repo {
  return {
    getCommonDirAbsolute: async () => commonDir,
    getLocalConfig: async (key: string) => {
      expect(key).toBe(PROJECT_ID_CONFIG_KEY);
      return state.value;
    },
    setLocalConfig: async (key: string, value: string) => {
      expect(key).toBe(PROJECT_ID_CONFIG_KEY);
      if (state.set) await state.set(value);
      else state.value = value;
    },
  } as unknown as Repo;
}

describe('project identity minting', () => {
  let commonDir: string;

  beforeEach(async () => {
    commonDir = await mkdtemp(path.join(tmpdir(), 'orcaops-project-id-'));
  });

  afterEach(async () => {
    await rm(commonDir, { recursive: true, force: true });
  });

  it('releases the mint lock when identity persistence throws', async () => {
    const state: FakeRepoState = {
      value: null,
      set: async () => {
        throw new Error('disk unavailable');
      },
    };

    await expect(ensureProjectId(fakeRepo(commonDir, state))).rejects.toThrow('disk unavailable');

    // A second caller must be able to acquire and mint — proves the lock
    // was released rather than left held by the failed attempt.
    state.set = undefined;
    const result = await ensureProjectId(fakeRepo(commonDir, state));
    expect(result.minted).toBe(true);
  });

  it('retries Git config lock contention separately from the mint lock', async () => {
    const state: FakeRepoState = { value: null };
    let attempts = 0;
    state.set = async (value) => {
      attempts += 1;
      if (attempts < 3) throw new Error('fatal: could not lock config file .git/config: exists');
      state.value = value;
    };

    const result = await ensureProjectId(fakeRepo(commonDir, state), {
      configAcquireMs: 100,
      configRetryMs: 5,
    });

    expect(result.minted).toBe(true);
    expect(attempts).toBe(3);
  });

  it('times out Git config contention with a distinct remedy', async () => {
    const repo = fakeRepo(commonDir, {
      value: null,
      set: async () => {
        throw new Error('fatal: could not lock config file .git/config: exists');
      },
    });

    await expect(
      ensureProjectId(repo, { configAcquireMs: 20, configRetryMs: 5 })
    ).rejects.toBeInstanceOf(ProjectIdentityConfigLockTimeoutError);
  });
});
