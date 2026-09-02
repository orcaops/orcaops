import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EvaluatorContext } from '@orcaops/evaluator-protocol';
import { makeContext as makeBaseContext, runFixture } from '@orcaops/evaluator-sdk';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd });

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '../../../dist/packs/js');

let scratchRepo: string;

beforeEach(async () => {
  scratchRepo = realpathSync(await mkdtemp(path.join(tmpdir(), 'orcaops-api-sig-drift-')));
});

afterEach(async () => {
  await rm(scratchRepo, { recursive: true, force: true });
});

async function gitCommit(file: string, content: string, msg: string): Promise<string> {
  const abs = path.join(scratchRepo, file);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  await git(scratchRepo, ['add', file]);
  await git(scratchRepo, ['commit', '-m', msg, '--quiet']);
  return (await git(scratchRepo, ['rev-parse', 'HEAD'])).stdout.trim();
}

function makeContext(opts: { baseSha: string; changedFiles: string[] }): EvaluatorContext {
  const base = makeBaseContext();
  return makeBaseContext({
    evaluator_ref: 'js/api-signature-drift',
    phase: 'checkpoint-close',
    checkpoint_n: 1,
    // A real scratch repo — this evaluator diffs the worktree, so the root
    // and base_sha have to point at commits that actually exist.
    repo: { root: scratchRepo, branch: 'main', base_sha: opts.baseSha, head_sha: 'HEAD' },
    plan: { ...base.plan, base_sha: opts.baseSha },
    changed_files: opts.changedFiles,
  });
}

describe('api-signature-drift (runFixture)', () => {
  it('pass: no TS/JS files in scope changed since plan.base_sha', async () => {
    // Init a repo + make a commit so base_sha exists, but don't
    // mark any TS file as changed.
    await git(scratchRepo, ['init']);
    await git(scratchRepo, ['config', 'user.email', 'test@test']);
    await git(scratchRepo, ['config', 'user.name', 'Test']);
    const baseSha = await gitCommit('README.md', '# repo\n', 'initial');
    const r = await runFixture({
      command: ['node', './runtime/api-signature-drift.js'],
      cwd: packRoot,
      context: makeContext({ baseSha, changedFiles: [] }),
      timeoutMs: 60_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('pass');
    expect(r.envelope.body).toMatch(/No TS\/JS files in scope changed/);
  }, 60_000);

  it('violation: removed export shows up as a signature change', async () => {
    await git(scratchRepo, ['init']);
    await git(scratchRepo, ['config', 'user.email', 'test@test']);
    await git(scratchRepo, ['config', 'user.name', 'Test']);
    // Commit both alpha + beta exports at base_sha.
    const baseSha = await gitCommit(
      'src/api.ts',
      'export function alpha(x: number) { return x; }\n' +
        'export function beta(y: string) { return y.length; }\n',
      'initial api'
    );
    // Mutate the working tree to remove beta — don't commit; the
    // runtime compares HEAD@baseSha to the working tree directly.
    await writeFile(
      path.join(scratchRepo, 'src/api.ts'),
      'export function alpha(x: number) { return x; }\n',
      'utf8'
    );
    const r = await runFixture({
      command: ['node', './runtime/api-signature-drift.js'],
      cwd: packRoot,
      context: makeContext({ baseSha, changedFiles: ['src/api.ts'] }),
      timeoutMs: 60_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.envelope.verdict).toBe('violation');
    expect(r.envelope.body).toMatch(/beta/);
  }, 60_000);
});
