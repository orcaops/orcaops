import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { grantsFilePath, readGrants, revokeGrant, writeGrant } from './evaluator-grants.js';
import {
  processingGrantsFilePath,
  readProcessingGrants,
  revokeProcessingGrants,
} from './knowledge-processing-grants.js';
import { isInsideRepositoryWorktree } from './repository-worktree-containment.js';
import { ErrorCodes } from '../io/errors.js';

const TMP = realpathSync(tmpdir());

function volumeIgnoresCase(directory: string): boolean {
  const probe = mkdtempSync(path.join(directory, 'orcaops-CaseProbe-'));
  try {
    return existsSync(path.join(directory, path.basename(probe).toLowerCase()));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const TMP_IGNORES_CASE = volumeIgnoresCase(TMP);

const EVALUATOR_GRANT = {
  kind: 'fingerprint' as const,
  package_id: 'test-pack',
  source_fingerprint: 'a'.repeat(64),
  capabilities: ['command_evaluators_present' as const],
  granted_at: '2026-01-01T00:00:00.000Z',
};

const PROCESSING_GRANT = {
  grant_id: '0b0e4c1e-6f0a-4a57-9d52-3f3c1f1f7a01',
  capability: 'capture_content_llm_processing',
  project_id: 'project-a',
  provider: 'claude',
  processor_contract: 'knowledge-processor/1',
  source_scope: { admitted_after_sequence: 0, backlog: 'included' },
  disclosed: {
    provider: 'claude',
    model: { selection: 'provider_default' },
    tool_access: 'none',
    limits: {
      max_cost_usd_per_call: 'none',
      max_cost_usd_per_day: 'none',
      max_calls_per_hour: 60,
      max_input_bytes: 131_072,
      max_output_bytes: 65_536,
    },
    paused_backlog_count: 0,
  },
  granted_at: '2026-01-01T00:00:00.000Z',
};

/** A private config home holding one valid grant for each store. */
async function plantStores(configDir: string): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    grantsFilePath(configDir),
    `${JSON.stringify({ v: 1, grants: [EVALUATOR_GRANT] })}\n`,
    { mode: 0o600 }
  );
  await writeFile(
    processingGrantsFilePath(configDir),
    `${JSON.stringify({ v: 1, grants: [PROCESSING_GRANT] })}\n`,
    { mode: 0o600 }
  );
}

