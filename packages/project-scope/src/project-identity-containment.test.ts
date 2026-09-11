import { describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import { createTempRepo } from '@orcaops/test-harness';

import {
  ensureProjectId,
  InvalidProjectIdentityError,
  PROJECT_ID_CONFIG_KEY,
  ProjectIdentityReadError,
  readProjectId,
} from './project-identity.js';

describe('stored project identity', () => {
  it('serializes first-use minting across independent repository handles', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    let initialReads = 0;
    let writes = 0;
    let releaseInitialReads!: () => void;
    const initialReadsComplete = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });

    class RacingRepo extends Repo {
      override async getLocalConfig(key: string): Promise<string | null> {
        if (initialReads < 2) {
          initialReads += 1;
          if (initialReads === 2) releaseInitialReads();
          await initialReadsComplete;
          return null;
        }
        return super.getLocalConfig(key);
      }

      override async setLocalConfig(key: string, value: string): Promise<void> {
        writes += 1;
        await super.setLocalConfig(key, value);
      }
    }

    try {
      const results = await Promise.all([
        ensureProjectId(new RacingRepo(repo.path)),
        ensureProjectId(new RacingRepo(repo.path)),
      ]);
      expect(new Set(results.map((result) => result.projectId)).size).toBe(1);
      expect(results.map((result) => result.minted).sort()).toEqual([false, true]);
      expect(writes).toBe(1);
      expect(await readProjectId(new Repo(repo.path))).toBe(results[0]?.projectId);
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses malformed, empty, or traversing stored identity instead of treating it as missing', async () => {
    const repo = await createTempRepo({ initialBranch: 'main' });
    try {
      await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, '../../victim');
      const error = await readProjectId(new Repo(repo.path)).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(InvalidProjectIdentityError);
      expect(error).toMatchObject({
        message: expect.stringContaining('run `orcaops doctor`'),
      });
      expect((error as Error).message).toContain('verified original project id');
      expect((error as Error).message).not.toContain('--unset');
      expect((error as Error).message).not.toContain('archive');
      await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, 'not-a-uuid');
      await expect(readProjectId(new Repo(repo.path))).rejects.toThrow(/not a canonical UUIDv7/);
      await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, '');
      await expect(readProjectId(new Repo(repo.path))).rejects.toThrow(/not a canonical UUIDv7/);
      await new Repo(repo.path).setLocalConfig(PROJECT_ID_CONFIG_KEY, '   ');
      await expect(readProjectId(new Repo(repo.path))).rejects.toThrow(/not a canonical UUIDv7/);
    } finally {
      await repo.cleanup();
    }
  });

  it('turns a config read failure into a typed error without minting', async () => {
    let wrote = false;
    const repo = {
      getLocalConfig: async () => {
        throw new Error('git failed');
      },
      setLocalConfig: async () => {
        wrote = true;
      },
    } as unknown as Repo;
    await expect(ensureProjectId(repo)).rejects.toBeInstanceOf(ProjectIdentityReadError);
    expect(wrote).toBe(false);
  });
});
