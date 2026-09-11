import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@orcaops/storage/history/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/storage/history/database')>();
  return {
    ...actual,
    queryProjectArtifacts: vi.fn(actual.queryProjectArtifacts),
    readProjectArtifactDetails: vi.fn(actual.readProjectArtifactDetails),
    readProjectUsageAccounting: vi.fn(actual.readProjectUsageAccounting),
    readProjectDisplayName: vi.fn(actual.readProjectDisplayName),
  };
});
vi.mock('@orcaops/project-scope/history/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/project-scope/history/database')>();
  return { ...actual, resolveDatabaseHistoryScope: vi.fn(actual.resolveDatabaseHistoryScope) };
});

import * as projectScope from '@orcaops/project-scope/history/database';
import * as database from '@orcaops/storage/history/database';

import { FsWatch } from './fs-watch.js';
import { HistoryWatchEngine } from './history-engine.js';
import {
  type HistoryDatabaseFixture,
  historyDatabaseFixture,
} from '../tests/support/history-database-fixture.js';

const fixtures: HistoryDatabaseFixture[] = [];
const engines: HistoryWatchEngine[] = [];
const exec = promisify(execFile);
const now = Date.parse('2026-09-05T00:02:00.000Z');
const resolveScope = vi
  .mocked(projectScope.resolveDatabaseHistoryScope)
  .getMockImplementation() as typeof projectScope.resolveDatabaseHistoryScope;
const readUsage = vi
  .mocked(database.readProjectUsageAccounting)
  .getMockImplementation() as typeof database.readProjectUsageAccounting;
const reads = {
  selections: () => vi.mocked(database.queryProjectArtifacts).mock.calls.length,
  hydrations: () =>
    vi
      .mocked(database.readProjectArtifactDetails)
      .mock.calls.reduce((sum, [, requests]) => sum + requests.length, 0),
  usage: () => vi.mocked(database.readProjectUsageAccounting).mock.calls.length,
  resolutions: () => vi.mocked(projectScope.resolveDatabaseHistoryScope).mock.calls.length,
  clear() {
    vi.mocked(database.queryProjectArtifacts).mockClear();
    vi.mocked(database.readProjectArtifactDetails).mockClear();
    vi.mocked(database.readProjectUsageAccounting).mockClear();
    vi.mocked(projectScope.resolveDatabaseHistoryScope).mockClear();
  },
};
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
  vi.mocked(projectScope.resolveDatabaseHistoryScope).mockImplementation(resolveScope);
  reads.clear();
});
async function fixture() {
  const f = await historyDatabaseFixture();
  fixtures.push(f);
  const engine = new HistoryWatchEngine({
    scope: { root: f.root, cwd: f.cwd },
    activityReader: {
      async readLastActivity() {
        return new Map();
      },
    },
  });
  engines.push(engine);
  return { ...f, engine };
}
function project(engine: HistoryWatchEngine, projectId: string) {
  return engine.snapshot!.projects.find((project) => project.projectId === projectId)!;
}

