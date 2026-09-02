import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { commitFile } from '../support/test-helpers.js';

/**
 * `orcaops snapshots checkout`.
 *
 * Covers: materialization per phase (incl. the per-status default), the
 * untracked-file like-for-like property, live-worktree non-mutation,
 * `--into` validation, the CACHEDIR.TAG placement rule, and the
 * `SNAPSHOT_UNAVAILABLE` taxonomy (phase-vs-status, deliberate skip,
 * pruned refs).
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath }).toString().trim();
}

describe('orcaops snapshots checkout', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;
  let cacheHome: string;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    cacheHome = await mkdtemp(path.join(tmpdir(), 'orcaops-checkout-cache-'));
    agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DISABLE_DRAIN: '1', XDG_CACHE_HOME: cacheHome },
    });
    await agent.runRaw(['init', '--json', '--no-llm']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  /**
   * Plan → open cp1 → (commit tracked + write untracked) → close cp1.
   * Returns artifact_id. The open boundary predates the files; the close
   * boundary contains both (untracked files are snapshotted via add -A).
   */
  async function closedArtifact(): Promise<string> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'checkout fixture',
          label: `s1-checkout-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    await commitFile(repo.path, 'tracked.ts', 'export const tracked = 1;\n', 'work');
    await writeFile(path.join(repo.path, 'untracked.txt'), 'never committed\n', 'utf8');
    const close = await agent.runRaw([
      'capture',
      'checkpoint',
      'close',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `close-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          n: 1,
          summary: 'cp1',
          files_changed: ['tracked.ts'],
          verification: [{ command: 'test fixture', exit_code: 0 }],
          completed_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    expect(close.exitCode).toBe(0);
    return plan.artifact_id;
  }

  async function abandonedArtifact(): Promise<string> {
    const pr = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `plan-${randomUUID()}`,
          task: 'abandon fixture',
          label: `s1-abandon-${randomUUID().slice(0, 8)}`,
          plan_steps: [{ text: 'step a', label: 's1' }],
          touched_scope: [],
        })
      ),
    ]);
    const plan = JSON.parse(pr.stdout) as {
      artifact_id: string;
      plan_steps: Array<{ step_id: string }>;
    };
    await agent.runRaw([
      'capture',
      'checkpoint',
      'open',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `open-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          declared_step_ids: [plan.plan_steps[0].step_id],
        })
      ),
    ]);
    await commitFile(repo.path, 'doomed.ts', 'export const doomed = 1;\n', 'doomed work');
    const ab = await agent.runRaw([
      'capture',
      'checkpoint',
      'abandon',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: `abandon-${randomUUID()}`,
          artifact_id: plan.artifact_id,
          n: 1,
          reason: 'fixture abandon',
        })
      ),
    ]);
    expect(ab.exitCode).toBe(0);
    return plan.artifact_id;
  }

  function checkout(args: string[]): Promise<CliResult> {
    return agent.runRaw(['snapshots', 'checkout', ...args]);
  }

  it('materializes the close boundary by default, incl. untracked files, without touching the live worktree', async () => {
    const artifactId = await closedArtifact();
    const headBefore = git(repo.path, ['rev-parse', 'HEAD']);

    const r = await checkout(['--artifact', artifactId, '--checkpoint', '1', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      phase: string;
      dir: string;
      tree_sha: string;
      snapshot_ref: string;
      cleanup: string;
    };
    expect(out.phase).toBe('close');
    expect(out.snapshot_ref).toBe(`refs/orcaops/snap/${artifactId}/1/close`);
    expect(out.cleanup).toContain('git worktree remove --force');

    // The materialized tree carries the tracked AND the untracked file.
    expect(await readFile(path.join(out.dir, 'tracked.ts'), 'utf8')).toBe(
      'export const tracked = 1;\n'
    );
    expect(await readFile(path.join(out.dir, 'untracked.txt'), 'utf8')).toBe('never committed\n');
    // It is a real (linked) worktree — `.git` file exists.
    await access(path.join(out.dir, '.git'));

    // Live worktree untouched: HEAD unchanged, file contents unchanged.
    expect(git(repo.path, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await readFile(path.join(repo.path, 'tracked.ts'), 'utf8')).toBe(
      'export const tracked = 1;\n'
    );

    // Default location: under XDG_CACHE_HOME/orcaops/checkouts, with the
    // CACHEDIR.TAG at the ROOT only — never inside the checkout.
    const root = path.join(cacheHome, 'orcaops', 'checkouts');
    expect(out.dir.startsWith(`${root}${path.sep}`)).toBe(true);
    await access(path.join(root, 'CACHEDIR.TAG'));
    await expect(access(path.join(out.dir, 'CACHEDIR.TAG'))).rejects.toThrow();
  });

  it('materializes the open boundary (pre-work tree) with --phase open', async () => {
    const artifactId = await closedArtifact();
    const r = await checkout([
      '--artifact',
      artifactId,
      '--checkpoint',
      '1',
      '--phase',
      'open',
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { dir: string; phase: string };
    expect(out.phase).toBe('open');
    // Work happened AFTER open — neither file exists at the open boundary.
    await expect(access(path.join(out.dir, 'tracked.ts'))).rejects.toThrow();
    await expect(access(path.join(out.dir, 'untracked.txt'))).rejects.toThrow();
  });

  it('defaults to the abandon boundary on an abandoned cp; --phase close is SNAPSHOT_UNAVAILABLE', async () => {
    const artifactId = await abandonedArtifact();

    const ok = await checkout(['--artifact', artifactId, '--checkpoint', '1', '--json']);
    expect(ok.exitCode).toBe(0);
    const out = JSON.parse(ok.stdout) as { phase: string; dir: string };
    expect(out.phase).toBe('abandon');
    expect(await readFile(path.join(out.dir, 'doomed.ts'), 'utf8')).toBe(
      'export const doomed = 1;\n'
    );

    const bad = await checkout([
      '--artifact',
      artifactId,
      '--checkpoint',
      '1',
      '--phase',
      'close',
      '--json',
    ]);
    expect(bad.exitCode).toBe(1);
    const err = JSON.parse(bad.stdout) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('SNAPSHOT_UNAVAILABLE');
    expect(err.error.message).toContain('abandoned');
  });

  it('honors --into for a fresh dir and rejects a non-empty one with INVALID_INPUT', async () => {
    const artifactId = await closedArtifact();
    const fresh = path.join(cacheHome, 'into-fresh');
    const r = await checkout([
      '--artifact',
      artifactId,
      '--checkpoint',
      '1',
      '--into',
      fresh,
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.stdout) as { dir: string }).dir).toBe(fresh);

    const dirty = path.join(cacheHome, 'into-dirty');
    await mkdir(dirty, { recursive: true });
    await writeFile(path.join(dirty, 'occupied.txt'), 'x', 'utf8');
    const bad = await checkout([
      '--artifact',
      artifactId,
      '--checkpoint',
      '1',
      '--into',
      dirty,
      '--json',
    ]);
    expect(bad.exitCode).toBe(1);
    const err = JSON.parse(bad.stdout) as { error: { code: string } };
    expect(err.error.code).toBe('INVALID_INPUT');
  });

  it('reports SNAPSHOT_UNAVAILABLE with pruned-ref + auto-prune context once refs and objects are gone', async () => {
    const artifactId = await closedArtifact();
    // Wipe the artifact's snap refs, then actually expire the objects —
    // deleting refs alone leaves loose objects reachable by sha.
    const prune = await agent.runRaw([
      'snapshots',
      'prune',
      '--artifact',
      artifactId,
      '--apply',
      '--json',
    ]);
    expect(prune.exitCode).toBe(0);
    git(repo.path, ['reflog', 'expire', '--expire=now', '--all']);
    git(repo.path, ['gc', '--prune=now', '--quiet']);

    const r = await checkout(['--artifact', artifactId, '--checkpoint', '1', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('SNAPSHOT_UNAVAILABLE');
    expect(err.error.message).toContain('pruned');
    expect(err.error.message).toContain('auto-prune');
  });

  it('reports a deliberate skip as SNAPSHOT_UNAVAILABLE when diff_fingerprint was disabled at capture', async () => {
    const configPath = path.join(repo.path, '.orcaops', 'config.json');
    const existing = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({ ...existing, diff_fingerprint: { enabled: false } }, null, 2),
      'utf8'
    );
    const artifactId = await closedArtifact();

    const r = await checkout(['--artifact', artifactId, '--checkpoint', '1', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('SNAPSHOT_UNAVAILABLE');
    expect(err.error.message).toContain('deliberately skipped');
  });

  it('rejects unknown checkpoints and artifacts with the derive-precedent codes', async () => {
    const artifactId = await closedArtifact();
    const noCp = await checkout(['--artifact', artifactId, '--checkpoint', '9', '--json']);
    expect(noCp.exitCode).toBe(1);
    expect((JSON.parse(noCp.stdout) as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT'
    );

    const noArtifact = await checkout(['--artifact', 'nope', '--checkpoint', '1', '--json']);
    expect(noArtifact.exitCode).toBe(1);
    expect((JSON.parse(noArtifact.stdout) as { error: { code: string } }).error.code).toBe(
      'UNKNOWN_ARTIFACT'
    );
  });
});
