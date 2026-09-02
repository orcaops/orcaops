import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Repo } from '@orcaops/core';
import { getDefaultConfig } from '@orcaops/storage';
import { createLinkedWorktree, createTempRepo, type TempRepo } from '@orcaops/test-harness';

import {
  buildSeedCoverageReport,
  clearSeedArea,
  declinedSeedAreas,
  loadSeedStateForWrite,
  offeredSeedAreas,
  readSeedPreciousState,
  readSeedState,
  recordSeedAreaOffered,
  recordSeedJob,
  rememberDeclinedSeedArea,
  SEED_JOB_RECORD_LIMIT,
  SEED_LOCK_UNREADABLE_STALE_MS,
  SEED_OFFER_COOLDOWN_MS,
  seedAreaSuppression,
  type SeedJobRecord,
  seedJournalPath,
  seedPreciousStatePath,
  withSeedRunLock,
  withSeedRunLockAtPath,
  writeSeedJournal,
  writeSeedPreciousState,
} from './journal.js';

const config = getDefaultConfig();
const NONCE = 'a'.repeat(32);

async function writeLegacyJournal(
  repoRoot: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const journalPath = seedJournalPath(repoRoot, config);
  await mkdir(path.dirname(journalPath), { recursive: true });
  await writeFile(
    journalPath,
    JSON.stringify({
      schema_version: 1,
      install_nonce: NONCE,
      options_hash: 'legacy-hash',
      pr_context: true,
      pending_importance: true,
      updated_at: '2026-01-01T00:00:00.000Z',
      clusters: { 'run:abc': { artifact_id: 'artifact-1', status: 'complete' } },
      declined_discovery_areas: ['./src/server/'],
      commit_graph_hint_shown: true,
      ...overrides,
    }),
    'utf8'
  );
}

