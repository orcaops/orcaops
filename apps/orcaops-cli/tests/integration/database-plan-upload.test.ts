import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OssSourcePlanUploadPayload } from '@orcaops/sdk';
import {
  type ProjectWait,
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { fixture, git } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

const seams = vi.hoisted(() => ({
  connect: vi.fn(),
  create: vi.fn(),
  listReviewers: vi.fn(),
  uploadOptions: [] as Array<{
    signal?: AbortSignal;
    onWait?: (wait: ProjectWait) => void;
  }>,
  usage: vi.fn(async () => ({ state: 'unavailable', usage_source: 'unavailable' })),
  abortDuringWriterOpen: false,
  failLocatorOnce: false,
  waitOnUpload: false,
  writerOpens: 0,
  writerSignals: [] as Array<AbortSignal | undefined>,
}));

vi.mock('@orcaops/storage/history/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orcaops/storage/history/database')>();
  return {
    ...actual,
    publishProjectSourcePlanLocator: async (
      ...args: Parameters<typeof actual.publishProjectSourcePlanLocator>
    ) => {
      if (seams.failLocatorOnce) {
        seams.failLocatorOnce = false;
        throw new actual.ProjectDatabaseError(
          'STALE_CONTEXT',
          'The upload locator changed before local settlement'
        );
      }
      return actual.publishProjectSourcePlanLocator(...args);
    },
  };
});

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

