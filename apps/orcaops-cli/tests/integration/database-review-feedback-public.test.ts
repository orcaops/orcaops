import { stat } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

import type { OssReviewFeedbackStatusResponse, OssReviewFeedbackTranscript } from '@orcaops/sdk';
import { uuidv7 } from '@orcaops/storage';
import {
  advanceProjectReviewFeedbackWatchCursor,
  readProjectReviewFeedbackWatchCursor,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

const seams = vi.hoisted(() => ({
  connect: vi.fn(),
  events: [] as string[],
  pull: vi.fn(),
  reply: vi.fn(),
  resolve: vi.fn(),
  status: vi.fn(),
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
      ...args: Parameters<typeof actual.openDatabaseCaptureWriter>
    ) => {
      seams.events.push('writer');
      return actual.openDatabaseCaptureWriter(...args);
    },
  };
});

const target: RemoteTarget = {
  server_url: 'https://cloud.example.test',
  org_id: 'organization',
  account_id: 'account-a',
};

const statusItem: OssReviewFeedbackStatusResponse['items'][number] = {
  subject: {
    task_number: 1,
    pull_request_id: 'pr_1',
    pull_request_number: 7,
    pull_request_title: 'Demo PR',
    pull_request_url: 'https://github.com/acme/demo/pull/7',
    current_snapshot_id: 'snapshot-1',
  },
  activity: {
    last_human_activity_at: '2026-09-09T00:05:00.000Z',
    last_agent_activity_at: null,
    has_new_human_activity: true,
    open_thread_count: 1,
    latest_submission: null,
  },
};

const transcript: OssReviewFeedbackTranscript = {
  subject: statusItem.subject,
  submissions: [],
  threads: [],
  dispositions: {
    open_thread_count: 0,
    resolved_thread_count: 0,
    finding_states: [],
  },
  activity: statusItem.activity,
};

function environment(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    ORCAOPS_ROOT: f.main,
    ORCAOPS_DATA_DIR: f.root,
    ORCAOPS_CLOUD_FEATURES: '1',
    ORCAOPS_DISABLE_DRAIN: '1',
    CODEX_SESSION_ID: 'review-feedback-database-test',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    XDG_STATE_HOME: path.join(f.temporary, 'state'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.events.length = 0;
  seams.pull.mockResolvedValue(transcript);
  seams.reply.mockResolvedValue({
    comment_id: 'reply-1',
    parent_comment_id: 'comment-1',
    published_at: '2026-09-09T00:06:00.000Z',
  });
  seams.resolve.mockResolvedValue({ comment_id: 'comment-1', status: 'RESOLVED' });
  seams.status.mockImplementation(async () => {
    seams.events.push('status');
    return { items: [statusItem] };
  });
  seams.connect.mockResolvedValue({
    client: {
      review: {
        pull: seams.pull,
        reply: seams.reply,
        resolve: seams.resolve,
        status: seams.status,
      },
    },
    target,
    credentialStore: {},
  });
});

