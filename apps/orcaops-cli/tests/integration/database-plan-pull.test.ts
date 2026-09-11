import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SourcePlanApprovedPull } from '@orcaops/sdk';
import { sha256Hex } from '@orcaops/storage';
import {
  type ProjectWait,
  readProjectApprovedSourcePlan,
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { fixture, git } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

const seams = vi.hoisted(() => ({
  connect: vi.fn(),
  abortDuringWriterOpen: false,
  events: [] as string[],
  failLocator: false,
  persistenceOptions: [] as Array<{ onWait?: (wait: ProjectWait) => void; signal?: AbortSignal }>,
  usage: vi.fn(async () => ({ state: 'unavailable', usage_source: 'unavailable' })),
  waitOnRecord: false,
  writerSignals: [] as Array<AbortSignal | undefined>,
  writerOpens: 0,
}));

vi.mock('@orcaops/core/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@orcaops/core/history')>()),
  createCanonicalCloudClient: seams.connect,
}));

vi.mock('../../src/lib/database-capture-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/database-capture-context.js')>();
  return {
    ...actual,
    openDatabaseCaptureWriter: async (
      context: Parameters<typeof actual.openDatabaseCaptureWriter>[0],
      signal?: AbortSignal
    ) => {
      seams.writerOpens += 1;
      seams.writerSignals.push(signal);
      if (seams.abortDuringWriterOpen) process.emit('SIGINT');
      return actual.openDatabaseCaptureWriter(context, signal);
    },
  };
});

vi.mock('../../src/lib/database-source-plan-pull.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/lib/database-source-plan-pull.js')>();
  return {
    ...actual,
    createDatabasePlanPullPersistence: (
      options: Parameters<typeof actual.createDatabasePlanPullPersistence>[0]
    ) => {
      seams.persistenceOptions.push(options);
      const persistence = actual.createDatabasePlanPullPersistence(options);
      return {
        ...persistence,
        async writeRecord(value: Parameters<typeof persistence.writeRecord>[0]) {
          seams.events.push('record');
          if (seams.waitOnRecord) {
            const wait = {
              operation: 'source_plan.record',
              reason: 'admission' as const,
              attempt: 1,
            };
            options.onWait?.(wait);
            options.onWait?.(wait);
          }
          await persistence.writeRecord(value);
        },
        async writePathPointer(value: Parameters<typeof persistence.writePathPointer>[0]) {
          seams.events.push('locator');
          if (seams.failLocator) throw new Error('locator unavailable');
          await persistence.writePathPointer(value);
        },
      };
    },
  };
});

vi.mock('../../src/lib/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/atomic-write.js')>();
  return {
    ...actual,
    atomicWriteFile: async (...args: Parameters<typeof actual.atomicWriteFile>) => {
      seams.events.push('output');
      return actual.atomicWriteFile(...args);
    },
  };
});

vi.mock('../../src/lib/database-usage-stamp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/database-usage-stamp.js')>()),
  stampDatabaseUsage: seams.usage,
}));

const target: RemoteTarget = {
  server_url: 'https://cloud.example.test',
  org_id: 'organization',
  account_id: 'account-a',
};

function approved(body = 'Use the accepted Source Plan.\n'): SourcePlanApprovedPull {
  return {
    externalId: 'source-plan-id',
    slug: 'source-plan',
    title: 'Source Plan',
    approvedVersion: {
      versionNumber: 3,
      body,
      contentHash: sha256Hex(body),
      sourceRef: 'plans/source.md',
    },
  };
}

function environment(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_CLOUD_FEATURES: '1',
    ORCAOPS_DISABLE_DRAIN: '1',
    CODEX_SESSION_ID: 'source-plan-pull-test',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    XDG_STATE_HOME: path.join(f.temporary, 'state'),
  };
}

