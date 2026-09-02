import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, type TempRepo } from '@orcaops/test-harness';

import { grantsFilePath, readGrants, writeGrant } from '../../src/lib/evaluator-grants.js';
import { evaluatorsConfigPath, readEvaluatorsConfig } from '../../src/lib/evaluators-config.js';
import { makeAgent } from '../support/test-agent.js';
import { TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

describe('evaluator config mutations', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let tmpRoot: string;
  let packPath: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path });
    await agent.init({ noLlm: true });
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-evaluator-config-'));
    packPath = path.join(tmpRoot, 'pack');
    await cp(TEST_PACK_ABS_PATH, packPath, { recursive: true });
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function mutationBytes(): Promise<{ config: Buffer; grants: Buffer }> {
    return {
      config: await readFile(evaluatorsConfigPath(repo.path)),
      grants: await readFile(grantsFilePath()),
    };
  }

  async function expectMutationBytes(expected: { config: Buffer; grants: Buffer }): Promise<void> {
    const observed = await mutationBytes();
    expect(observed.config.equals(expected.config)).toBe(true);
    expect(observed.grants.equals(expected.grants)).toBe(true);
  }

  it('rejects aliases, retired profiles, duplicates, and phantom refs without mutation', async () => {
    const added = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
    expect(added.exitCode).toBe(0);

    const grant = readGrants({ repoRoot: repo.path }).grants.find(
      (candidate) => candidate.package_id === 'test-pack'
    );
    expect(grant).toBeDefined();
    await writeGrant(
      { ...grant!, granted_at: 'preserved-by-failed-command' },
      { repoRoot: repo.path }
    );
    const before = await mutationBytes();

    const alias = await agent.runRaw([
      'eval',
      'add-pack',
      packPath,
      '--id',
      'alias',
      '--yes',
      '--json',
    ]);
    expect(alias.exitCode).toBe(1);
    expect(alias.stderr).toMatch(/unknown option.*--id/i);
    await expectMutationBytes(before);

    const retiredProfile = await agent.runRaw([
      'eval',
      'add-pack',
      packPath,
      '--force',
      '--profile',
      'llm',
      '--yes',
      '--json',
    ]);
    expect(retiredProfile.exitCode).toBe(1);
    expect(retiredProfile.stderr).toMatch(/argument 'llm' is invalid/i);
    await expectMutationBytes(before);

    const duplicate = await agent.runRaw(['eval', 'add-pack', packPath, '--yes', '--json']);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stdout).toContain('PACK_ALREADY_INSTALLED');
    await expectMutationBytes(before);

    const phantom = await agent.runRaw(['eval', 'enable', 'test-pack/not-real', '--json']);
    expect(phantom.exitCode).toBe(1);
    expect(phantom.stdout).toContain('EVALUATOR_NOT_FOUND');
    await expectMutationBytes(before);

    const exact = await agent.runRaw(['eval', 'enable', 'test-pack/pass-fixture', '--json']);
    expect(exact.exitCode).toBe(0);

    const removed = await agent.runRaw(['eval', 'remove-pack', 'test-pack', '--json']);
    expect(removed.exitCode).toBe(0);
    expect((JSON.parse(removed.stdout) as { grant_revoked: boolean }).grant_revoked).toBe(true);
    expect(
      readGrants({ repoRoot: repo.path }).grants.find(
        (candidate) => candidate.package_id === 'test-pack'
      )
    ).toBeUndefined();
    const config = await readEvaluatorsConfig(repo.path);
    expect(config?.packages.some((candidate) => candidate.id === 'test-pack')).toBe(false);
    expect(Object.keys(config?.evaluators ?? {}).some((ref) => ref.startsWith('test-pack/'))).toBe(
      false
    );
  });
});