describe('seed state', () => {
  let repo: TempRepo;
  let dataRoot: string;
  let env: NodeJS.ProcessEnv;

  const setup = async (): Promise<Repo> => {
    repo = await createTempRepo();
    dataRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-seed-data-'));
    env = { ORCAOPS_DATA_DIR: dataRoot };
    return new Repo(repo.path);
  };

  afterEach(async () => {
    await repo?.cleanup();
  });

  it('mints the nonce into the precious file and keeps it stable across runs', async () => {
    const gitRepo = await setup();
    const first = await loadSeedStateForWrite(gitRepo, env, repo.path, config);
    expect(first.precious.install_nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(first.journal).toMatchObject({ schema_version: 2, clusters: {}, jobs: {} });
    // The journal only ever mirrors the nonce.
    expect(first.journal.install_nonce).toBe(first.precious.install_nonce);
    await writeSeedPreciousState(first.location, first.precious);

    const second = await loadSeedStateForWrite(gitRepo, env, repo.path, config);
    expect(second.precious.install_nonce).toBe(first.precious.install_nonce);
    expect(
      await readSeedPreciousState({ dataRoot, projectId: first.location.projectId })
    ).toMatchObject({ install_nonce: first.precious.install_nonce });
    expect(seedPreciousStatePath(dataRoot, first.location.projectId)).toBe(
      path.join(dataRoot, 'projects', first.location.projectId, 'seed-state.json')
    );
  });

  it('lifts every precious field out of a pre-1.1 journal and rewrites it as scratch', async () => {
    const gitRepo = await setup();
    await writeLegacyJournal(repo.path);

    const { precious, journal, location } = await loadSeedStateForWrite(
      gitRepo,
      env,
      repo.path,
      config
    );
    expect(precious).toMatchObject({
      schema_version: 1,
      install_nonce: NONCE,
      pr_context: true,
      pending_importance: true,
      commit_graph_hint_shown: true,
    });
    expect(declinedSeedAreas(precious)).toEqual(['src/server']);
    // Scratch keeps the run-derivable half only.
    expect(journal).toMatchObject({
      schema_version: 2,
      install_nonce: NONCE,
      options_hash: 'legacy-hash',
      clusters: { 'run:abc': { artifact_id: 'artifact-1', status: 'complete' } },
      jobs: {},
    });
    expect(journal).not.toHaveProperty('pr_context');
    expect(journal).not.toHaveProperty('declined_discovery_areas');

    await writeSeedPreciousState(location, precious);
    await writeSeedJournal(repo.path, config, journal);
    const onDisk = JSON.parse(await readFile(seedJournalPath(repo.path, config), 'utf8')) as {
      schema_version: number;
    };
    expect(onDisk.schema_version).toBe(2);
  });

  it('reports migrated state on the read path without minting an identity', async () => {
    const gitRepo = await setup();
    await writeLegacyJournal(repo.path);

    const { precious, journal } = await readSeedState(gitRepo, env, repo.path, config);
    expect(precious).toMatchObject({ install_nonce: NONCE, pending_importance: true });
    expect(journal?.schema_version).toBe(2);
    expect(await gitRepo.getLocalConfig('orcaops.projectid')).toBeNull();
  });

  it('lets the precious file win every field a stale journal still carries', async () => {
    const gitRepo = await setup();
    const seeded = await loadSeedStateForWrite(gitRepo, env, repo.path, config);
    seeded.precious.pr_context = false;
    seeded.precious.pending_importance = false;
    seeded.precious.commit_graph_hint_shown = false;
    await writeSeedPreciousState(seeded.location, seeded.precious);
    // A pre-1.1 journal claiming the opposite of every precious field.
    await writeLegacyJournal(repo.path);

    const { precious } = await loadSeedStateForWrite(gitRepo, env, repo.path, config);
    expect(precious).toMatchObject({
      install_nonce: seeded.precious.install_nonce,
      pr_context: false,
      pending_importance: false,
      commit_graph_hint_shown: false,
    });
    expect(declinedSeedAreas(precious)).toEqual([]);
  });

  it('records normalized declined areas once', async () => {
    const gitRepo = await setup();
    const { precious, location } = await loadSeedStateForWrite(gitRepo, env, repo.path, config);
    rememberDeclinedSeedArea(precious, './src/server/');
    rememberDeclinedSeedArea(precious, 'src/server');
    rememberDeclinedSeedArea(precious, '   ');
    await writeSeedPreciousState(location, precious);

    const reloaded = await readSeedPreciousState(location);
    expect(declinedSeedAreas(reloaded)).toEqual(['src/server']);
    expect(reloaded?.discovery_areas['src/server']?.declined_at).toMatch(/^2/u);
  });

  it('records the originally requested path beside a widened decline area', async () => {
    const gitRepo = await setup();
    const { precious, location } = await loadSeedStateForWrite(gitRepo, env, repo.path, config);
    // Suppression stays area-wide; the original request is data for future
    // finer-grained suppression.
    rememberDeclinedSeedArea(precious, 'apps', 'apps/orcaops-cli');
    rememberDeclinedSeedArea(precious, 'apps', './apps/orcaops-watch/');
    rememberDeclinedSeedArea(precious, 'apps', 'apps');
    await writeSeedPreciousState(location, precious);

    const reloaded = await readSeedPreciousState(location);
    expect(declinedSeedAreas(reloaded)).toEqual(['apps']);
    expect(reloaded?.discovery_areas['apps']?.declined_paths).toEqual([
      'apps/orcaops-cli',
      'apps/orcaops-watch',
    ]);
  });

  it('rejects a concurrent run while retaining an explicit long-lived owner lock', async () => {
    const gitRepo = await setup();
    await withSeedRunLock(gitRepo, env, async () => {
      await expect(withSeedRunLock(gitRepo, env, async () => undefined)).rejects.toThrow(
        'Another orcaops seed run is active'
      );
    });
  });

  it('serializes linked worktrees of one project on a single lock', async () => {
    const gitRepo = await setup();
    const worktree = await createLinkedWorktree(repo.path);
    try {
      const worktreeRepo = new Repo(worktree.path);
      await withSeedRunLock(gitRepo, env, async () => {
        await expect(withSeedRunLock(worktreeRepo, env, async () => undefined)).rejects.toThrow(
          'Another orcaops seed run is active'
        );
      });
      // Released: the sibling checkout may now run.
      await expect(withSeedRunLock(worktreeRepo, env, async () => 'ran')).resolves.toBe('ran');
    } finally {
      await worktree.cleanup();
    }
  });
});

describe('seed run lock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-seed-lock-'));
    lockPath = path.join(dir, 'seed-run.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.on('close', resolve));
    return child.pid!;
  }

  it('is born with owner content — never an empty-lock window', async () => {
    await withSeedRunLockAtPath(lockPath, async () => {
      const raw = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
      expect(raw.pid).toBe(process.pid);
    });
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('names the lock path, owner pid, and remedy in the conflict error', async () => {
    await withSeedRunLockAtPath(lockPath, async () => {
      await expect(withSeedRunLockAtPath(lockPath, async () => undefined)).rejects.toThrow(
        new RegExp(`pid ${process.pid}.*${lockPath}.*remove the lock file and retry`, 'su')
      );
    });
  });

  it('takes over a dead-owner lock', async () => {
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: await deadPid(), started_at: new Date().toISOString() })}\n`
    );
    await expect(withSeedRunLockAtPath(lockPath, async () => 'ran')).resolves.toBe('ran');
  });

  it('recovers a stale zero-byte lock via mtime instead of wedging forever', async () => {
    await writeFile(lockPath, '');
    const stale = new Date(Date.now() - SEED_LOCK_UNREADABLE_STALE_MS - 60_000);
    await utimes(lockPath, stale, stale);
    await expect(withSeedRunLockAtPath(lockPath, async () => 'ran')).resolves.toBe('ran');
  });

  it('treats a fresh unparseable lock as potentially live', async () => {
    await writeFile(lockPath, '');
    await expect(withSeedRunLockAtPath(lockPath, async () => undefined)).rejects.toThrow(
      'unknown owner'
    );
  });

  it('release only unlinks a lock the releaser still owns', async () => {
    await withSeedRunLockAtPath(lockPath, async () => {
      // Simulate a mis-judged takeover: the lock on disk now belongs to a
      // different live process (the test runner's parent).
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.ppid, started_at: new Date().toISOString() })}\n`
      );
    });
    const raw = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(raw.pid).toBe(process.ppid);
  });

  // The takeover internals are driven through the dist build (like the
  // multi-process race below) so mutation checks against the shipped
  // bundle exercise these paths too.
  async function distTakeOverDeadLock(): Promise<
    (lockPath: string, judgedDeadRaw: string) => Promise<'acquired' | 'busy' | 'lost'>
  > {
    const distJournal = new URL('../../../dist/commands/seed/journal.js', import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ distJournal)) as {
      takeOverDeadLock: (
        lockPath: string,
        judgedDeadRaw: string
      ) => Promise<'acquired' | 'busy' | 'lost'>;
    };
    return mod.takeOverDeadLock;
  }

  it('takeover refuses to displace a lock that no longer matches the judged-dead owner', async () => {
    const takeOverDeadLockDist = await distTakeOverDeadLock();
    const judgedDead = `${JSON.stringify({ pid: await deadPid(), started_at: new Date().toISOString() })}\n`;
    // A stale dead verdict in hand, but the lock on disk is already a live
    // owner's fresh replacement: the takeover must not touch it.
    const liveRaw = `${JSON.stringify({ pid: process.ppid, started_at: new Date().toISOString() })}\n`;
    await writeFile(lockPath, liveRaw);
    await expect(takeOverDeadLockDist(lockPath, judgedDead)).resolves.toBe('lost');
    expect(await readFile(lockPath, 'utf8')).toBe(liveRaw);
  });

  it('takeover winner exits the critical section already holding the lock', async () => {
    const takeOverDeadLockDist = await distTakeOverDeadLock();
    const judgedDead = `${JSON.stringify({ pid: await deadPid(), started_at: new Date().toISOString() })}\n`;
    await writeFile(lockPath, judgedDead);
    await expect(takeOverDeadLockDist(lockPath, judgedDead)).resolves.toBe('acquired');
    const raw = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(raw.pid).toBe(process.pid);
    // The section file is released after the win.
    await expect(readFile(`${lockPath}.takeover`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('lets exactly one of several racing processes take over a dead-owner lock', async () => {
    // Both prior takeover designs double-acquired under review: the
    // unlink+recreate takeover 4/30 rounds, and the removal-only critical
    // section 3/10 invocations (its winner re-created the lock OUTSIDE the
    // section, so the next section holder unlinked a fresh live lock). This
    // drives the shipped dist in real OS processes and must pass every
    // round now that the takeover unlink is content-conditional and the
    // replacement lock is created inside the held section.
    const distJournal = new URL('../../../dist/commands/seed/journal.js', import.meta.url).href;
    const markerPath = path.join(dir, 'holders.log');
    // Spawn skew would otherwise serialize the contenders and mask the race:
    // each racer announces readiness, then both spin until the other is
    // ready, so the dead-owner takeover attempts land near-simultaneously.
    const childScript = `
      const { appendFile, writeFile, readdir } = await import('node:fs/promises');
      const { basename, dirname } = await import('node:path');
      const { withSeedRunLockAtPath } = await import(process.env.SEED_LOCK_DIST);
      await writeFile(process.env.SEED_LOCK_READY + '.' + process.env.SEED_LOCK_RACER, '');
      const stem = basename(process.env.SEED_LOCK_READY);
      const racers = Number(process.env.SEED_LOCK_RACERS);
      for (;;) {
        const ready = (await readdir(dirname(process.env.SEED_LOCK_READY))).filter((name) =>
          name.startsWith(stem + '.')
        );
        if (ready.length >= racers) break;
      }
      // Jitter spreads the contenders across the judge/act interleavings a
      // perfectly aligned start would never explore.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      try {
        await withSeedRunLockAtPath(process.env.SEED_LOCK_PATH, async () => {
          await appendFile(process.env.SEED_LOCK_MARKER, process.pid + ' acquired\\n');
          await new Promise((resolve) => setTimeout(resolve, 250));
        });
        process.exit(0);
      } catch {
        process.exit(3);
      }
    `;
    const stalePid = await deadPid();
    const RACERS = 4;
    // 30 rounds per invocation: the refuted design failed ~1-in-3
    // invocations at 12 rounds, so a passing invocation at 30 rounds is
    // meaningful evidence — and reintroduced bugs fail near-certainly.
    for (let round = 0; round < 30; round++) {
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: stalePid, started_at: new Date().toISOString() })}\n`
      );
      await rm(markerPath, { force: true });
      const readyStem = path.join(dir, `ready-${round}`);
      const racers = Array.from(
        { length: RACERS },
        (_, n) =>
          new Promise<number>((resolve) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
              stdio: 'ignore',
              env: {
                ...process.env,
                SEED_LOCK_DIST: distJournal,
                SEED_LOCK_PATH: lockPath,
                SEED_LOCK_MARKER: markerPath,
                SEED_LOCK_READY: readyStem,
                SEED_LOCK_RACER: String(n),
                SEED_LOCK_RACERS: String(RACERS),
              },
            });
            child.on('close', (code) => resolve(code ?? -1));
          })
      );
      const codes = await Promise.all(racers);
      const holders = (await readFile(markerPath, 'utf8')).split('\n').filter(Boolean);
      expect(holders, `round ${round}: exactly one racer may hold the lock`).toHaveLength(1);
      expect(codes.filter((code) => code === 0)).toHaveLength(1);
      expect(codes.filter((code) => code === 3)).toHaveLength(RACERS - 1);
    }
  }, 180_000);
});

describe('discovery-area suppression', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString();
  const state = (areas: Record<string, { declined_at?: string; offered_at?: string }>) => ({
    schema_version: 1 as const,
    install_nonce: 'b'.repeat(32),
    pr_context: false,
    pending_importance: false,
    commit_graph_hint_shown: false,
    discovery_areas: areas,
    updated_at: now.toISOString(),
  });

  it('suppresses a declined area permanently and an offer only during its cooldown', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(seedAreaSuppression(state({}), 'src', now)).toBeNull();
    expect(seedAreaSuppression(state({ src: { offered_at: ago(2 * day) } }), 'src', now)).toBe(
      'offer-cooldown'
    );
    expect(
      seedAreaSuppression(state({ src: { offered_at: ago(8 * day) } }), 'src', now)
    ).toBeNull();
    expect(
      seedAreaSuppression(state({ src: { offered_at: ago(SEED_OFFER_COOLDOWN_MS) } }), 'src', now)
    ).toBeNull();
    // A decline outranks any offer timestamp, however stale.
    expect(
      seedAreaSuppression(
        state({ src: { declined_at: ago(400 * day), offered_at: ago(400 * day) } }),
        'src',
        now
      )
    ).toBe('declined');
    // Suppression is looked up by the same normalized spelling declines use.
    expect(seedAreaSuppression(state({ src: { declined_at: ago(day) } }), './src/', now)).toBe(
      'declined'
    );
  });

  it('stamps an offer and clears one remembered area', () => {
    const current = state({ frontend: { declined_at: ago(1000) } });
    recordSeedAreaOffered(current, './src/', now);
    expect(offeredSeedAreas(current, now)).toEqual([
      { area: 'src', offered_at: now.toISOString(), cooldown_active: true },
    ]);
    // Declines are not offers, so they never appear in the offered lane.
    expect(offeredSeedAreas(current, now).map((offer) => offer.area)).not.toContain('frontend');

    expect(clearSeedArea(current, 'src')).toBe(true);
    expect(clearSeedArea(current, 'src')).toBe(false);
    expect(seedAreaSuppression(current, 'src', now)).toBeNull();
    expect(clearSeedArea(current, './frontend/')).toBe(true);
    expect(declinedSeedAreas(current)).toEqual([]);
  });
});

describe('recordSeedJob', () => {
  const record = (startedAt: string): SeedJobRecord => ({
    kind: 'initial',
    started_at: startedAt,
  });

  it('keeps the newest run extras and drops the oldest past the cap', () => {
    const jobs: Record<string, SeedJobRecord> = {};
    for (let index = 0; index < SEED_JOB_RECORD_LIMIT + 5; index++) {
      const day = String(index + 1).padStart(2, '0');
      recordSeedJob(jobs, `job-${index}`, record(`2026-01-${day}T00:00:00.000Z`));
    }
    expect(Object.keys(jobs)).toHaveLength(SEED_JOB_RECORD_LIMIT);
    expect(jobs).not.toHaveProperty('job-0');
    expect(jobs).toHaveProperty(`job-${SEED_JOB_RECORD_LIMIT + 4}`);
  });
});

describe('buildSeedCoverageReport', () => {
  it('reports imported living-line coverage per top-level directory', () => {
    const imported = 'a'.repeat(40);
    const report = buildSeedCoverageReport(
      'b'.repeat(40),
      [
        {
          path: 'src/a.ts',
          lineCount: 4,
          byCommit: new Map([
            [imported, 3],
            ['c'.repeat(40), 1],
          ]),
          complete: true,
        },
        {
          path: 'README.md',
          lineCount: 2,
          byCommit: new Map([[imported, 2]]),
          complete: true,
        },
      ],
      new Set([imported]),
      true
    );
    expect(report.directories).toEqual({
      '.': { covered_lines: 2, total_lines: 2, percent: 100 },
      src: { covered_lines: 3, total_lines: 4, percent: 75 },
    });
  });
});