function connectAs(selectedTarget: RemoteTarget, response = approved()) {
  seams.connect.mockResolvedValue({
    client: {
      sourcePlan: {
        getApproved: vi.fn(async () => response),
        get: vi.fn(),
      },
    },
    target: selectedTarget,
    credentialStore: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  seams.abortDuringWriterOpen = false;
  seams.events.length = 0;
  seams.failLocator = false;
  seams.persistenceOptions.length = 0;
  seams.waitOnRecord = false;
  seams.writerSignals.length = 0;
  seams.writerOpens = 0;
  connectAs(target);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registered plan pull command', { timeout: 30_000 }, () => {
  it('uses the authenticated account and publishes record, output, locator, and usage in order', async () => {
    const f = await fixture();
    seams.waitOnRecord = true;
    const output = path.join(f.main, 'approved.md');
    const result = await makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'pull', 'source-plan', '--out', 'approved.md', '--json']);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      external_id: 'source-plan-id',
      slug: 'source-plan',
      version_number: 3,
      ref: 'cloud:source-plan-id@3',
      out: output,
    });
    expect(await readFile(output, 'utf8')).toBe('Use the accepted Source Plan.\n');
    expect(seams.events).toEqual(['record', 'output', 'locator']);
    expect(result.stderr).toBe(
      'Waiting for plan pull on the selected project database; Ctrl-C cancels the wait.\n'
    );
    expect(seams.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: target.server_url,
        operation: 'plan pull',
        requires: [],
      })
    );
    expect(seams.persistenceOptions).toEqual([
      expect.objectContaining({ signal: expect.any(AbortSignal), onWait: expect.any(Function) }),
    ]);
    const namespace = readProjectSourcePlanNamespace(f.writer, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    })!;
    const selected = readProjectApprovedSourcePlan(f.writer, {
      namespaceId: namespace.namespaceId,
      externalId: 'source-plan-id',
      approvedVersion: 3,
    })!;
    expect(
      readProjectSourcePlanLocator(f.writer, {
        namespaceId: namespace.namespaceId,
        kind: 'path',
        realPath: output,
      })?.record.approvedRecordId
    ).toBe(selected.selection.recordId);
    expect(seams.usage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        descriptor: expect.objectContaining({
          lifecycle_event: 'plan_review',
          sourcePlanRefId: 'cloud:source-plan-id',
        }),
        invokingAgent: 'codex',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal), onWait: expect.any(Function) })
    );
  });

  it('replays the same observation and retains the first selection on a later equal pull', async () => {
    const f = await fixture();
    const agent = makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-08T01:00:00Z'));
    expect(
      (await agent.runRaw(['plan', 'pull', 'source-plan', '--out', 'replay.md', '--json'])).exitCode
    ).toBe(0);
    const namespace = readProjectSourcePlanNamespace(f.writer, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    })!;
    const first = readProjectApprovedSourcePlan(f.writer, {
      namespaceId: namespace.namespaceId,
      externalId: 'source-plan-id',
      approvedVersion: 3,
    })!;
    const counters = f.writer.read(() => null).counters;
    expect(
      (await agent.runRaw(['plan', 'pull', 'source-plan', '--out', 'replay.md', '--json'])).exitCode
    ).toBe(0);
    expect(f.writer.read(() => null).counters).toEqual(counters);

    vi.setSystemTime(new Date('2026-09-08T02:00:00Z'));
    expect(
      (await agent.runRaw(['plan', 'pull', 'source-plan', '--out', 'replay.md', '--json'])).exitCode
    ).toBe(0);
    const later = readProjectApprovedSourcePlan(f.writer, {
      namespaceId: namespace.namespaceId,
      externalId: 'source-plan-id',
      approvedVersion: 3,
    })!;
    expect(later.selection).toEqual(first.selection);
    expect(
      f.writer.read((view) =>
        view.get<{ count: number }>(
          'SELECT count(*) AS count FROM source_plan_records WHERE namespace_id=?',
          namespace.namespaceId
        )
      ).value?.count
    ).toBe(2);
    expect(
      f.writer.read((view) =>
        view.get<{ count: number }>(
          'SELECT count(*) AS count FROM source_plan_locator_revisions WHERE namespace_id=?',
          namespace.namespaceId
        )
      ).value?.count
    ).toBe(1);
  });

  it('isolates two authenticated accounts and supports output outside the repository', async () => {
    const f = await fixture();
    const outside = await realpath(
      await mkdtemp(path.join(tmpdir(), 'database-plan-pull-output-'))
    );
    try {
      const agent = makeAgent({
        cwd: f.main,
        env: environment(f),
        cloudBaseUrl: target.server_url,
      });
      expect((await agent.runRaw(['plan', 'pull', 'source-plan', '--json'])).exitCode).toBe(0);
      const other = { ...target, account_id: 'account-b' };
      connectAs(other);
      const output = path.join(outside, 'approved.md');
      const result = await agent.runRaw(['plan', 'pull', 'source-plan', '--out', output]);
      const retainedOutput = await realpath(output);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        `Pulled source-plan-id (source-plan) v3\n` +
          `  wrote body → ${output}\n` +
          `  pin it with: --source-plan cloud:source-plan-id@3\n`
      );
      const namespaceA = readProjectSourcePlanNamespace(f.writer, {
        serverUrl: target.server_url,
        orgId: target.org_id,
        accountId: target.account_id,
      })!;
      const namespaceB = readProjectSourcePlanNamespace(f.writer, {
        serverUrl: other.server_url,
        orgId: other.org_id,
        accountId: other.account_id,
      })!;
      expect(namespaceA.namespaceId).not.toBe(namespaceB.namespaceId);
      expect(
        readProjectSourcePlanLocator(f.writer, {
          namespaceId: namespaceA.namespaceId,
          kind: 'path',
          realPath: retainedOutput,
        })
      ).toBeNull();
      expect(
        readProjectSourcePlanLocator(f.writer, {
          namespaceId: namespaceB.namespaceId,
          kind: 'path',
          realPath: retainedOutput,
        })
      ).not.toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses authored and inbound unsafe content before a writer opens', async () => {
    const f = await fixture();
    const agent = makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    });
    const before = f.writer.read((view) =>
      view.get<{ count: number }>('SELECT count(*) AS count FROM operations')
    ).value?.count;
    const authoredSecret = 'ghp_' + 'A'.repeat(36);
    const authored = await agent.runRaw(['plan', 'pull', authoredSecret, '--json']);
    expect(authored.exitCode).toBe(1);
    expect(JSON.parse(authored.stdout).error.code).toBe('SECRET_IN_PAYLOAD');
    const authoredOutput = await agent.runRaw([
      'plan',
      'pull',
      'source-plan',
      '--out',
      authoredSecret,
      '--json',
    ]);
    expect(authoredOutput.exitCode).toBe(1);
    expect(JSON.parse(authoredOutput.stdout).error.code).toBe('SECRET_IN_PAYLOAD');
    expect(seams.connect).not.toHaveBeenCalled();

    const cases = [
      approved('body'),
      approved('clean\u0085dirty'),
      approved('  \n'),
      approved('ghp_' + 'B'.repeat(36)),
    ];
    cases[0]!.approvedVersion.contentHash = '0'.repeat(64);
    for (const response of cases) {
      connectAs(target, response);
      const refused = await agent.runRaw(['plan', 'pull', 'source-plan', '--json']);
      expect(refused.exitCode).toBe(1);
    }
    expect(seams.writerOpens).toBe(0);
    expect(
      f.writer.read((view) =>
        view.get<{ count: number }>('SELECT count(*) AS count FROM operations')
      ).value?.count
    ).toBe(before);
  });

  it('refuses a missing nested output whose symlinked cwd resolves through a secret-like component before all effects', async () => {
    const f = await fixture();
    const secretWorktree = path.join(f.temporary, `ghp_${'C'.repeat(36)}`);
    const safeAlias = path.join(f.temporary, 'safe-worktree-alias');
    await git(f.main, ['worktree', 'add', '-qb', 'secret-output-worktree', secretWorktree]);
    await symlink(secretWorktree, safeAlias, 'dir');
    const gitDir = path.resolve(
      secretWorktree,
      (await git(secretWorktree, ['rev-parse', '--git-dir'])).stdout.trim()
    );
    const worktreeMarker = path.join(gitDir, 'orcaops', 'worktree.json');
    const output = path.join(secretWorktree, 'missing', 'nested', 'plan.md');
    const operationsBefore = f.writer.read((view) =>
      view.get<{ count: number }>('SELECT count(*) AS count FROM operations')
    ).value?.count;
    await expect(stat(worktreeMarker)).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await makeAgent({
      cwd: safeAlias,
      env: { ...environment(f), ORCAOPS_ROOT: safeAlias },
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'pull', 'source-plan', '--out', 'missing/nested/plan.md', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('SECRET_IN_PAYLOAD');
    expect(seams.connect).not.toHaveBeenCalled();
    expect(seams.writerOpens).toBe(0);
    expect(seams.events).toEqual([]);
    expect(
      f.writer.read((view) =>
        view.get<{ count: number }>('SELECT count(*) AS count FROM operations')
      ).value?.count
    ).toBe(operationsBefore);
    await expect(stat(path.join(secretWorktree, 'missing'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(worktreeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports output and locator failures with their completed local effects intact', async () => {
    const f = await fixture();
    const agent = makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    });
    const blocker = path.join(f.main, 'blocker');
    await mkdir(blocker);
    const failedOutput = blocker;
    const outputFailure = await agent.runRaw([
      'plan',
      'pull',
      'source-plan',
      '--out',
      failedOutput,
      '--json',
    ]);
    expect(outputFailure.exitCode).toBe(1);
    expect(seams.events).toEqual(['record', 'output']);
    const namespace = readProjectSourcePlanNamespace(f.writer, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    })!;
    expect(
      readProjectApprovedSourcePlan(f.writer, {
        namespaceId: namespace.namespaceId,
        externalId: 'source-plan-id',
        approvedVersion: 3,
      })
    ).not.toBeNull();
    expect(
      readProjectSourcePlanLocator(f.writer, {
        namespaceId: namespace.namespaceId,
        kind: 'path',
        realPath: failedOutput,
      })
    ).toBeNull();

    seams.events.length = 0;
    seams.failLocator = true;
    const output = path.join(f.main, 'locator-failure.md');
    const locatorFailure = await agent.runRaw([
      'plan',
      'pull',
      'source-plan',
      '--out',
      output,
      '--json',
    ]);
    expect(locatorFailure.exitCode).toBe(1);
    expect(seams.events).toEqual(['record', 'output', 'locator']);
    expect(await readFile(output, 'utf8')).toBe('Use the accepted Source Plan.\n');
    expect(
      readProjectSourcePlanLocator(f.writer, {
        namespaceId: namespace.namespaceId,
        kind: 'path',
        realPath: output,
      })
    ).toBeNull();
  });

  it('does not contact the cloud or create history for missing registration or a missing database', async () => {
    const unregistered = await mkdtemp(path.join(tmpdir(), 'database-plan-pull-unregistered-'));
    try {
      await git(unregistered, ['init', '-qb', 'main']);
      await git(unregistered, ['commit', '--allow-empty', '-qm', 'Initial']);
      const data = path.join(unregistered, 'data');
      const missingRegistration = await makeAgent({
        cwd: unregistered,
        env: {
          ORCAOPS_ROOT: unregistered,
          ORCAOPS_DATA_DIR: data,
          ORCAOPS_CLOUD_FEATURES: '1',
          ORCAOPS_DISABLE_DRAIN: '1',
        },
        cloudBaseUrl: target.server_url,
      }).runRaw(['plan', 'pull', 'source-plan', '--json']);
      expect(missingRegistration.exitCode).toBe(1);
      await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(seams.connect).not.toHaveBeenCalled();
    } finally {
      await rm(unregistered, { recursive: true, force: true });
    }

    const f = await fixture();
    const databasePath = f.writer.databasePath;
    await rm(databasePath);
    const missingDatabase = await makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'pull', 'source-plan', '--json']);
    expect(missingDatabase.exitCode).toBe(1);
    await expect(stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(seams.connect).not.toHaveBeenCalled();
  });

  it('cancels before writer admission and removes its interrupt listener', async () => {
    const f = await fixture();
    seams.connect.mockResolvedValue({
      client: {
        sourcePlan: {
          getApproved: vi.fn(async () => {
            process.emit('SIGINT');
            return approved();
          }),
          get: vi.fn(),
        },
      },
      target,
      credentialStore: {},
    });
    const listeners = process.listenerCount('SIGINT');
    const result = await makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'pull', 'source-plan', '--json']);
    expect(result.exitCode).toBe(1);
    expect(seams.writerOpens).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });

  it('cancels through the database open signal without publishing a record', async () => {
    const f = await fixture();
    seams.abortDuringWriterOpen = true;
    const operations = () =>
      f.writer.read((view) =>
        view.get<{ count: number }>('SELECT count(*) AS count FROM operations')
      ).value?.count;
    const before = operations();
    const listeners = process.listenerCount('SIGINT');

    const result = await makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'pull', 'source-plan', '--json']);

    expect(result.exitCode).toBe(1);
    expect(seams.writerOpens).toBe(1);
    expect(seams.writerSignals).toHaveLength(1);
    expect(seams.writerSignals[0]?.aborted).toBe(true);
    expect(seams.events).toEqual(['record']);
    expect(operations()).toBe(before);
    expect(seams.usage).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });
});