async function expectBothStoresRefuse(configDir: string, repoRoot: string): Promise<void> {
  const warnings: string[] = [];
  expect(readGrants({ configDir, repoRoot, warn: (message) => warnings.push(message) })).toEqual({
    grants: [],
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('outside the repository');
  expect(readProcessingGrants({ configDir, repoRoot })).toMatchObject({
    grants: [],
    problems: [{ code: 'store_not_outside_repository' }],
  });

  const refusal = {
    code: ErrorCodes.INVALID_INPUT,
    message: expect.stringMatching(/outside the repository/),
  };
  await expect(writeGrant(EVALUATOR_GRANT, { configDir, repoRoot })).rejects.toMatchObject(refusal);
  await expect(revokeGrant('test-pack', { configDir, repoRoot })).rejects.toMatchObject(refusal);
  await expect(
    revokeProcessingGrants({ project_id: 'project-a' }, { configDir, repoRoot })
  ).rejects.toMatchObject(refusal);
}

function expectBothStoresTrust(configDir: string, repoRoot: string): void {
  expect(readGrants({ configDir, repoRoot }).grants).toEqual([EVALUATOR_GRANT]);
  expect(readProcessingGrants({ configDir, repoRoot })).toEqual({
    grants: [PROCESSING_GRANT],
    problems: [],
  });
}

let sandbox: string;
beforeEach(async () => {
  sandbox = await mkdtemp(path.join(TMP, 'orcaops-Containment-'));
});
afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('grant store containment by directory identity', () => {
  it('trusts a private store outside the repository', async () => {
    const repoRoot = path.join(sandbox, 'RepoDir');
    const configDir = path.join(sandbox, 'config-home');
    await mkdir(repoRoot);
    await plantStores(configDir);

    expect(isInsideRepositoryWorktree(configDir, repoRoot)).toBe(false);
    expectBothStoresTrust(configDir, repoRoot);
  });

  it.skipIf(!TMP_IGNORES_CASE)(
    'refuses another spelling of a store inside the repository on a volume that ignores case',
    async () => {
      const repoRoot = path.join(sandbox, 'RepoDir');
      await plantStores(path.join(repoRoot, 'home'));
      const respelled = path.join(sandbox, 'repodir', 'home');

      expect(isInsideRepositoryWorktree(respelled, repoRoot)).toBe(true);
      await expectBothStoresRefuse(respelled, repoRoot);
      await expectBothStoresRefuse(
        path.join(sandbox, 'REPODIR', 'home', 'not-created-yet'),
        repoRoot
      );
    }
  );

  it('refuses a symlinked path into the repository, however deep the link sits', async () => {
    const repoRoot = path.join(sandbox, 'RepoDir');
    await plantStores(path.join(repoRoot, 'nested', 'home'));
    const alias = path.join(sandbox, 'alias');
    await symlink(path.join(repoRoot, 'nested'), alias);

    expect(isInsideRepositoryWorktree(path.join(alias, 'home'), repoRoot)).toBe(true);
    await expectBothStoresRefuse(path.join(alias, 'home'), repoRoot);
  });

  it('judges a store that does not exist yet by its nearest existing ancestor', async () => {
    const repoRoot = path.join(sandbox, 'RepoDir');
    await mkdir(path.join(repoRoot, 'nested'), { recursive: true });

    expect(isInsideRepositoryWorktree(path.join(repoRoot, 'nested', 'a', 'b'), repoRoot)).toBe(
      true
    );
    expect(isInsideRepositoryWorktree(path.join(sandbox, 'elsewhere', 'a'), repoRoot)).toBe(false);
  });
});

describe('grant store containment across worktrees of one repository', () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Containment Test',
        '-c',
        'user.email=containment@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, stdio: 'ignore' }
    );
  }

  let main: string;
  let linked: string;
  beforeEach(async () => {
    main = path.join(sandbox, 'main-checkout');
    linked = path.join(sandbox, 'linked-checkout');
    await mkdir(main);
    git(main, 'init', '-q');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'root');
    git(main, 'worktree', 'add', '-q', '-b', 'linked-branch', linked);
  });

  it('refuses a store inside the main worktree when the repository root is a linked one', async () => {
    const configDir = path.join(main, 'home');
    await plantStores(configDir);

    expect(isInsideRepositoryWorktree(configDir, linked)).toBe(true);
    await expectBothStoresRefuse(configDir, linked);
  });

  it('refuses a store inside a linked worktree when the repository root is the main one', async () => {
    const configDir = path.join(linked, 'home');
    await plantStores(configDir);

    expect(isInsideRepositoryWorktree(configDir, main)).toBe(true);
    await expectBothStoresRefuse(configDir, main);
  });

  it('refuses a store inside one linked worktree when the repository root is another', async () => {
    const second = path.join(sandbox, 'second-linked-checkout');
    git(main, 'worktree', 'add', '-q', '-b', 'second-branch', second);
    const configDir = path.join(second, 'home');
    await plantStores(configDir);

    await expectBothStoresRefuse(configDir, linked);
  });

  it('still trusts a store beside the worktrees', async () => {
    const configDir = path.join(sandbox, 'config-home');
    await plantStores(configDir);

    expectBothStoresTrust(configDir, linked);
    expectBothStoresTrust(configDir, main);
  });

  it('ignores a registered worktree whose directory is gone', async () => {
    await rm(linked, { recursive: true, force: true });
    const configDir = path.join(sandbox, 'config-home');
    await plantStores(configDir);

    expectBothStoresTrust(configDir, main);
  });
});
