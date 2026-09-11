import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupProjectDatabase } from '@orcaops/core/history/database-setup';
import { uuidv7 } from '@orcaops/storage';

import { runClaimLedger } from './claimLedgerCli.js';
import { executeDatabaseReviewData } from './database/floor-command.js';
import type { ReviewArgs } from './run.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]) {
  return (
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', ...args], {
      cwd,
    })
  ).stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'orcaops-ledger-'));
  roots.push(root);
  const gitRoot = path.join(root, 'repo');
  await mkdir(gitRoot);
  await git(gitRoot, ['init', '--quiet', '--initial-branch=main']);
  await writeFile(path.join(gitRoot, 'value.txt'), 'original\n');
  await git(gitRoot, ['add', 'value.txt']);
  await git(gitRoot, ['commit', '--quiet', '-m', 'Original base']);
  const authority = (
    await setupProjectDatabase({
      cwd: gitRoot,
      root: path.join(root, 'history'),
      authoredPayloads: [],
      secretAllow: [],
    })
  ).initialization.authority;
  // The verbs resolve their data root from the environment, as the CLI does.
  vi.stubEnv('ORCAOPS_DATA_DIR', path.join(root, 'history'));
  return { root, gitRoot, dataRoot: path.join(root, 'history'), authority };
}

const args = (branch: string): ReviewArgs =>
  ({ cmd: 'review', sub: 'ledger', branch, json: true }) as ReviewArgs;

describe('claim ledger', () => {
  it('refuses without publishing anything when the review has no selected floor', async () => {
    // The ledger restates what the floor covers. Emitting one over a floor it
    // cannot read would misstate claims, so it refuses instead.
    const fixture = await repository();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runClaimLedger(args('main'), fixture.gitRoot)).toBe(1);
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('"ok":false');
    expect(stderr.mock.calls.length + stdout.mock.calls.length).toBeGreaterThan(0);
  }, 60_000);

  it('derives the ledger on read and writes no file beside the review', async () => {
    // ledger-v1.json is retired: the ledger is rebuildable render data, so it
    // never advances an authoritative counter and never lands on disk.
    const fixture = await repository();
    await executeDatabaseReviewData({
      branch: 'main',
      root: fixture.gitRoot,
      dataRoot: fixture.dataRoot,
      projectId: fixture.authority.projectId,
      operationId: uuidv7(),
      generatedAt: '2026-06-01T00:00:00.000Z',
      secretAllow: [],
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runClaimLedger(args('main'), fixture.gitRoot)).toBe(0);
    const emitted = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(emitted).toContain('"ok":true');
    expect(emitted).not.toContain('ledger-v1.json');
    await expect(readdir(path.join(fixture.gitRoot, '.orcaops', 'reviews'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 60_000);
});