vi.mock('../../src/lib/database-source-plan-upload.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/lib/database-source-plan-upload.js')>();
  return {
    ...actual,
    runDatabaseSourcePlanUpload: (
      options: Parameters<typeof actual.runDatabaseSourcePlanUpload>[0]
    ) => {
      seams.uploadOptions.push(options);
      if (seams.waitOnUpload) {
        const wait = {
          operation: 'source_plan.upload.begin',
          reason: 'admission',
          attempt: 1,
        } as const;
        options.onWait?.(wait);
        options.onWait?.(wait);
      }
      return actual.runDatabaseSourcePlanUpload(options);
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

function environment(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_CLOUD_FEATURES: '1',
    ORCAOPS_DISABLE_DRAIN: '1',
    CODEX_SESSION_ID: 'source-plan-upload-test',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    XDG_STATE_HOME: path.join(f.temporary, 'state'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  seams.uploadOptions.length = 0;
  seams.abortDuringWriterOpen = false;
  seams.failLocatorOnce = false;
  seams.waitOnUpload = false;
  seams.writerOpens = 0;
  seams.writerSignals.length = 0;
  seams.create.mockImplementation(async (payload: OssSourcePlanUploadPayload) => ({
    id: 'draft-row',
    externalId: payload.external_id,
    slug: 'registered-plan',
    status: 'DRAFT',
    unresolved: [],
  }));
  seams.listReviewers.mockResolvedValue({ members: [], scope: 'organization' });
  seams.connect.mockResolvedValue({
    client: {
      sourcePlan: { create: seams.create, listReviewers: seams.listReviewers },
    },
    target,
    credentialStore: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registered plan upload command', { timeout: 30_000 }, () => {
  it('uses the authenticated account, retains the upload, and replays without another send', async () => {
    const f = await fixture();
    const file = path.join(f.main, 'source-plan.md');
    await writeFile(file, '# Registered source plan\n');
    const agent = makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    });
    seams.waitOnUpload = true;
    const first = await agent.runRaw([
      'plan',
      'upload',
      'source-plan.md',
      '--title',
      'Registered plan',
      '--json',
    ]);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    const result = JSON.parse(first.stdout) as { external_id: string; slug: string };
    expect(result).toMatchObject({ ok: true, slug: 'registered-plan' });
    expect(first.stderr).toBe(
      'Waiting for plan upload on the selected project database; Ctrl-C cancels the wait.\n'
    );
    expect(seams.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: target.server_url,
        operation: 'plan upload',
        requires: [],
        signal: expect.any(AbortSignal),
      })
    );
    expect(seams.create).toHaveBeenCalledTimes(1);
    expect(seams.uploadOptions[0]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal), onWait: expect.any(Function) })
    );
    const namespace = readProjectSourcePlanNamespace(f.writer, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    })!;
    expect(
      readProjectSourcePlanLocator(f.writer, {
        namespaceId: namespace.namespaceId,
        kind: 'upload',
        realPath: file,
      })?.record.externalId
    ).toBe(result.external_id);
    expect(
      f.writer.read((view) =>
        view.get<{ count: number }>('SELECT count(*) AS count FROM source_plan_upload_commands')
      ).value?.count
    ).toBe(1);
    await expect(
      stat(path.join(f.main, '.orcaops', 'cache', 'source-plan', 'uploads'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const counters = f.writer.read(() => null).counters;
    const opens = seams.writerOpens;

    seams.waitOnUpload = false;
    const replay = await agent.runRaw([
      'plan',
      'upload',
      'source-plan.md',
      '--title',
      'Registered plan',
      '--json',
    ]);
    expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual(result);
    expect(seams.create).toHaveBeenCalledTimes(1);
    expect(seams.writerOpens).toBe(opens + 1);
    expect(f.writer.read(() => null).counters).toEqual(counters);
    expect(seams.usage).toHaveBeenCalled();
  });

  it('retains an unknown acknowledgement and refuses to resend it', async () => {
    const f = await fixture();
    await writeFile(path.join(f.main, 'source-plan.md'), '# Registered source plan\n');
    seams.create.mockRejectedValueOnce(new Error('response lost'));
    const agent = makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    });
    const command = ['plan', 'upload', 'source-plan.md', '--title', 'Registered plan', '--json'];
    expect((await agent.runRaw(command)).exitCode).toBe(1);
    const after = f.writer.read(() => null).counters;
    expect((await agent.runRaw(command)).exitCode).toBe(1);
    expect(seams.create).toHaveBeenCalledTimes(1);
    expect(f.writer.read(() => null).counters).toEqual(after);
  });

  it('does not connect or initialize history for unsafe input or a missing registration', async () => {
    const unregistered = await mkdtemp(path.join(tmpdir(), 'database-plan-upload-missing-'));
    try {
      await git(unregistered, ['init', '-qb', 'main']);
      await git(unregistered, ['commit', '--allow-empty', '-qm', 'Initial']);
      const file = path.join(unregistered, 'source-plan.md');
      await writeFile(file, '# Source plan\n');
      const data = path.join(unregistered, 'data');
      const missing = await makeAgent({
        cwd: unregistered,
        env: {
          ORCAOPS_ROOT: unregistered,
          ORCAOPS_DATA_DIR: data,
          ORCAOPS_CLOUD_FEATURES: '1',
          ORCAOPS_DISABLE_DRAIN: '1',
        },
        cloudBaseUrl: target.server_url,
      }).runRaw(['plan', 'upload', file, '--title', 'Source plan', '--json']);
      expect(missing.exitCode).toBe(1);
      await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(seams.connect).not.toHaveBeenCalled();
    } finally {
      await rm(unregistered, { recursive: true, force: true });
    }

    const f = await fixture();
    await writeFile(path.join(f.main, 'source-plan.md'), 'ghp_' + 'A'.repeat(36));
    const refused = await makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'upload', 'source-plan.md', '--title', 'Source plan', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(seams.connect).not.toHaveBeenCalled();
    expect(seams.writerOpens).toBe(0);

    const secretPath = 'ghp_' + 'B'.repeat(36) + '.md';
    await writeFile(path.join(f.main, secretPath), '# Source plan\n');
    const refusedPath = await makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'upload', secretPath, '--title', 'Source plan', '--json']);
    expect(refusedPath.exitCode).toBe(1);
    expect(seams.connect).not.toHaveBeenCalled();
    expect(seams.writerOpens).toBe(0);
  });

  it('passes cancellation through connection qualification without opening a writer', async () => {
    const f = await fixture();
    await writeFile(path.join(f.main, 'source-plan.md'), '# Source plan\n');
    seams.connect.mockImplementation(async () => {
      process.emit('SIGINT');
      return {
        client: { sourcePlan: { create: seams.create, listReviewers: seams.listReviewers } },
        target,
        credentialStore: {},
      };
    });
    const listeners = process.listenerCount('SIGINT');
    const result = await makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'upload', 'source-plan.md', '--title', 'Source plan', '--json']);
    expect(result.exitCode).toBe(1);
    expect(seams.create).not.toHaveBeenCalled();
    expect(seams.writerOpens).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });

  it('refuses a changed cloud target before opening a writer or sending the upload', async () => {
    const f = await fixture();
    await writeFile(path.join(f.main, 'source-plan.md'), '# Source plan\n');
    seams.connect.mockRejectedValueOnce(
      Object.assign(new Error('The authenticated cloud target changed'), {
        code: 'CLOUD_TARGET_CHANGED',
      })
    );
    const result = await makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'upload', 'source-plan.md', '--title', 'Source plan', '--json']);
    expect(result.exitCode).toBe(1);
    expect((JSON.parse(result.stdout) as { error: { message: string } }).error.message).toContain(
      'The authenticated cloud target changed'
    );
    expect(seams.create).not.toHaveBeenCalled();
    expect(seams.writerOpens).toBe(0);
  });

  it('honors cancellation while opening the writer without admitting a command or sending', async () => {
    const f = await fixture();
    await writeFile(path.join(f.main, 'source-plan.md'), '# Source plan\n');
    seams.abortDuringWriterOpen = true;
    const listeners = process.listenerCount('SIGINT');
    const result = await makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    }).runRaw(['plan', 'upload', 'source-plan.md', '--title', 'Source plan', '--json']);
    expect(result.exitCode).toBe(1);
    expect(seams.create).not.toHaveBeenCalled();
    expect(
      f.writer.read((view) =>
        view.get<{ count: number }>('SELECT count(*) AS count FROM source_plan_upload_commands')
      ).value?.count
    ).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });

  it('recovers an acknowledged upload locally without resending it', async () => {
    const f = await fixture();
    const file = path.join(f.main, 'source-plan.md');
    const originalBody = '# Original source plan\n';
    await writeFile(file, originalBody);
    const agent = makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    });
    const command = ['plan', 'upload', 'source-plan.md', '--title', 'Source plan', '--json'];

    seams.failLocatorOnce = true;
    expect((await agent.runRaw(command)).exitCode).toBe(1);
    expect(seams.create).toHaveBeenCalledTimes(1);

    const recovered = await agent.runRaw(command);
    expect(recovered.exitCode, recovered.stdout + recovered.stderr).toBe(0);
    expect(seams.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to rebase an acknowledged upload after a newer upload becomes current', async () => {
    const f = await fixture();
    const file = path.join(f.main, 'source-plan.md');
    const originalBody = '# Original source plan\n';
    await writeFile(file, originalBody);
    const agent = makeAgent({
      cwd: f.main,
      env: environment(f),
      cloudBaseUrl: target.server_url,
    });
    const command = ['plan', 'upload', 'source-plan.md', '--title', 'Source plan', '--json'];

    seams.failLocatorOnce = true;
    expect((await agent.runRaw(command)).exitCode).toBe(1);
    expect(seams.create).toHaveBeenCalledTimes(1);

    await writeFile(file, '# Newer source plan\n');
    const changed = await agent.runRaw(command);
    expect(changed.exitCode, changed.stdout + changed.stderr).toBe(0);
    const changedExternalId = (JSON.parse(changed.stdout) as { external_id: string }).external_id;
    expect(seams.create).toHaveBeenCalledTimes(2);

    await writeFile(file, originalBody);
    const stale = await agent.runRaw(command);
    expect(stale.exitCode).toBe(1);
    expect((JSON.parse(stale.stdout) as { error: { message: string } }).error.message).toContain(
      'selection changed'
    );
    expect(seams.create).toHaveBeenCalledTimes(2);
    const namespace = readProjectSourcePlanNamespace(f.writer, {
      serverUrl: target.server_url,
      orgId: target.org_id,
      accountId: target.account_id,
    })!;
    expect(
      readProjectSourcePlanLocator(f.writer, {
        namespaceId: namespace.namespaceId,
        kind: 'upload',
        realPath: file,
      })?.record.externalId
    ).toBe(changedExternalId);
  });
});
