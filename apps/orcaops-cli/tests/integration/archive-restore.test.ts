import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REVIEW_STATE_VERSION, reviewFloorLockKey, reviewLocksDir } from '@orcaops/review-engine';
import { archiveReviewPaths, ArtifactLock, writePin } from '@orcaops/storage';
import { createTempRepo, gitClient, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';
import { effectiveConfigPath } from '../support/test-helpers.js';

/**
 * `resume --artifact` archive fallback through the real CLI:
 * capture in "worktree" A, cold-start in fresh repo B sharing the same
 * project identity, resume restores from the archive and the thread
 * continues (new checkpoints mirror back to the SAME archive dir).
 */

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function parseOk<T>(r: CliResult): T {
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout) as { ok: boolean };
  expect(parsed.ok).toBe(true);
  return parsed as T;
}

describe('resume --artifact archive fallback', () => {
  let repoA: TempRepo;
  let repoB: TempRepo;
  let dataRoot: string;
  let env: Record<string, string>;
  let artifactId: string;
  let stepIds: string[];
  let projectId: string;

  async function enableArchive(repoPath: string): Promise<void> {
    const configPath = await effectiveConfigPath(repoPath);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    config.archive = { enabled: true, redact_secrets: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  beforeEach(async () => {
    repoA = await createTempRepo({ initialBranch: 'main' });
    repoB = await createTempRepo({ initialBranch: 'main' });
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-restore-data-'));
    env = {
      ORCAOPS_DATA_DIR: dataRoot,
      XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-restore-cache-')),
      XDG_STATE_HOME: await mkdtemp(path.join(tmpdir(), 'orcaops-restore-state-')),
      CLAUDE_SESSION_ID: 'archive-pin-session',
    };

    const agentA = makeAgent({ cwd: repoA.path, env });
    parseOk(await agentA.runRaw(['init', '--json', '--no-llm']));
    await enableArchive(repoA.path);
    const plan = parseOk<{ artifact_id: string; plan_steps: Array<{ step_id: string }> }>(
      await agentA.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `plan-${randomUUID()}`,
            task: 'handoff e2e fixture',
            label: 'handoff e2e fixture',
            plan_steps: [
              { text: 'step one', label: 's1' },
              { text: 'step two', label: 's2' },
            ],
            touched_scope: [],
          })
        ),
      ])
    );
    artifactId = plan.artifact_id;
    stepIds = plan.plan_steps.map((s) => s.step_id);
    parseOk(
      await agentA.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `open-${randomUUID()}`,
            artifact_id: artifactId,
            declared_step_ids: [stepIds[0]],
          })
        ),
      ])
    );
    parseOk(
      await agentA.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `close-${randomUUID()}`,
            artifact_id: artifactId,
            n: 1,
            summary: 'step one done in A',
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [stepIds[0]],
          })
        ),
      ])
    );
    projectId = (
      await gitClient(repoA.path).raw(['config', '--local', '--get', 'orcaops.projectid'])
    ).trim();

    // Repo B: a fresh "clone/worktree" of the same PROJECT — same minted
    // identity (in a real clone the local config travels via the common
    // dir; here we set it the way `git worktree add` sharing would).
    const agentB = makeAgent({ cwd: repoB.path, env });
    parseOk(await agentB.runRaw(['init', '--json', '--no-llm']));
    await enableArchive(repoB.path);
    await gitClient(repoB.path).raw(['config', '--local', 'orcaops.projectid', projectId]);
  }, 60_000);

  afterEach(async () => {
    await repoA.cleanup();
    await repoB.cleanup();
  });

  async function pinArtifactInRepoB(pinnedArtifactId = artifactId): Promise<void> {
    await writePin(
      {
        schema_version: 1,
        artifact_id: pinnedArtifactId,
        branch: 'feat/x',
        shell_key: { kind: 'claude_session', value: 'archive-pin-session' },
        pinned_at: '2026-07-02T12:15:00.000Z',
        pinned_via: 'explicit-checkout',
      },
      {
        repoId: execFileSync('git', ['config', '--local', '--get', 'orcaops.projectid'], {
          cwd: repoB.path,
          encoding: 'utf8',
        }).trim(),
        env,
      }
    );
  }

  async function seedArchivedReview(slug = 'feat%2Fx'): Promise<string> {
    const paths = archiveReviewPaths(
      path.join(dataRoot, 'projects', projectId),
      REVIEW_STATE_VERSION,
      slug
    );
    const raw = JSON.stringify({
      type: 'section',
      ts: '2026-08-11T10:00:00.000Z',
      threadKey: 'section-1',
      action: 'VISIT',
    });
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.journalNdjson, `${raw}\n`, 'utf8');
    return slug;
  }

  async function waitForPath(file: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(file);
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error(`Timed out waiting for ${file}`);
  }

  async function capturePlanInRepoB(
    agentB: ReturnType<typeof makeAgent>,
    task: string
  ): Promise<string> {
    return parseOk<{ artifact_id: string }>(
      await agentB.runRaw([
        'capture',
        'plan',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            task,
            label: task,
            plan_steps: [{ text: task, label: 'work' }],
            touched_scope: [],
          })
        ),
      ])
    ).artifact_id;
  }

  it('cold-starts the artifact in repo B and the thread mirrors back to the same archive dir', async () => {
    const agentB = makeAgent({ cwd: repoB.path, env });
    const reviewSlug = await seedArchivedReview();
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    const linesBefore = (await readFile(archiveLogPath, 'utf8')).trim().split('\n').length;

    const resume = parseOk<{
      restored_from_archive?: boolean;
      review_restore?: { status: string; lines_copied: number };
      artifact_id: string;
      artifact: { task: string };
    }>(await agentB.runRaw(['resume', '--artifact', artifactId, '--no-pin', '--json']));
    expect(resume.restored_from_archive).toBe(true);
    expect(resume.review_restore).toEqual({ status: 'ok', lines_copied: 1 });
    expect(resume.artifact_id).toBe(artifactId);
    expect(resume.artifact.task).toBe('handoff e2e fixture');
    expect(
      await readFile(
        path.join(repoB.path, '.orcaops', 'reviews', reviewSlug, 'journal.ndjson'),
        'utf8'
      )
    ).toContain('"action":"VISIT"');

    // Continue the thread in B: checkpoint 2 on step two.
    parseOk(
      await agentB.runRaw([
        'capture',
        'checkpoint',
        'open',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `open-${randomUUID()}`,
            artifact_id: artifactId,
            declared_step_ids: [stepIds[1]],
          })
        ),
      ])
    );
    parseOk(
      await agentB.runRaw([
        'capture',
        'checkpoint',
        'close',
        '--no-llm',
        '--input',
        inputFile(
          JSON.stringify({
            idempotency_key: `close-${randomUUID()}`,
            artifact_id: artifactId,
            n: 2,
            summary: 'step two done in B',
            verification: [{ command: 'test fixture', exit_code: 0 }],
            completed_step_ids: [stepIds[1]],
          })
        ),
      ])
    );

    // The SAME archive dir grew — B mirrors where A left off.
    const linesAfter = (await readFile(archiveLogPath, 'utf8')).trim().split('\n').length;
    expect(linesAfter).toBeGreaterThan(linesBefore);

    // A second resume needs no restore (hot store now has it).
    const again = parseOk<{ restored_from_archive?: boolean }>(
      await agentB.runRaw(['resume', '--artifact', artifactId, '--no-pin', '--json'])
    );
    expect(again.restored_from_archive).toBeUndefined();
  });

  it('restores an archive-only in-flight artifact through its current-shell pin', async () => {
    await pinArtifactInRepoB();
    await seedArchivedReview();
    const agentB = makeAgent({ cwd: repoB.path, env });

    const resume = parseOk<{
      resolution_via: string;
      restored_from_archive?: boolean;
      review_restore?: { status: string; lines_copied: number };
      artifact_id: string;
    }>(await agentB.runRaw(['resume', '--json']));
    expect(resume.resolution_via).toBe('pin');
    expect(resume.restored_from_archive).toBe(true);
    expect(resume.review_restore).toEqual({ status: 'ok', lines_copied: 1 });
    expect(resume.artifact_id).toBe(artifactId);
  });

  it('waits for the existing hot review-state lock before replaying archive logs', async () => {
    const reviewSlug = await seedArchivedReview();
    const lock = new ArtifactLock({
      locksDir: reviewLocksDir(repoB.path),
      containmentRoot: repoB.path,
      heartbeatIntervalMs: 30_000,
    });
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = lock.withLock(reviewFloorLockKey(reviewSlug), async () => {
      entered();
      await releasePromise;
    });
    await enteredPromise;

    const agentB = makeAgent({ cwd: repoB.path, env });
    let settled = false;
    const pending = agentB
      .runRaw(['resume', '--artifact', artifactId, '--no-pin', '--json'])
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await waitForPath(path.join(repoB.path, '.orcaops', 'artifacts', artifactId));
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(settled).toBe(false);
      await expect(
        readFile(path.join(repoB.path, '.orcaops', 'reviews', reviewSlug, 'journal.ndjson'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release();
    }
    const resume = parseOk<{ review_restore?: { status: string; lines_copied: number } }>(
      await pending
    );
    await held;
    expect(resume.review_restore).toEqual({ status: 'ok', lines_copied: 1 });
  });

  it('reports companion review refusal without undoing a successful artifact restore', async () => {
    const reviewSlug = await seedArchivedReview();
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-review-outside-'));
    const reviewsRoot = path.join(repoB.path, '.orcaops', 'reviews');
    await mkdir(reviewsRoot, { recursive: true });
    await symlink(outside, path.join(reviewsRoot, reviewSlug), 'dir');
    const sentinel = path.join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'unchanged');

    const agentB = makeAgent({ cwd: repoB.path, env });
    const resume = parseOk<{
      restored_from_archive?: boolean;
      review_restore?: { status: string; error: string; progress: string };
      artifact_id: string;
    }>(await agentB.runRaw(['resume', '--artifact', artifactId, '--no-pin', '--json']));
    expect(resume.restored_from_archive).toBe(true);
    expect(resume.artifact_id).toBe(artifactId);
    expect(resume.review_restore?.status).toBe('failed');
    expect(resume.review_restore?.progress).toBe('possibly_partial');
    expect(resume.review_restore?.error).toContain('must not contain symlinks');
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
    expect(
      await access(path.join(repoB.path, '.orcaops', 'artifacts', artifactId))
    ).toBeUndefined();
  });

  it('refuses malformed archived review events while retaining the restored artifact', async () => {
    const reviewSlug = 'malformed';
    const paths = archiveReviewPaths(
      path.join(dataRoot, 'projects', projectId),
      REVIEW_STATE_VERSION,
      reviewSlug
    );
    await mkdir(paths.dir, { recursive: true });
    await writeFile(
      paths.journalNdjson,
      `${JSON.stringify({ type: 'section', ts: 'not-a-timestamp', action: 'VISIT' })}\n`
    );

    const agentB = makeAgent({ cwd: repoB.path, env });
    const resume = parseOk<{
      restored_from_archive?: boolean;
      review_restore?: { status: string; error: string; progress: string };
      artifact_id: string;
    }>(await agentB.runRaw(['resume', '--artifact', artifactId, '--no-pin', '--json']));
    expect(resume.restored_from_archive).toBe(true);
    expect(resume.artifact_id).toBe(artifactId);
    expect(resume.review_restore?.status).toBe('failed');
    expect(resume.review_restore?.progress).toBe('possibly_partial');
    expect(resume.review_restore?.error).toContain('JOURNAL_CORRUPT');
    await expect(
      readFile(path.join(repoB.path, '.orcaops', 'reviews', reviewSlug, 'journal.ndjson'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a corrupt pinned archive target instead of selecting another artifact', async () => {
    const agentB = makeAgent({ cwd: repoB.path, env });
    const fallbackId = await capturePlanInRepoB(agentB, 'fallback work that must not be selected');
    await pinArtifactInRepoB();
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    const archiveLog = await readFile(archiveLogPath, 'utf8');
    await writeFile(
      archiveLogPath,
      archiveLog.replace(/"checksum":"[0-9a-f]{64}"/, `"checksum":"${'0'.repeat(64)}"`),
      'utf8'
    );

    const result = await agentB.runRaw(['resume', '--json']);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe('PIN_RESOLUTION_FAILED');
    expect(parsed.error.message).toContain(artifactId);
    expect(parsed.error.message).toContain('archive repair');
    expect(result.stdout).not.toContain(fallbackId);
  });

  it('returns a typed error when a valid pinned archive cannot restore over hot bytes', async () => {
    const agentB = makeAgent({ cwd: repoB.path, env });
    await capturePlanInRepoB(agentB, 'other local work');
    await pinArtifactInRepoB();
    const archiveLogPath = path.join(
      dataRoot,
      'projects',
      projectId,
      'artifacts',
      artifactId,
      'events.ndjson'
    );
    const archiveLines = (await readFile(archiveLogPath, 'utf8')).trimEnd().split('\n');
    const hotDir = path.join(repoB.path, '.orcaops', 'artifacts', artifactId);
    await mkdir(hotDir, { recursive: true });
    await writeFile(path.join(hotDir, 'events.ndjson'), `${archiveLines.at(-1)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    });

    const result = await agentB.runRaw(['resume', '--json']);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe('PIN_RESOLUTION_FAILED');
    expect(parsed.error.message).toContain('non-prefix subset');
  });

  it('treats a genuinely missing pin target as stale and selects local in-flight work', async () => {
    const missingArtifactId = '01999999-9999-7000-8000-0000000000ff';
    const agentB = makeAgent({ cwd: repoB.path, env });
    const fallbackId = await capturePlanInRepoB(agentB, 'local fallback work');
    await pinArtifactInRepoB(missingArtifactId);

    const resume = parseOk<{ resolution_via: string; artifact_id: string }>(
      await agentB.runRaw(['resume', '--json'])
    );
    expect(resume.resolution_via).toBe('single-active');
    expect(resume.artifact_id).toBe(fallbackId);
  });

  it('does not restore a summarized archive merely because a pin still names it', async () => {
    const agentA = makeAgent({ cwd: repoA.path, env });
    parseOk(
      await agentA.runRaw([
        'capture',
        'summary',
        '--input',
        inputFile(JSON.stringify({ artifact_id: artifactId, outcome: 'shipped' })),
      ])
    );
    await pinArtifactInRepoB();
    const agentB = makeAgent({ cwd: repoB.path, env });

    const resume = parseOk<{
      resolution_via: string;
      artifact: null;
      restored_from_archive?: boolean;
    }>(await agentB.runRaw(['resume', '--json']));
    expect(resume.resolution_via).toBe('no-active-artifacts');
    expect(resume.artifact).toBeNull();
    expect(resume.restored_from_archive).toBeUndefined();
    await expect(
      access(path.join(repoB.path, '.orcaops', 'artifacts', artifactId))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('unknown artifact stays UNKNOWN_ARTIFACT with an archive-aware message', async () => {
    const agentB = makeAgent({ cwd: repoB.path, env });
    const r = await agentB.runRaw([
      'resume',
      '--artifact',
      '01999999-9999-7000-8000-0000000000ff',
      '--json',
    ]);
    expect(r.exitCode).not.toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe('UNKNOWN_ARTIFACT');
    expect(parsed.error.message).toContain('archive');
  });
});
