import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  queryProjectArtifacts,
  readProjectArtifact,
  readProjectSeedBundle,
} from '@orcaops/storage/history/database';
import { createHistoryRepo, gitClient, type HistoryRepo } from '@orcaops/test-harness';

import { runSeed } from './index.js';
import { makeAgent } from '../../../tests/support/test-agent.js';
import { resolveDatabaseSeedCommandContext } from '../../lib/database-seed-context.js';
import { readDatabaseSeedState } from '../../lib/database-seed-state.js';

describe('database seed command', () => {
  let repo: HistoryRepo | null = null;
  let dataRoot: string | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    await repo?.cleanup();
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  });

  it('rejects invalid or secret-bearing public requests before creating a project identity', async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish secret refusal history',
        files: { 'src/service.ts': 'export const service = true;\n' },
      },
    ]);
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-database-seed-secret-'));
    const agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    const token = 'ghp_0000000000000000000000000000000000000';

    const invalid = await agent.runRaw(['seed', '--yes', '--dry-run', '--json']);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout).error.code).toBe('INVALID_INPUT');
    const refused = await agent.runRaw(['seed', '--yes', '--author', token, '--json']);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.code).toBe('SECRET_IN_PAYLOAD');
    await expect(access(path.join(dataRoot, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an interrupted default selection stable across a UTC date change', async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish dated seed history',
        files: { 'src/service.ts': 'export const service = true;\n' },
      },
    ]);
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-database-seed-date-'));
    const env = { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' };
    const first = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env,
      write: true,
      initialize: true,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-31T23:59:59.000Z'));
    let originalOptionsHash = '';
    try {
      await expect(
        runSeed(
          first,
          { yes: true },
          {
            afterPendingPublication: async () => {
              throw new Error('simulated crash before UTC midnight');
            },
          }
        )
      ).rejects.toThrow(/before UTC midnight/u);
      originalOptionsHash = readDatabaseSeedState(first.database)!.journal!.options_hash;
    } finally {
      first.close();
    }

    vi.setSystemTime(new Date('2026-09-01T00:00:01.000Z'));
    const resumed = await resolveDatabaseSeedCommandContext({ cwd: repo.path, env, write: true });
    try {
      const result = await runSeed(resumed, { yes: true });
      expect(result.mode).toBe('applied');
      expect(readDatabaseSeedState(resumed.database)!.journal!.options_hash).toBe(
        originalOptionsHash
      );
    } finally {
      resumed.close();
    }
  });

  it('applies and reports imported history without file authority or a run lock', async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish the service',
        files: { 'src/service.ts': 'export const service = true;\n' },
      },
      {
        type: 'commit',
        label: 'next',
        subject: 'fix: stabilize the service',
        files: { 'src/health.ts': 'export const healthy = true;\n' },
      },
    ]);
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-database-seed-'));
    const agent = makeAgent({
      cwd: repo.path,
      env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    const interruptedContext = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
      write: true,
      initialize: true,
    });
    try {
      await expect(
        runSeed(
          interruptedContext,
          { yes: true },
          {
            afterPendingPublication: async () => {
              throw new Error('simulated crash after pending state');
            },
          }
        )
      ).rejects.toThrow(/simulated crash/u);
      const pending = readDatabaseSeedState(interruptedContext.database)!;
      expect(pending.revision.generation).toBe(1);
      expect(Object.values(pending.journal!.jobs)[0]?.finished_at).toBeUndefined();
      expect(
        Object.values(pending.journal!.clusters).some((cluster) => cluster.status === 'pending')
      ).toBe(true);
    } finally {
      interruptedContext.close();
    }

    const interrupted = await agent.runRaw(['seed', 'status', '--json']);
    expect(interrupted.exitCode).toBe(0);
    expect(JSON.parse(interrupted.stdout)).toMatchObject({
      state: 'partial',
      imported_artifacts: 0,
      coverage_interrupted: true,
    });

    const applied = await agent.runRaw(['seed', '--yes', '--json']);
    expect(applied.exitCode, `${applied.stderr}\n${applied.stdout}`).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: 'applied',
      totals: { created: expect.any(Number), failed: 0, covered_via_archive: 0 },
    });

    const status = await agent.runRaw(['seed', 'status', '--json']);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      state: 'complete',
      imported_artifacts: expect.any(Number),
      coverage_interrupted: false,
    });
    expect(JSON.parse(status.stdout).imported_artifacts).toBeGreaterThan(0);

    const completedContext = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env: { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' },
      write: false,
    });
    try {
      expect(readDatabaseSeedState(completedContext.database)?.revision.generation).toBe(2);
      const snapshotRefs = queryProjectArtifacts(completedContext.database, {
        origin: 'imported',
      })
        .rows.flatMap((row) => {
          const artifact = readProjectArtifact(completedContext.database, row.artifactId)!;
          return artifact.thread.checkpoints.flatMap((checkpoint) =>
            checkpoint.status === 'closed'
              ? [checkpoint.open_snapshot.snapshot_ref, checkpoint.close_snapshot.snapshot_ref]
              : []
          );
        })
        .filter((ref): ref is string => ref !== null);
      const retainedRefs = (
        await gitClient(repo.path).raw([
          'for-each-ref',
          '--format=%(refname)',
          'refs/orcaops/snap/',
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(snapshotRefs.length).toBeGreaterThan(0);
      expect(new Set(retainedRefs)).toEqual(new Set(snapshotRefs));
      expect(retainedRefs).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^refs\/orcaops\/snap\/[0-9a-f-]{36}\/\d+\/(?:open|close)-[0-9a-f-]{36}$/u
          ),
        ])
      );
    } finally {
      completedContext.close();
    }

    await expect(
      access(path.join(repo.path, '.orcaops', 'cache', 'seed', 'journal.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const projectEntries = await readdir(path.join(dataRoot, 'projects'), { recursive: true });
    expect(projectEntries.some((entry) => entry.endsWith('seed-state.json'))).toBe(false);
    expect(projectEntries.some((entry) => entry.endsWith('seed-run.lock'))).toBe(false);
  });

  it('retains exact preview and accepted enrichment sources in the database', async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: choose durable storage',
        body: 'Use durable storage instead of memory because restarts lose state.',
        files: { 'src/storage.ts': 'export const durable = true;\n' },
      },
    ]);
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-database-seed-enrichment-'));
    const env = { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' };
    const initialized = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env,
      write: true,
      initialize: true,
    });
    initialized.close();
    const agent = makeAgent({ cwd: repo.path, env });
    const preview = await agent.runRaw(['seed', '--json']);
    expect(preview.exitCode, preview.stdout + preview.stderr).toBe(0);
    const directory = JSON.parse(preview.stdout).enrichment.bundle_directory as string;
    const manifestBytes = await readFile(path.join(directory, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      bundles: Array<{ filename: string; artifact_id: string }>;
    };
    expect(manifest.bundles).toHaveLength(1);
    const previewReader = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env,
      write: false,
    });
    try {
      expect(readProjectSeedBundle(previewReader.database, { kind: 'pending' })).toBeNull();
    } finally {
      previewReader.close();
    }
    const bundle = manifest.bundles[0]!;
    const bundleBytes = await readFile(path.join(directory, bundle.filename));
    const template = /```json\n([\s\S]*?)\n```/u.exec(bundleBytes.toString('utf8'))?.[1];
    if (!template) throw new Error('Preview bundle has no authored JSON template');
    const authored = JSON.parse(template) as { label: string; outcome: string };
    const authoredBytes = Buffer.from(`${template}\n`);
    await writeFile(path.join(directory, 'authored.json'), authoredBytes);

    const applied = await agent.runRaw(['seed', '--yes', '--enrichment-dir', directory, '--json']);
    expect(applied.exitCode, applied.stdout + applied.stderr).toBe(0);
    const reader = await resolveDatabaseSeedCommandContext({ cwd: repo.path, env, write: false });
    try {
      const pending = readProjectSeedBundle(reader.database, { kind: 'pending' });
      expect(
        pending?.sources.map(({ key, bytes }) => ({ key, bytes: Buffer.from(bytes) }))
      ).toEqual([
        { key: `bundle:${bundle.filename}`, bytes: bundleBytes },
        { key: 'manifest', bytes: manifestBytes },
      ]);
      const accepted = readProjectSeedBundle(reader.database, {
        kind: 'accepted',
        artifactId: bundle.artifact_id,
      });
      expect(Buffer.from(accepted!.sources.find(({ key }) => key === 'authored')!.bytes)).toEqual(
        authoredBytes
      );
      const artifact = readProjectArtifact(reader.database, bundle.artifact_id)!.thread;
      expect(artifact.plan?.label).toBe(authored.label);
      expect(artifact.summary?.outcome).toBe(authored.outcome);
    } finally {
      reader.close();
    }

    const nextPreview = await agent.runRaw(['seed', '--max-commits', '1', '--json']);
    expect(nextPreview.exitCode, nextPreview.stdout + nextPreview.stderr).toBe(0);
    const nextManifestBytes = await readFile(path.join(directory, 'manifest.json'));
    expect(nextManifestBytes).not.toEqual(manifestBytes);
    const nextApply = await agent.runRaw(['seed', '--yes', '--max-commits', '1', '--json']);
    expect(nextApply.exitCode, nextApply.stdout + nextApply.stderr).toBe(0);
    const nextReader = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env,
      write: false,
    });
    try {
      const pending = readProjectSeedBundle(nextReader.database, { kind: 'pending' });
      expect(pending?.revision.generation).toBe(2);
      expect(Buffer.from(pending!.sources.find(({ key }) => key === 'manifest')!.bytes)).toEqual(
        nextManifestBytes
      );
    } finally {
      nextReader.close();
    }
  });

  it('resumes interrupted database seed state through Doctor repair', async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish recoverable history',
        files: { 'service.ts': 'export const ready = true;\n' },
      },
    ]);
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-doctor-seed-'));
    const env = {
      ORCAOPS_DATA_DIR: dataRoot,
      ORCAOPS_DISABLE_DRAIN: '1',
      ORCAOPS_CLOUD_FEATURES: '0',
    };
    const agent = makeAgent({ cwd: repo.path, env });
    const initialized = await agent.runRaw(['init', '--scope', 'project', '--no-llm', '--json']);
    expect(initialized.exitCode, initialized.stdout + initialized.stderr).toBe(0);
    const ctx = await resolveDatabaseSeedCommandContext({ cwd: repo.path, env, write: true });
    let pendingRevision = '';
    try {
      await expect(
        runSeed(
          ctx,
          { yes: true },
          {
            afterPendingPublication: async () => {
              throw new Error('interrupted seed');
            },
          }
        )
      ).rejects.toThrow('interrupted seed');
      pendingRevision = readDatabaseSeedState(ctx.database)!.revision.revisionId;
    } finally {
      ctx.close();
    }
    const diagnosed = await agent.runRaw(['doctor', '--json']);
    const preview = await agent.runRaw(['doctor', '--fix', '--dry-run', '--json']);
    expect(preview.exitCode, preview.stdout + preview.stderr).toBe(0);
    expect(preview.stdout).toContain('would run `orcaops seed --yes`');
    expect(diagnosed.stdout).toContain('seed');
    const pending = await resolveDatabaseSeedCommandContext({ cwd: repo.path, env, write: false });
    try {
      expect(readDatabaseSeedState(pending.database)!.revision.revisionId).toBe(pendingRevision);
    } finally {
      pending.close();
    }
    const repaired = await agent.runRaw(['doctor', '--fix', '--json']);
    expect(repaired.exitCode, repaired.stdout + repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain('resumed `orcaops seed --yes`');
    const status = await agent.runRaw(['seed', 'status', '--json']);
    expect(status.exitCode, status.stdout + status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      state: 'complete',
      coverage_interrupted: false,
    });
    expect(JSON.parse(status.stdout).imported_artifacts).toBeGreaterThan(0);
  });

  it('converges concurrent first applies on one durable run and artifact set', async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish concurrent seed history',
        files: { 'src/service.ts': 'export const service = true;\n' },
      },
      {
        type: 'commit',
        label: 'next',
        subject: 'fix: retain concurrent seed history',
        files: { 'src/health.ts': 'export const healthy = true;\n' },
      },
    ]);
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-database-seed-race-'));
    const env = { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' };
    const initialized = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env,
      write: true,
      initialize: true,
    });
    initialized.close();
    const first = await resolveDatabaseSeedCommandContext({ cwd: repo.path, env, write: true });
    const second = await resolveDatabaseSeedCommandContext({ cwd: repo.path, env, write: true });
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseWinner!: () => void;
    const loserObservedPending = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let releaseRetry!: () => void;
    const winnerCompleted = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const meetAtPendingPublication = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
    };
    const hooks = {
      beforePendingPublication: meetAtPendingPublication,
      afterPendingPublication: async () => loserObservedPending,
      beforeConcurrentRetry: async () => {
        releaseWinner();
        await winnerCompleted;
      },
    };
    try {
      const firstRun = runSeed(first, { yes: true }, hooks);
      const secondRun = runSeed(second, { yes: true }, hooks);
      const releaseBarriers = () => {
        releaseWinner();
        releaseRetry();
      };
      void firstRun.then(releaseRetry, releaseBarriers);
      void secondRun.then(releaseRetry, releaseBarriers);
      const results = await Promise.all([firstRun, secondRun]);
      expect(results.map((result) => result.mode)).toEqual(['applied', 'applied']);
    } finally {
      releaseWinner();
      releaseRetry();
      first.close();
      second.close();
    }

    const retained = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env,
      write: false,
    });
    try {
      const state = readDatabaseSeedState(retained.database)!;
      expect(Object.values(state.journal!.jobs)).toHaveLength(1);
      expect(Object.values(state.journal!.jobs)[0]?.finished_at).toBeDefined();
      expect(
        Object.values(state.journal!.clusters).every((cluster) => cluster.status === 'complete')
      ).toBe(true);
    } finally {
      retained.close();
    }
  });

  it('adopts a seed job completed during Git selection', async () => {
    repo = await createHistoryRepo([
      {
        type: 'commit',
        label: 'root',
        subject: 'feat: establish selection-race history',
        files: { 'src/service.ts': 'export const service = true;\n' },
      },
      {
        type: 'commit',
        label: 'next',
        subject: 'fix: retain selection-race history',
        files: { 'src/health.ts': 'export const healthy = true;\n' },
      },
    ]);
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-database-seed-selection-race-'));
    const env = { ORCAOPS_DATA_DIR: dataRoot, ORCAOPS_DISABLE_DRAIN: '1' };
    const initialized = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env,
      write: true,
      initialize: true,
    });
    initialized.close();
    const loser = await resolveDatabaseSeedCommandContext({ cwd: repo.path, env, write: true });
    const winner = await resolveDatabaseSeedCommandContext({ cwd: repo.path, env, write: true });
    let releaseInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    let releaseSelection!: () => void;
    const winnerCompleted = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    let loserRun: ReturnType<typeof runSeed> | null = null;
    try {
      loserRun = runSeed(
        loser,
        { yes: true },
        {
          afterInitialStateRead: async () => {
            releaseInitialRead();
            await winnerCompleted;
          },
        }
      );
      void loserRun.catch(releaseInitialRead);
      await initialRead;
      const winnerResult = await runSeed(winner, { yes: true });
      releaseSelection();
      const loserResult = await loserRun;
      expect([winnerResult.mode, loserResult.mode]).toEqual(['applied', 'applied']);
    } finally {
      releaseInitialRead();
      releaseSelection();
      await loserRun?.catch(() => undefined);
      loser.close();
      winner.close();
    }

    const retained = await resolveDatabaseSeedCommandContext({
      cwd: repo.path,
      env,
      write: false,
    });
    try {
      const state = readDatabaseSeedState(retained.database)!;
      expect(Object.values(state.journal!.jobs)).toHaveLength(1);
      expect(Object.values(state.journal!.jobs)[0]?.finished_at).toBeDefined();
      expect(
        Object.values(state.journal!.clusters).every((cluster) => cluster.status === 'complete')
      ).toBe(true);
    } finally {
      retained.close();
    }
  });
});