it('pulls feedback without publishing a repository transcript cache', async () => {
  const f = await fixture();
  const result = await makeAgent({
    cwd: f.main,
    env: environment(f),
    cloudBaseUrl: target.server_url,
  }).runRaw(['review', 'pull', '--pr', 'pr_1', '--json']);

  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, ...transcript });
  expect(seams.pull).toHaveBeenCalledWith({
    schema_version: 1,
    task_number: null,
    pull_request_id: 'pr_1',
  });
  expect(seams.events).toEqual([]);
  await expect(stat(path.join(f.main, '.orcaops', 'cache'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('reads and advances the account-qualified watch cursor through project history', async () => {
  const f = await fixture();
  await advanceProjectReviewFeedbackWatchCursor(f.writer, {
    operationId: uuidv7(),
    target,
    pullRequestId: 'pr_1',
    cursor: '2026-09-09T00:04:00.000Z',
    advancedAt: '2026-09-09T00:04:01.000Z',
  });

  const result = await makeAgent({
    cwd: f.main,
    env: environment(f),
    cloudBaseUrl: target.server_url,
  }).runRaw(['review', 'watch', '--pr', 'pr_1', '--timeout', '1', '--json']);

  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    status: 'NEW_ACTIVITY',
    cursor: statusItem.activity.last_human_activity_at,
  });
  expect(seams.status).toHaveBeenCalledTimes(1);
  expect(seams.events).toEqual(['status', 'writer']);
  expect(
    readProjectReviewFeedbackWatchCursor(f.writer, {
      target,
      pullRequestId: 'pr_1',
    }).value
  ).toMatchObject({
    cursor: statusItem.activity.last_human_activity_at,
    version: 2,
  });
  await expect(stat(path.join(f.main, '.orcaops', 'cache'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('wires explicit reply and resolve operation keys through the registered commands', async () => {
  const f = await fixture();
  const agent = makeAgent({
    cwd: f.main,
    env: environment(f),
    cloudBaseUrl: target.server_url,
  });
  const replyArgs = [
    'review',
    'reply',
    'comment-1',
    '--message',
    'Addressed.',
    '--idempotency-key',
    'reply-operation',
    '--json',
  ];

  const first = await agent.runRaw(replyArgs);
  const replay = await agent.runRaw(replyArgs);
  const changed = await agent.runRaw([
    ...replyArgs.slice(0, 4),
    'Changed reply.',
    ...replyArgs.slice(5),
  ]);
  const resolved = await agent.runRaw([
    'review',
    'resolve',
    'comment-1',
    '--idempotency-key',
    'resolve-operation',
    '--json',
  ]);

  expect(first.exitCode, first.stdout + first.stderr).toBe(0);
  expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
  expect(changed.exitCode).toBe(1);
  expect(JSON.parse(changed.stdout)).toMatchObject({
    ok: false,
    error: { code: 'IDEMPOTENCY_CONFLICT' },
  });
  expect(resolved.exitCode, resolved.stdout + resolved.stderr).toBe(0);
  expect(seams.reply).toHaveBeenCalledTimes(1);
  expect(seams.resolve).toHaveBeenCalledTimes(1);
});

it('settles and replays a reply acknowledged after the public command is interrupted', async () => {
  const f = await fixture();
  const listeners = process.listenerCount('SIGINT');
  seams.reply.mockImplementationOnce(async () => {
    process.emit('SIGINT');
    return {
      comment_id: 'reply-after-interrupt',
      parent_comment_id: 'comment-1',
      published_at: '2026-09-09T00:06:00.000Z',
    };
  });
  const agent = makeAgent({
    cwd: f.main,
    env: environment(f),
    cloudBaseUrl: target.server_url,
  });
  const args = ['review', 'reply', 'comment-1', '--message', 'Addressed.', '--json'];

  const first = await agent.runRaw(args);
  const replay = await agent.runRaw(args);

  expect(first.exitCode, first.stdout + first.stderr).toBe(0);
  expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout)).toMatchObject({
    ok: true,
    comment_id: 'reply-after-interrupt',
  });
  expect(seams.reply).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGINT')).toBe(listeners);
});

it('refuses a secret-shaped feedback operation key before credentials or history writes', async () => {
  const f = await fixture();
  const before = f.writer.read(() => null).counters;
  const result = await makeAgent({
    cwd: f.main,
    env: environment(f),
    cloudBaseUrl: target.server_url,
  }).runRaw([
    'review',
    'resolve',
    'comment-1',
    '--idempotency-key',
    `ghp_${'a'.repeat(36)}`,
    '--json',
  ]);

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: 'SECRET_IN_PAYLOAD' },
  });
  expect(seams.connect).not.toHaveBeenCalled();
  expect(f.writer.read(() => null).counters).toEqual(before);
});
