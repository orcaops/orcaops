import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { grantsFilePath } from '../../src/lib/evaluator-grants.js';
import { evaluatorsConfigPath } from '../../src/lib/evaluators-config.js';
import { makeAgent } from '../support/test-agent.js';
import { TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

const renameFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string) => {
      await actual.rename(oldPath, newPath);
      if (renameFailure.enabled && newPath.replaceAll('\\', '/').endsWith('/evaluators.yaml')) {
        renameFailure.enabled = false;
        throw new Error('injected evaluator config rename failure');
      }
    },
  };
});

describe('evaluator config and grant rollback', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let tmpRoot: string;

  beforeEach(async () => {
    renameFailure.enabled = false;
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-evaluator-rollback-'));
  });

  afterEach(async () => {
    renameFailure.enabled = false;
    await repo.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('restores both files when config rename fails after replacing the grant', async () => {
    const firstPack = path.join(tmpRoot, 'first-pack');
    const replacementPack = path.join(tmpRoot, 'replacement-pack');
    await cp(TEST_PACK_ABS_PATH, firstPack, { recursive: true });
    await cp(TEST_PACK_ABS_PATH, replacementPack, { recursive: true });
    const added = await agent.runRaw(['eval', 'add-pack', firstPack, '--yes', '--json']);
    expect(added.exitCode).toBe(0);

    const configPath = evaluatorsConfigPath(repo.path);
    const grantPath = grantsFilePath();
    const beforeConfig = await readFile(configPath);
    const beforeGrants = await readFile(grantPath);

    renameFailure.enabled = true;
    const failed = await agent.runRaw([
      'eval',
      'add-pack',
      replacementPack,
      '--force',
      '--yes',
      '--json',
    ]);
    renameFailure.enabled = false;
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toMatch(/evaluator mutation failed|injected evaluator config rename/i);

    expect((await readFile(configPath)).equals(beforeConfig)).toBe(true);
    expect((await readFile(grantPath)).equals(beforeGrants)).toBe(true);
  });
});