describe('history Watch engine', { timeout: 60_000 }, () => {
  it('names repositories from retained history when launched outside a checkout', async () => {
    const alpha = await historyDatabaseFixture({ repositoryName: 'alpha' });
    const beta = await historyDatabaseFixture({ repositoryName: 'beta', dataRoot: alpha.root });
    fixtures.push(beta, alpha);
    const alphaId = await alpha.add();
    const betaId = await beta.add();
    await rm(beta.cwd, { recursive: true });
    const engine = new HistoryWatchEngine({ scope: { root: alpha.root, cwd: alpha.temporary } });
    engines.push(engine);
    await engine.start(now);

    for (const [f, artifactId, name] of [
      [alpha, alphaId, 'alpha'],
      [beta, betaId, 'beta'],
    ] as const) {
      expect(project(engine, f.authority.projectId)).toMatchObject({
        displayName: name,
        repository: {
          commonDirectory: path.join(f.cwd, '.git'),
          instanceId: f.authority.repositoryInstanceId,
        },
        threads: [{ artifactId, isCurrentCheckout: false }],
      });
    }
    expect([...new Set(engine.snapshot!.ticker.map((event) => event.project))].sort()).toEqual([
      'alpha',
      'beta',
    ]);

    reads.clear();
    await engine.tick(now + 1000);
    expect(project(engine, alpha.authority.projectId).displayName).toBe('alpha');
    expect(project(engine, beta.authority.projectId).displayName).toBe('beta');
    expect(reads.selections()).toBe(0);
    expect(reads.hydrations()).toBe(0);

    const file = database.projectDatabasePath(beta.authority);
    await rename(file, `${file}.displaced`);
    try {
      await engine.tick(now + 2000);
      expect(project(engine, beta.authority.projectId)).toMatchObject({
        state: 'deferred',
        displayName: 'beta',
        repository: { instanceId: beta.authority.repositoryInstanceId },
      });
    } finally {
      await rename(`${file}.displaced`, file);
    }
  });

  it('keeps the main repository name when launched in a linked worktree', async () => {
    const f = await fixture();
    const id = await f.add({ branch: 'topic' });
    const worktree = path.join(f.temporary, 'feature-worktree');
    await exec('git', ['-C', f.cwd, 'worktree', 'add', '-b', 'topic', worktree]);
    const engine = new HistoryWatchEngine({ scope: { root: f.root, cwd: worktree } });
    engines.push(engine);
    await engine.start(now);

    expect(project(engine, f.authority.projectId)).toMatchObject({
      displayName: 'checkout',
      repository: {
        commonDirectory: path.join(f.cwd, '.git'),
        instanceId: f.authority.repositoryInstanceId,
      },
      threads: [{ artifactId: id, isCurrentCheckout: true }],
    });
  });

  it('uses the project identifier when no repository locator is retained', async () => {
    const f = await fixture();
    const sibling = await f.addProject();
    await f.add({ writer: sibling.writer });
    await f.engine.start(now);
    const shown = project(f.engine, sibling.authority.projectId);
    expect(shown.displayName).toBe(sibling.authority.projectId);
    expect(shown.repository).toBeUndefined();
  });

  it('hydrates every candidate once, then reuses an unchanged display without reads', async () => {
    const f = await fixture();
    const first = await f.add();
    const second = await f.add({ branch: 'topic' });
    await f.engine.start(now);
    const snapshot = f.engine.snapshot!;
    expect(snapshot).toMatchObject({
      state: 'current',
      completeness: { complete: true, issues: [] },
      dataRoot: f.root,
      totals: {
        activeThreads: 2,
        openCheckpoints: 0,
        sessionTokens: 0,
        usageStatus: 'unavailable',
      },
    });
    const shown = project(f.engine, f.authority.projectId);
    expect(shown).toMatchObject({
      state: 'current',
      authorityKey: f.authority.storeInstanceId,
      displayName: 'checkout',
      repository: {
        commonDirectory: path.join(f.cwd, '.git'),
        instanceId: f.authority.repositoryInstanceId,
      },
    });
    expect(shown.writeSequence).toBeGreaterThan(0);
    expect(shown.threads.map((thread) => thread.artifactId).sort()).toEqual([first, second].sort());
    expect(shown.threads.find((thread) => thread.artifactId === first)).toMatchObject({
      artifactStatus: 'active',
      branch: 'main',
      isCurrentCheckout: true,
      openComments: 0,
      steps: { completed: 0, total: 1 },
      planSteps: [{ idx: 1, done: false, current: false }],
      state: 'starting',
    });
    expect(shown.threads.find((thread) => thread.artifactId === second)!.isCurrentCheckout).toBe(
      false
    );
    expect(reads.selections()).toBe(1);
    expect(reads.hydrations()).toBe(2);
    expect(f.engine.timings).toMatchObject({ hydratedArtifacts: 2, refreshedProjects: 1 });
    reads.clear();
    await f.engine.tick(now + 1000);
    expect(reads.selections()).toBe(0);
    expect(reads.hydrations()).toBe(0);
    expect(reads.usage()).toBe(0);
    expect(f.engine.timings).toMatchObject({
      reusedProjects: 1,
      refreshedProjects: 0,
      hydratedArtifacts: 0,
      selectedRows: 0,
    });
    expect(f.engine.snapshot!.generatedAtMs).toBe(now + 1000);
    expect(project(f.engine, f.authority.projectId).writeSequence).toBe(shown.writeSequence);
  });

  it('hydrates only the changed artifact after a checkpoint and retains the sibling detail', async () => {
    const f = await fixture();
    const changed = await f.add();
    const sibling = await f.add();
    await f.engine.start(now);
    const before = project(f.engine, f.authority.projectId);
    const siblingVersion = before.threads.find((thread) => thread.artifactId === sibling)!.version;
    await f.checkpoint(changed, { summary: 'Narrative '.repeat(100), open: false });
    reads.clear();
    await f.engine.tick(now + 2000);
    expect(reads.selections()).toBe(1);
    expect(reads.hydrations()).toBe(1);
    expect(
      vi.mocked(database.readProjectArtifactDetails).mock.calls[0]![1].map((r) => r.artifactId)
    ).toEqual([changed]);
    const after = project(f.engine, f.authority.projectId);
    expect(after.writeSequence).toBeGreaterThan(before.writeSequence!);
    const thread = after.threads.find((thread) => thread.artifactId === changed)!;
    expect(thread.currentLine).toHaveLength(320);
    expect(thread.checkpoints).toEqual([
      expect.objectContaining({
        n: 1,
        status: 'closed',
        summary: 'Narrative '.repeat(100),
        uncertainties: ['Independent reproduction remains'],
        filesChanged: 1,
        steps: [{ idx: 1, label: 'Inspect work 1' }],
      }),
    ]);
    expect(thread).toMatchObject({
      steps: { completed: 1, total: 1 },
      lastClosed: { uncertaintyCount: 1 },
      state: 'ready',
      planSteps: [{ idx: 1, done: true, current: false }],
    });
    expect(after.threads.find((thread) => thread.artifactId === sibling)!.version).toBe(
      siblingVersion
    );
  });

  it('shows a newly captured artifact and drops a summarized one that left the window', async () => {
    const f = await fixture();
    const old = await f.add({ startedAt: '2026-09-01T00:00:00.000Z' });
    await f.engine.start(now);
    expect(project(f.engine, f.authority.projectId).threads).toHaveLength(1);
    const added = await f.add();
    await f.engine.tick(now + 1000);
    expect(
      project(f.engine, f.authority.projectId)
        .threads.map((thread) => thread.artifactId)
        .sort()
    ).toEqual([old, added].sort());
    await f.summarize(old, '2026-09-01T00:01:00.000Z');
    await f.engine.tick(now + 2000);
    expect(project(f.engine, f.authority.projectId).threads.map((t) => t.artifactId)).toEqual([
      added,
    ]);
    expect(f.engine.timings!.hydratedArtifacts).toBe(0);
  });

  it('drops a summarized artifact that leaves the window while the database is untouched', async () => {
    const f = await fixture();
    const leaving = await f.add();
    const active = await f.add();
    await f.summarize(leaving);
    await f.engine.start(now);
    expect(project(f.engine, f.authority.projectId).threads).toHaveLength(2);
    expect(f.engine.snapshot!.totals.activeThreads).toBe(1);
    reads.clear();
    // A day and a minute after the summary, with no write in between.
    await f.engine.tick(Date.parse('2026-09-06T00:02:00.000Z'));
    expect(
      project(f.engine, f.authority.projectId).threads.map((thread) => thread.artifactId)
    ).toEqual([active]);
    expect(reads.selections()).toBe(0);
    expect(reads.hydrations()).toBe(0);
    expect(f.engine.timings).toMatchObject({
      reusedProjects: 1,
      refreshedProjects: 0,
      selectedRows: 0,
      hydratedArtifacts: 0,
    });
  });

  it('counts open comments from registered reviews on the thread branch and usage sessions', async () => {
    const f = await fixture();
    const id = await f.add({ branch: 'topic' });
    const other = await f.add();
    await f.engine.start(now);
    await f.review('topic', ['First', 'Second']);
    await f.usage(id, { sessionId: 'watch-session', tokens: 12 });
    reads.clear();
    await f.engine.tick(now + 1000);
    expect(reads.hydrations()).toBe(0);
    const shown = project(f.engine, f.authority.projectId);
    expect(shown.threads.find((thread) => thread.artifactId === id)).toMatchObject({
      openComments: 2,
      sessions: [{ agent: 'codex', session_id: 'watch-session', status: 'exact', tokens: 12 }],
    });
    expect(shown.threads.find((thread) => thread.artifactId === other)).toMatchObject({
      openComments: 0,
      sessions: [],
    });
    expect(f.engine.snapshot!.totals).toMatchObject({ sessionTokens: 12, usageStatus: 'exact' });
  });

  it('keeps incomplete per-session usage as a lower bound while totals count exact sessions only', async () => {
    const f = await fixture();
    const id = await f.add();
    await f.usage(id, { sessionId: 'exact-session', tokens: 12 });
    await f.usage(id, { sessionId: 'partial-session', tokens: 30 });
    const usage = readUsage(await f.writer(), { artifactIds: [id] });
    vi.mocked(database.readProjectUsageAccounting).mockImplementationOnce(() => ({
      ...usage,
      events: usage.events.map((event) => {
        const payload = event.payload as { session_id?: unknown };
        return payload.session_id === 'partial-session'
          ? {
              ...event,
              completeness: { state: 'incomplete', reasons: ['retained source was partial'] },
            }
          : event;
      }),
    }));

    await f.engine.start(now);

    expect(project(f.engine, f.authority.projectId).threads[0]!.sessions).toEqual([
      { agent: 'codex', session_id: 'exact-session', status: 'exact', tokens: 12 },
      { agent: 'codex', session_id: 'partial-session', status: 'incomplete', tokens: 30 },
    ]);
    expect(f.engine.snapshot!.totals).toMatchObject({ sessionTokens: 12, usageStatus: 'partial' });
  });

  it('clears a transient usage failure on the next tick without new history', async () => {
    const f = await fixture();
    const id = await f.add();
    await f.usage(id, { sessionId: 'watch-session', tokens: 12 });
    vi.mocked(database.readProjectUsageAccounting).mockImplementationOnce(() => {
      throw new Error('Usage is temporarily unreadable');
    });
    await f.engine.start(now);
    expect(project(f.engine, f.authority.projectId)).toMatchObject({
      state: 'current',
      completeness: {
        complete: false,
        issues: [{ code: 'HISTORY_WATCH_UNAVAILABLE', project_id: f.authority.projectId }],
      },
    });
    expect(f.engine.snapshot!.totals.usageStatus).toBe('unavailable');
    reads.clear();
    await f.engine.tick(now + 1000);
    expect(project(f.engine, f.authority.projectId)).toMatchObject({
      state: 'current',
      completeness: { complete: true, issues: [] },
    });
    expect(f.engine.snapshot!.totals).toMatchObject({ sessionTokens: 12, usageStatus: 'exact' });
    expect(reads.usage()).toBe(1);
    expect(reads.selections()).toBe(1);
    expect(reads.hydrations()).toBe(0);
    expect(f.engine.timings!.hydratedArtifacts).toBe(0);
  });

  it('discloses a missing sibling database without initializing it and keeps the registered project current', async () => {
    const f = await fixture();
    await f.add();
    const sibling = await f.addProject();
    await f.add({ writer: sibling.writer, branch: 'sibling' });
    await f.engine.start(now);
    expect(f.engine.snapshot!.projects).toHaveLength(2);
    sibling.writer.close();
    await rm(database.projectDatabasePath(sibling.authority));
    await f.engine.tick(now + 1000);
    const snapshot = f.engine.snapshot!;
    expect(snapshot).toMatchObject({ state: 'deferred', completeness: { complete: false } });
    expect(
      snapshot.completeness.issues.filter(
        (issue) => issue.project_id === sibling.authority.projectId
      )
    ).toEqual([expect.objectContaining({ code: 'HISTORY_MISSING' })]);
    expect(project(f.engine, sibling.authority.projectId)).toMatchObject({
      state: 'deferred',
      completeness: { complete: false, issues: [{ code: 'HISTORY_MISSING' }] },
    });
    expect(project(f.engine, sibling.authority.projectId).threads).toHaveLength(1);
    expect(project(f.engine, f.authority.projectId)).toMatchObject({
      state: 'current',
      completeness: { complete: true },
    });
    await f.engine.tick(now + 2000);
    expect(project(f.engine, sibling.authority.projectId)).toMatchObject({
      state: 'unavailable',
      threads: [],
      completeness: { issues: [{ code: 'HISTORY_MISSING' }] },
    });
    expect(
      f.engine.snapshot!.completeness.issues.filter(
        (issue) => issue.project_id === sibling.authority.projectId
      )
    ).toHaveLength(1);
    await expect(
      database.openProjectDatabase({ authority: sibling.authority, mode: 'reader' })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  });

  it('retains the last display while the database is displaced and recovers once restored', async () => {
    const f = await fixture();
    const id = await f.add();
    await f.engine.start(now);
    const file = database.projectDatabasePath(f.authority);
    await rename(file, `${file}.displaced`);
    try {
      await f.engine.tick(now + 1000);
    } finally {
      await rename(`${file}.displaced`, file);
    }
    expect(project(f.engine, f.authority.projectId)).toMatchObject({
      state: 'deferred',
      completeness: { complete: false, issues: [{ code: 'HISTORY_MISSING' }] },
    });
    expect(project(f.engine, f.authority.projectId).threads[0]!.artifactId).toBe(id);
    expect(project(f.engine, f.authority.projectId).completeness.issues.length).toBeGreaterThan(0);
    await f.engine.tick(now + 2000);
    expect(f.engine.snapshot).toMatchObject({ state: 'current', completeness: { complete: true } });
  });

  it('watches the data root projects directory so a published project pushes a tick', async () => {
    const f = await fixture();
    await f.add();
    await f.engine.start(now);
    expect(f.engine.getWatchRoots()).toEqual([path.join(f.root, 'projects')]);
    expect(f.engine.snapshot!.projects).toHaveLength(1);
    let pushes = 0;
    const watcher = new FsWatch({
      roots: f.engine.getWatchRoots(),
      debounceMs: 25,
      onTick: () => {
        pushes += 1;
        void f.engine.tick(now + pushes * 1000);
      },
    });
    expect(watcher.start()).toBe(true);
    const sibling = await f.addProject();
    try {
      await vi.waitFor(
        () => {
          expect(f.engine.snapshot!.projects.map((p) => p.projectId).sort()).toEqual(
            [f.authority.projectId, sibling.authority.projectId].sort()
          );
        },
        { timeout: 30_000, interval: 100 }
      );
    } finally {
      watcher.close();
      sibling.writer.close();
    }
    expect(pushes).toBeGreaterThan(0);
  });

  it('opens a project catalogued between the scope resolution and the inventory stamp', async () => {
    const f = await fixture();
    await f.add();
    let sibling: Awaited<ReturnType<typeof f.addProject>> | null = null;
    vi.mocked(projectScope.resolveDatabaseHistoryScope).mockImplementationOnce(async (input) => {
      const resolved = await resolveScope(input);
      sibling = await f.addProject();
      return resolved;
    });
    await f.engine.start(now);
    const catalogued = sibling as unknown as Awaited<ReturnType<typeof f.addProject>>;
    expect(f.engine.snapshot!.projects.map((project) => project.projectId).sort()).toEqual(
      [f.authority.projectId, catalogued.authority.projectId].sort()
    );
    reads.clear();
    await f.engine.tick(now + 1000);
    expect(f.engine.snapshot!.projects).toHaveLength(2);
    expect(reads.resolutions()).toBe(0);
    expect(reads.selections()).toBe(0);
    expect(reads.hydrations()).toBe(0);
  });

  it('names each open project database and its write-ahead log as a watch file', async () => {
    const f = await fixture();
    await f.add();
    const sibling = await f.addProject();
    await f.engine.start(now);
    try {
      const main = database.projectDatabasePath(f.authority);
      const other = database.projectDatabasePath(sibling.authority);
      expect(f.engine.getWatchFiles().sort()).toEqual(
        [main, `${main}-wal`, other, `${other}-wal`].sort()
      );
    } finally {
      sibling.writer.close();
    }
    await f.engine.close();
    expect(f.engine.getWatchFiles()).toEqual([]);
  });

  it('serializes concurrent ticks and refuses work after close', async () => {
    const f = await fixture();
    await f.add();
    await f.engine.start(now);
    const listener = vi.fn();
    f.engine.on('snapshot', listener);
    await Promise.all([f.engine.tick(now + 1000), f.engine.tick(now + 2000)]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(f.engine.snapshot!.generatedAtMs).toBe(now + 2000);
    await f.engine.close();
    await f.engine.tick(now + 3000);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(f.engine.getWatchRoots()).toEqual([]);
  });
});

it.each(['saved', 'fallback'])(
  'shows the %s repository name outside a deleted checkout without publishing records',
  async (source) => {
    const f = await historyDatabaseFixture();
    fixtures.push(f);
    await f.add();
    await rm(f.cwd, { recursive: true, force: true });
    if (source === 'fallback') vi.mocked(database.readProjectDisplayName).mockReturnValueOnce(null);
    const writer = await f.writer();
    const before = writer.read(() => null).counters;
    const engine = new HistoryWatchEngine({
      scope: { root: f.root, cwd: f.temporary, selector: { scope: 'all-projects' } },
      activityReader: {
        async readLastActivity() {
          return new Map();
        },
      },
    });
    engines.push(engine);
    try {
      await engine.start(now);
      const shown = project(engine, f.authority.projectId);
      expect(shown.displayName).toBe('checkout');
      expect(shown.threads).toHaveLength(1);
      expect(shown.threads[0].isCurrentCheckout).toBe(false);
      expect(writer.read(() => null).counters).toEqual(before);
    } finally {
      writer.close();
    }
  }
);
