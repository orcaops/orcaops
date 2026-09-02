import { access, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  archiveArtifactPaths,
  artifactPathsFor,
  ArtifactStore,
  type Config,
  getDefaultConfig,
  type Pin,
  slugifyBranch,
  writePin,
} from '@orcaops/storage';
import { createTempRepo, gitClient, type TempRepo } from '@orcaops/test-harness';

import { scanGcCandidates } from './scanner.js';
import { Repo } from '../git/repo.js';

async function commitFile(
  repoPath: string,
  file: string,
  content: string,
  msg: string
): Promise<string> {
  await writeFile(path.join(repoPath, file), content, 'utf8');
  const git = gitClient(repoPath);
  await git.add(file);
  await git.commit(msg);
  return (await git.revparse(['HEAD'])).trim();
}

describe('scanGcCandidates', () => {
  let tmpRepo: TempRepo;
  let config: Config;
  let store: ArtifactStore;
  let repo: Repo;
  let xdgState: string;
  let pinRepoId: string;

  beforeEach(async () => {
    tmpRepo = await createTempRepo({ initialBranch: 'main' });
    // Gitignore .orcaops/ so the artifact store's writes don't touch
    // the worktree.
    await writeFile(path.join(tmpRepo.path, '.gitignore'), '.orcaops/\n', 'utf8');
    const git = gitClient(tmpRepo.path);
    await git.add('.gitignore');
    await git.commit('add .gitignore');

    config = getDefaultConfig();
    store = new ArtifactStore({ repoRoot: tmpRepo.path, config });
    repo = new Repo(tmpRepo.path);
    xdgState = await mkdtemp(path.join(tmpdir(), 'orcaops-gc-xdg-'));
    pinRepoId = '019fc100-0000-7000-8000-0000000000aa';
  });

  afterEach(async () => {
    store.close();
    await tmpRepo.cleanup();
  });

  async function plantArtifact(opts: {
    id: string;
    branch?: string;
    headSha: string;
    summarized?: { ts: string };
    importedAt?: string;
  }): Promise<void> {
    const branch = opts.branch ?? 'main';
    await store.writePlan({
      schema_version: 4,
      artifact_id: opts.id,
      branch,
      base_sha: opts.headSha,
      agent: 'claude-code',
      agent_session_id: null,
      task: `task ${opts.id}`,
      label: 'lbl',
      plan_steps: [{ step_id: 'step-1', text: 's', label: 'step-1', acceptance_criteria: [] }],
      touched_scope: [],
      started_at: '2026-04-25T12:00:00.000Z',
      non_goals: [],
      revision_n: 0,
      revised_at: null,
      rationale: null,
      step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
      prior_plan_event_id: null,
      decisions: [],
      criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
      ...(opts.importedAt
        ? {
            origin: {
              kind: 'git-import' as const,
              imported_at: opts.importedAt,
              tool_version: '0.0.5',
              source_range: 'main~1..main',
              authors: ['dev@example.com'],
              enriched_at: null,
            },
          }
        : {}),
    });
    if (opts.summarized) {
      await store.writeSummary({
        schema_version: 1,
        artifact_id: opts.id,
        outcome: 'shipped',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: opts.headSha,
        ts: opts.summarized.ts,
      });
    }
  }

  async function plantPin(pin: Pin): Promise<void> {
    await writePin(pin, { repoId: pinRepoId, env: { XDG_STATE_HOME: xdgState } });
  }

  async function danglingCommit(message: string): Promise<string> {
    const git = gitClient(tmpRepo.path);
    const tree = (await git.revparse(['HEAD^{tree}'])).trim();
    return (await git.raw(['commit-tree', tree, '-m', message])).trim();
  }

  async function archiveArtifact(artifactId: string, projectDir: string): Promise<void> {
    const hot = path.join(tmpRepo.path, config.artifacts.path, artifactId, 'events.ndjson');
    const archived = archiveArtifactPaths(projectDir, artifactId);
    await mkdir(archived.dir, { recursive: true });
    await copyFile(hot, archived.eventsNdjson);
  }

  describe('stale_pins', () => {
    it('flags a pin pointing at a missing artifact', async () => {
      // Test-local env scoping XDG_STATE_HOME to this test's pin dir without
      // mutating process.env (a cross-test hazard under vitest concurrency).
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: xdgState };
      await plantPin({
        schema_version: 1,
        artifact_id: 'no-such-id',
        branch: 'main',
        shell_key: { kind: 'claude_session', value: 'sess1' },
        pinned_at: new Date().toISOString(),
        pinned_via: 'auto-on-capture-plan',
      });

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        env,
      });
      expect(c.stale_pins).toHaveLength(1);
      expect(c.stale_pins[0].artifact_id).toBe('no-such-id');
      expect(c.stale_pins[0].reason).toBe('artifact-missing');
    });

    it('flags a pin pointing at a summarized artifact', async () => {
      const headSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
      await plantArtifact({
        id: '01999999-9999-7000-8000-000000000001',
        headSha,
        summarized: { ts: '2026-04-26T12:00:00.000Z' },
      });
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: xdgState };
      await plantPin({
        schema_version: 1,
        artifact_id: '01999999-9999-7000-8000-000000000001',
        branch: 'main',
        shell_key: { kind: 'claude_session', value: 'sess2' },
        pinned_at: new Date().toISOString(),
        pinned_via: 'auto-on-capture-plan',
      });
      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30, env });
      expect(c.stale_pins).toHaveLength(1);
      expect(c.stale_pins[0].reason).toBe('artifact-summarized');
    });

    it('does not flag a pin pointing at an active artifact', async () => {
      const headSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
      await plantArtifact({ id: '01999999-9999-7000-8000-000000000003', headSha });
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: xdgState };
      await plantPin({
        schema_version: 1,
        artifact_id: '01999999-9999-7000-8000-000000000003',
        branch: 'main',
        shell_key: { kind: 'claude_session', value: 'sess3' },
        pinned_at: new Date().toISOString(),
        pinned_via: 'auto-on-capture-plan',
      });
      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30, env });
      expect(c.stale_pins).toEqual([]);
    });

    it('retains a pin when durable hot bytes exist without a SQLite row', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000004';
      const headSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
      await plantArtifact({ id: artifactId, headSha });
      store.store.deleteArtifact(artifactId);
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: xdgState };
      await plantPin({
        schema_version: 1,
        artifact_id: artifactId,
        branch: 'main',
        shell_key: { kind: 'claude_session', value: 'sess-hot-only' },
        pinned_at: new Date().toISOString(),
        pinned_via: 'auto-on-capture-plan',
      });

      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30, env });
      expect(c.stale_pins).toEqual([]);
      expect(c.storage_uncertainties).toEqual([
        expect.objectContaining({
          operation: 'hot_artifact_presence',
          subject: artifactId,
        }),
      ]);
    });

    it('retains an archive-only in-flight artifact pin without restoring hot bytes', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000005';
      const projectDir = path.join(xdgState, 'archive-project');
      const headSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
      await plantArtifact({ id: artifactId, headSha });
      await archiveArtifact(artifactId, projectDir);
      store.store.deleteArtifact(artifactId);
      await rm(path.join(tmpRepo.path, config.artifacts.path, artifactId), { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: xdgState };
      await plantPin({
        schema_version: 1,
        artifact_id: artifactId,
        branch: 'main',
        shell_key: { kind: 'claude_session', value: 'sess-archive-live' },
        pinned_at: new Date().toISOString(),
        pinned_via: 'auto-on-capture-plan',
      });

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        env,
        archiveEnabled: true,
        archiveProjectDir: projectDir,
      });
      expect(c.stale_pins).toEqual([]);
      expect(c.storage_uncertainties).toBeUndefined();
      await expect(
        access(path.join(tmpRepo.path, config.artifacts.path, artifactId))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('classifies an archive-only summarized artifact pin as stale', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000006';
      const projectDir = path.join(xdgState, 'archive-project');
      const headSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
      await plantArtifact({
        id: artifactId,
        headSha,
        summarized: { ts: '2026-04-26T12:00:00.000Z' },
      });
      await archiveArtifact(artifactId, projectDir);
      store.store.deleteArtifact(artifactId);
      await rm(path.join(tmpRepo.path, config.artifacts.path, artifactId), { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: xdgState };
      await plantPin({
        schema_version: 1,
        artifact_id: artifactId,
        branch: 'main',
        shell_key: { kind: 'claude_session', value: 'sess-archive-complete' },
        pinned_at: new Date().toISOString(),
        pinned_via: 'auto-on-capture-plan',
      });

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        env,
        archiveEnabled: true,
        archiveProjectDir: projectDir,
      });
      expect(c.stale_pins).toEqual([
        expect.objectContaining({ artifact_id: artifactId, reason: 'artifact-summarized' }),
      ]);
    });

    it('reports corrupt archive state as uncertainty instead of deleting its pin', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000007';
      const projectDir = path.join(xdgState, 'archive-project');
      const archived = archiveArtifactPaths(projectDir, artifactId);
      await mkdir(archived.dir, { recursive: true });
      await writeFile(archived.eventsNdjson, '{corrupt\n', 'utf8');
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: xdgState };
      await plantPin({
        schema_version: 1,
        artifact_id: artifactId,
        branch: 'main',
        shell_key: { kind: 'claude_session', value: 'sess-archive-corrupt' },
        pinned_at: new Date().toISOString(),
        pinned_via: 'auto-on-capture-plan',
      });

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        env,
        archiveEnabled: true,
        archiveProjectDir: projectDir,
      });
      expect(c.stale_pins).toEqual([]);
      expect(c.storage_uncertainties).toEqual([
        expect.objectContaining({
          operation: 'archive_artifact_inspection',
          subject: artifactId,
        }),
      ]);
    });
  });

  describe('unreachable_nonterminal_artifacts', () => {
    it('reports branch-tip enumeration uncertainty without manufacturing nonterminal reports', async () => {
      await plantArtifact({
        id: '01999999-9999-7000-8000-000000000009',
        headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      });
      vi.spyOn(repo, 'listLocalBranchTipsState').mockResolvedValueOnce({ status: 'unknown' });

      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });

      expect(c.unreachable_nonterminal_artifacts).toEqual([]);
      expect(c.abandoned_summarized).toEqual([]);
      expect(c.git_uncertainties).toContainEqual({
        operation: 'branch_tip_enumeration',
        subject: 'refs/heads',
      });
    });

    it('reports unknown ancestry without treating it as unreachable', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000008';
      const headSha = await danglingCommit('unknown ancestry input');
      await plantArtifact({ id: artifactId, headSha });
      vi.spyOn(repo, 'checkReachability').mockResolvedValueOnce('unknown');

      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });

      expect(c.unreachable_nonterminal_artifacts).toEqual([]);
      expect(c.git_uncertainties).toContainEqual({
        operation: 'artifact_reachability',
        subject: expect.stringContaining(`${artifactId}:${headSha}`),
      });
    });

    it('reports an unresolved lineage object instead of treating it as unreachable', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000007';
      const missingSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      await plantArtifact({ id: artifactId, headSha: missingSha });

      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });

      expect(c.unreachable_nonterminal_artifacts).toEqual([]);
      expect(c.git_uncertainties).toContainEqual({
        operation: 'artifact_lineage_resolution',
        subject: `${artifactId}:${missingSha}`,
      });
    });

    it('reports operational lineage-resolution failure as uncertainty', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000005';
      const headSha = await danglingCommit('operational lineage probe');
      await plantArtifact({ id: artifactId, headSha });
      const originalResolve = repo.resolveCommitState.bind(repo);
      vi.spyOn(repo, 'resolveCommitState').mockImplementation(async (ref) =>
        ref === headSha ? { status: 'unknown' } : originalResolve(ref)
      );

      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });

      expect(c.unreachable_nonterminal_artifacts).toEqual([]);
      expect(c.git_uncertainties).toContainEqual({
        operation: 'artifact_lineage_resolution',
        subject: `${artifactId}:${headSha}`,
      });
    });

    it('can prove a resolved lineage unreachable when there are zero local branch tips', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000006';
      const headSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
      await plantArtifact({ id: artifactId, headSha });
      const git = gitClient(tmpRepo.path);
      await git.raw(['checkout', '--detach', headSha]);
      await git.raw(['branch', '-D', 'main']);

      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });

      expect(c.git_uncertainties).toEqual([]);
      expect(c.unreachable_nonterminal_artifacts.map((a) => a.artifact_id)).toContain(artifactId);
    });

    it('reports a planned artifact whose latest lineage SHA is unreachable', async () => {
      const unreachableSha = await danglingCommit('unreachable planned artifact');
      await plantArtifact({
        id: '01999999-9999-7000-8000-000000000010',
        headSha: unreachableSha,
      });
      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });
      expect(c.unreachable_nonterminal_artifacts).toContainEqual(
        expect.objectContaining({
          artifact_id: '01999999-9999-7000-8000-000000000010',
          state: 'planned',
        })
      );
    });

    it('reports a blocked artifact whose latest lineage SHA is unreachable', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000013';
      const unreachableSha = await danglingCommit('unreachable blocked artifact');
      await plantArtifact({ id: artifactId, headSha: unreachableSha });
      await store.writeEvaluatorRunPayload(
        artifactId,
        {
          schema: 'orcaops.evaluator_run/v1',
          run_id: 'run-blocked-artifact',
          artifact_id: artifactId,
          evaluator_ref: 'core/safety',
          package_id: 'core',
          evaluator_id: 'safety',
          phase: 'post-plan',
          severity: 'block',
          run_status: 'completed',
          verdict: 'violation',
          body: 'VIOLATION',
          ts: '2026-04-25T13:00:00.000Z',
        },
        { idempotencyKey: 'block-unreachable-artifact' }
      );

      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });

      expect(c.unreachable_nonterminal_artifacts).toContainEqual(
        expect.objectContaining({ artifact_id: artifactId, state: 'blocked' })
      );
      expect(c.abandoned_summarized).toEqual([]);
    });

    it('does not report a planned artifact whose lineage SHA is reachable from HEAD', async () => {
      const headSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
      await plantArtifact({ id: '01999999-9999-7000-8000-000000000011', headSha });
      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });
      expect(c.unreachable_nonterminal_artifacts).toEqual([]);
    });

    it('does not flag a summarized artifact (those go to abandoned_summarized)', async () => {
      const unreachableSha = await danglingCommit('unreachable summarized artifact');
      await plantArtifact({
        id: '01999999-9999-7000-8000-000000000012',
        headSha: unreachableSha,
        summarized: { ts: '2026-04-26T12:00:00.000Z' },
      });
      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });
      expect(c.unreachable_nonterminal_artifacts.map((a) => a.artifact_id)).not.toContain(
        '01999999-9999-7000-8000-000000000012'
      );
    });
  });

  describe('abandoned_summarized', () => {
    it('refuses a terminal candidate whose durable lifecycle projection was corrupted', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000018';
      const unreachableSha = await danglingCommit('corrupt durable terminal state');
      await plantArtifact({
        id: artifactId,
        headSha: unreachableSha,
        summarized: { ts: '2026-02-25T12:00:00.000Z' },
      });
      const artifact = await store.readArtifact(artifactId);
      if (artifact === null) throw new Error('expected planted artifact');
      const artifactPath = artifactPathsFor(tmpRepo.path, config, artifactId).artifactJson;
      await writeFile(
        artifactPath,
        JSON.stringify({ ...artifact, state: 'active' }) + '\n',
        'utf8'
      );

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: () => Date.parse('2026-04-26T12:00:00.000Z'),
      });

      expect(c.abandoned_summarized).toEqual([]);
      expect(c.storage_uncertainties).toContainEqual(
        expect.objectContaining({
          operation: 'artifact_state_inspection',
          subject: artifactId,
        })
      );
    });

    it('treats a SQLite terminal state that contradicts durable state as uncertainty', async () => {
      const artifactId = '01999999-9999-7000-8000-000000000019';
      const unreachableSha = await danglingCommit('contradictory terminal state');
      await plantArtifact({ id: artifactId, headSha: unreachableSha });
      store.store.db
        .prepare(`UPDATE artifacts SET status = 'complete', completed_at = ? WHERE id = ?`)
        .run('2026-02-25T12:00:00.000Z', artifactId);

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: () => Date.parse('2026-04-26T12:00:00.000Z'),
      });

      expect(c.abandoned_summarized).toEqual([]);
      expect(c.unreachable_nonterminal_artifacts).toEqual([]);
      expect(c.storage_uncertainties).toContainEqual(
        expect.objectContaining({
          operation: 'artifact_state_inspection',
          subject: artifactId,
          reason: expect.stringContaining('contradicts SQLite status'),
        })
      );
    });

    it('flags a summarized artifact whose lineage is unreachable AND outside retention window', async () => {
      const unreachableSha = await danglingCommit('old unreachable summary');
      await plantArtifact({
        id: '01999999-9999-7000-8000-000000000020',
        headSha: unreachableSha,
        // Summarized 60 days ago.
        summarized: { ts: '2026-02-25T12:00:00.000Z' },
      });
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        // "Now" = 2026-04-26 (60 days after summarized_at).
        now: () => Date.parse('2026-04-26T12:00:00.000Z'),
      });
      expect(c.abandoned_summarized.map((a) => a.artifact_id)).toContain(
        '01999999-9999-7000-8000-000000000020'
      );
    });

    it('does NOT flag a summarized artifact still inside the retention window', async () => {
      const unreachableSha = await danglingCommit('recent unreachable summary');
      await plantArtifact({
        id: '01999999-9999-7000-8000-000000000021',
        headSha: unreachableSha,
        summarized: { ts: '2026-04-25T12:00:00.000Z' },
      });
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: () => Date.parse('2026-04-26T12:00:00.000Z'), // 1 day later
      });
      expect(c.abandoned_summarized).toEqual([]);
    });

    it('uses imported_at as the retention floor for backdated summaries', async () => {
      const unreachableSha = await danglingCommit('recently imported old summary');
      await plantArtifact({
        id: '01999999-9999-7000-8000-00000000002a',
        headSha: unreachableSha,
        summarized: { ts: '2020-01-01T00:00:00.000Z' },
        importedAt: '2026-04-25T12:00:00.000Z',
      });
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: () => Date.parse('2026-04-26T12:00:00.000Z'),
      });
      expect(c.abandoned_summarized).toEqual([]);
    });

    it('does NOT flag a summarized artifact whose lineage is still reachable', async () => {
      const headSha = (await gitClient(tmpRepo.path).revparse(['HEAD'])).trim();
      await plantArtifact({
        id: '01999999-9999-7000-8000-000000000022',
        headSha,
        summarized: { ts: '2026-02-25T12:00:00.000Z' }, // 60 days ago
      });
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: () => Date.parse('2026-04-26T12:00:00.000Z'),
      });
      expect(c.abandoned_summarized).toEqual([]);
    });

    it('flags multiple abandoned artifacts in one scan', async () => {
      const firstUnreachableSha = await danglingCommit('first unreachable summary');
      const secondUnreachableSha = await danglingCommit('second unreachable summary');
      await plantArtifact({
        id: '01999999-9999-7000-8000-000000000030',
        headSha: firstUnreachableSha,
        summarized: { ts: '2026-02-25T12:00:00.000Z' },
      });
      await plantArtifact({
        id: '01999999-9999-7000-8000-000000000031',
        headSha: secondUnreachableSha,
        summarized: { ts: '2026-02-26T12:00:00.000Z' },
      });
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: () => Date.parse('2026-04-26T12:00:00.000Z'),
      });
      const ids = c.abandoned_summarized.map((a) => a.artifact_id).sort();
      expect(ids).toEqual([
        '01999999-9999-7000-8000-000000000030',
        '01999999-9999-7000-8000-000000000031',
      ]);
    });
  });

  describe('stale_review_dirs', () => {
    // Push "now" 100 days ahead so the retention cutoff lands well past a
    // freshly-created review dir's real mtime — makes stale dirs collectible
    // without backdating files (retention math mirrors abandoned_summarized).
    const NOW_AHEAD = (): number => Date.now() + 100 * 24 * 60 * 60 * 1000;

    async function writeReviewDir(branch: string): Promise<string> {
      const dir = path.join(tmpRepo.path, '.orcaops', 'reviews', slugifyBranch(branch));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'floor.json'), '{}\n', 'utf8');
      await writeFile(path.join(dir, 'diff.patch'), '', 'utf8');
      return dir;
    }

    async function mergeFeatureInto(defaultBranch: string, feature: string): Promise<void> {
      const git = gitClient(tmpRepo.path);
      await git.checkoutLocalBranch(feature);
      await commitFile(tmpRepo.path, `${feature}.txt`, 'merged\n', `${feature} work`);
      await git.checkout(defaultBranch);
      // Advance the default branch past the feature tip: equality is
      // deliberately not considered a merged/stale review directory.
      await git.merge(['--no-ff', feature]);
    }

    it('reports an operational branch-presence failure instead of calling it deleted', async () => {
      await writeReviewDir('uncertain-branch');
      vi.spyOn(repo, 'branchPresence').mockResolvedValueOnce('unknown');

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });

      expect(c.stale_review_dirs).toEqual([]);
      expect(c.git_uncertainties).toContainEqual({
        operation: 'review_branch_presence',
        subject: 'uncertain-branch',
      });
    });

    it('reports current-branch uncertainty', async () => {
      await writeReviewDir('gone-while-head-is-unknown');
      vi.spyOn(repo, 'getCurrentBranch').mockRejectedValueOnce(new Error('git unavailable'));

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });

      expect(c.git_uncertainties).toContainEqual({ operation: 'current_branch', subject: 'HEAD' });
    });

    it('reports default-branch resolution uncertainty', async () => {
      await writeReviewDir('gone-with-unknown-default');
      const originalResolve = repo.resolveCommitState.bind(repo);
      vi.spyOn(repo, 'resolveCommitState').mockImplementation(async (ref) =>
        ref === 'refs/remotes/origin/HEAD' ? { status: 'unknown' } : originalResolve(ref)
      );

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });

      expect(c.git_uncertainties).toContainEqual({
        operation: 'default_branch_resolution',
        subject: 'refs/remotes/origin/HEAD|refs/heads/main|refs/heads/master',
      });
    });

    it('reports review-branch tip uncertainty', async () => {
      const git = gitClient(tmpRepo.path);
      await git.raw(['branch', 'review-tip-unknown']);
      await writeReviewDir('review-tip-unknown');
      const originalResolve = repo.resolveCommitState.bind(repo);
      vi.spyOn(repo, 'resolveCommitState').mockImplementation(async (ref) =>
        ref === 'refs/heads/review-tip-unknown' ? { status: 'unknown' } : originalResolve(ref)
      );

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });

      expect(c.git_uncertainties).toContainEqual({
        operation: 'review_branch_tip',
        subject: 'review-tip-unknown',
      });
    });

    it('reports review-branch reachability uncertainty', async () => {
      const git = gitClient(tmpRepo.path);
      await git.checkoutLocalBranch('review-reachability-unknown');
      await commitFile(tmpRepo.path, 'uncertain.txt', 'uncertain\n', 'uncertain review work');
      await git.checkout('main');
      await writeReviewDir('review-reachability-unknown');
      vi.spyOn(repo, 'checkReachability').mockResolvedValueOnce('unknown');

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });

      expect(c.git_uncertainties).toContainEqual({
        operation: 'review_branch_reachability',
        subject: 'review-reachability-unknown',
      });
    });

    it('flags a review dir whose branch was deleted locally', async () => {
      await writeReviewDir('gone-branch');
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      const found = c.stale_review_dirs.find((d) => d.branch === 'gone-branch');
      expect(found).toBeDefined();
      expect(found?.reason).toBe('branch_deleted');
      expect(found?.slug).toBe(slugifyBranch('gone-branch'));
    });

    it('reports an unreadable review entry instead of deleting the directory', async () => {
      const branch = 'review-with-dangling-entry';
      const dir = await writeReviewDir(branch);
      await symlink(path.join(dir, 'missing-target'), path.join(dir, 'dangling'));

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });

      expect(c.stale_review_dirs.map((candidate) => candidate.branch)).not.toContain(branch);
      expect(c.storage_uncertainties).toContainEqual(
        expect.objectContaining({
          operation: 'review_state_inspection',
          subject: slugifyBranch(branch),
        })
      );
    });

    it('uses a sole local main to flag a merged review dir', async () => {
      await mergeFeatureInto('main', 'feature-merged-main');
      expect(await repo.resolveCommit('origin/HEAD')).toBeNull();
      expect(await repo.resolveCommit('main')).not.toBeNull();
      expect(await repo.resolveCommit('master')).toBeNull();
      await writeReviewDir('feature-merged-main');
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      const found = c.stale_review_dirs.find((d) => d.branch === 'feature-merged-main');
      expect(found?.reason).toBe('branch_merged');
    });

    it('uses a sole local master to flag a merged review dir', async () => {
      const git = gitClient(tmpRepo.path);
      await git.raw(['branch', '-m', 'master']);
      await mergeFeatureInto('master', 'feature-merged-master');
      expect(await repo.resolveCommit('origin/HEAD')).toBeNull();
      expect(await repo.resolveCommit('main')).toBeNull();
      expect(await repo.resolveCommit('master')).not.toBeNull();
      await writeReviewDir('feature-merged-master');
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      const found = c.stale_review_dirs.find((d) => d.branch === 'feature-merged-master');
      expect(found?.reason).toBe('branch_merged');
    });

    it('uses origin/HEAD despite simultaneous local main and master branches', async () => {
      const git = gitClient(tmpRepo.path);
      await git.raw(['branch', 'master']);
      await mergeFeatureInto('main', 'feature-merged-remote');
      const mainTip = (await git.revparse(['main'])).trim();
      await git.raw(['update-ref', 'refs/remotes/origin/main', mainTip]);
      await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
      expect(await repo.resolveCommit('origin/HEAD')).toBe(mainTip);
      await writeReviewDir('feature-merged-remote');
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      const found = c.stale_review_dirs.find((d) => d.branch === 'feature-merged-remote');
      expect(found?.reason).toBe('branch_merged');
    });

    it('keeps a merged review dir when local main and master are ambiguous', async () => {
      const git = gitClient(tmpRepo.path);
      await git.raw(['branch', 'master']);
      await mergeFeatureInto('main', 'feature-merged-ambiguous');
      expect(await repo.resolveCommit('origin/HEAD')).toBeNull();
      expect(await repo.resolveCommit('main')).not.toBeNull();
      expect(await repo.resolveCommit('master')).not.toBeNull();
      await writeReviewDir('feature-merged-ambiguous');
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      expect(c.stale_review_dirs.map((d) => d.branch)).not.toContain('feature-merged-ambiguous');
    });

    it('keeps a merged review dir when no default-branch candidate resolves', async () => {
      const git = gitClient(tmpRepo.path);
      await git.raw(['branch', '-m', 'trunk']);
      await mergeFeatureInto('trunk', 'feature-merged-unknown');
      expect(await repo.resolveCommit('origin/HEAD')).toBeNull();
      expect(await repo.resolveCommit('main')).toBeNull();
      expect(await repo.resolveCommit('master')).toBeNull();
      await writeReviewDir('feature-merged-unknown');
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      expect(c.stale_review_dirs.map((d) => d.branch)).not.toContain('feature-merged-unknown');
    });

    it('does not let a tag named main shadow the missing local main branch', async () => {
      const git = gitClient(tmpRepo.path);
      await git.raw(['tag', 'main', 'HEAD']);
      await git.raw(['branch', '-m', 'trunk']);
      await mergeFeatureInto('trunk', 'feature-merged-tag-shadow');
      await writeReviewDir('feature-merged-tag-shadow');

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });

      expect(c.stale_review_dirs.map((d) => d.branch)).not.toContain('feature-merged-tag-shadow');
    });

    it('does not let a tag make a deleted review branch appear present', async () => {
      const git = gitClient(tmpRepo.path);
      await git.raw(['tag', 'tag-only-review', 'HEAD']);
      await writeReviewDir('tag-only-review');

      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });

      expect(c.stale_review_dirs).toContainEqual(
        expect.objectContaining({ branch: 'tag-only-review', reason: 'branch_deleted' })
      );
    });

    it('never flags the default branch dir when off it (tip equals the default tip)', async () => {
      const git = gitClient(tmpRepo.path);
      // Stand on a feature branch; main's review dir must not read as "merged"
      // just because main is trivially its own ancestor.
      await git.checkoutLocalBranch('feature-standing');
      await commitFile(tmpRepo.path, 'standing.txt', 'z', 'off-default work');
      await writeReviewDir('main');
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      expect(c.stale_review_dirs.map((d) => d.branch)).not.toContain('main');
    });

    it('never flags the current branch dir, even though it is its own ancestor', async () => {
      // main is both current AND the resolved default branch here.
      await writeReviewDir('main');
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      expect(c.stale_review_dirs.map((d) => d.branch)).not.toContain('main');
    });

    it('does not flag an unmerged, still-existing feature branch dir', async () => {
      const git = gitClient(tmpRepo.path);
      await git.checkoutLocalBranch('feature-live');
      await commitFile(tmpRepo.path, 'live.txt', 'y', 'diverging work');
      await git.checkout('main'); // feature-live tip is NOT reachable from main
      await writeReviewDir('feature-live');
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      expect(c.stale_review_dirs.map((d) => d.branch)).not.toContain('feature-live');
    });

    it('does NOT flag a stale dir modified within the retention window', async () => {
      await writeReviewDir('gone-branch');
      // Real "now": a just-written dir sits inside the 30-day window.
      const c = await scanGcCandidates({ store, repo, pinRepoId, retentionDays: 30 });
      expect(c.stale_review_dirs).toEqual([]);
    });

    it('returns [] when the reviews dir does not exist', async () => {
      const c = await scanGcCandidates({
        store,
        repo,
        pinRepoId,
        retentionDays: 30,
        now: NOW_AHEAD,
      });
      expect(c.stale_review_dirs).toEqual([]);
    });

    it('reports a symlinked reviews root as storage uncertainty', async () => {
      const reviewsRoot = path.join(tmpRepo.path, '.orcaops', 'reviews');
      const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-external-reviews-'));
      try {
        await rm(reviewsRoot, { recursive: true, force: true });
        await mkdir(path.join(outside, slugifyBranch('gone-branch')), { recursive: true });
        await symlink(outside, reviewsRoot);

        const c = await scanGcCandidates({
          store,
          repo,
          pinRepoId,
          retentionDays: 30,
          now: NOW_AHEAD,
        });

        expect(c.stale_review_dirs).toEqual([]);
        expect(c.storage_uncertainties).toContainEqual(
          expect.objectContaining({
            operation: 'review_state_inspection',
            subject: reviewsRoot,
            reason: expect.stringMatching(/symbolic link/),
          })
        );
      } finally {
        await rm(reviewsRoot, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('reports a symlinked review entry as storage uncertainty', async () => {
      const reviewsRoot = path.join(tmpRepo.path, '.orcaops', 'reviews');
      const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-external-review-'));
      const slug = slugifyBranch('gone-branch');
      try {
        await mkdir(reviewsRoot, { recursive: true });
        await symlink(outside, path.join(reviewsRoot, slug));

        const c = await scanGcCandidates({
          store,
          repo,
          pinRepoId,
          retentionDays: 30,
          now: NOW_AHEAD,
        });

        expect(c.stale_review_dirs).toEqual([]);
        expect(c.storage_uncertainties).toContainEqual({
          operation: 'review_state_inspection',
          subject: slug,
          reason: 'review state entry is a symbolic link',
        });
      } finally {
        await rm(path.join(reviewsRoot, slug), { force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
