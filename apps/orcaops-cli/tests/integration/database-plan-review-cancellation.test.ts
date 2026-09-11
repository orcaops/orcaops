import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

import type { OssSourcePlanReviewPush } from '@orcaops/sdk';
import { ReviewPullRecordSchema } from '@orcaops/storage';
import {
  readProjectSourcePlanNamespace,
  readProjectSourcePlanReview,
} from '@orcaops/storage/history/database';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import { fixture } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

const seams = vi.hoisted(() => ({
  connect: vi.fn(),
  push: vi.fn(),
  writerSignals: [] as Array<AbortSignal | undefined>,
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
      seams.writerSignals.push(signal);
      return actual.openDatabaseCaptureWriter(context, signal);
    },
  };
});

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
    CODEX_SESSION_ID: 'source-plan-review-cancellation-test',
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    XDG_STATE_HOME: path.join(f.temporary, 'state'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.writerSignals.length = 0;
  seams.push.mockImplementation(async (request: OssSourcePlanReviewPush) => {
    process.emit('SIGINT');
    return {
      status: 'published' as const,
      externalId: request.external_id,
      candidateVersionId: 'candidate-after-cancel',
      candidateVersionNumber: 4,
      contentHash: request.content_hash,
    };
  });
  seams.connect.mockResolvedValue({
    client: { sourcePlan: { reviewPush: seams.push } },
    target,
    credentialStore: {},
  });
});

it('settles an acknowledged review push after SIGINT during the SDK call', async () => {
  const f = await fixture();
  const body = '# Published after cancellation\n';
  await writeFile(path.join(f.main, 'source-plan.md'), body);
  const agent = makeAgent({
    cwd: f.main,
    env: environment(f),
    cloudBaseUrl: target.server_url,
  });
  const listeners = process.listenerCount('SIGINT');

  const result = await agent.runRaw([
    'plan',
    'review',
    'push',
    'source-plan-id',
    '--input',
    'source-plan.md',
    '--base-version-id',
    'candidate-original',
    '--json',
  ]);

  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(seams.push).toHaveBeenCalledTimes(1);
  expect(seams.writerSignals[0]).toBeInstanceOf(AbortSignal);
  expect(seams.writerSignals[0]?.aborted).toBe(true);
  expect(seams.writerSignals).toContain(undefined);
  expect(process.listenerCount('SIGINT')).toBe(listeners);

  const namespace = readProjectSourcePlanNamespace(f.writer, {
    serverUrl: target.server_url,
    orgId: target.org_id,
    accountId: target.account_id,
  });
  const selected = readProjectSourcePlanReview(f.writer, {
    namespaceId: namespace!.namespaceId,
    kind: 'candidate',
    subjectId: 'source-plan-id',
  });
  const record = ReviewPullRecordSchema.parse(
    JSON.parse(Buffer.from(selected!.record.recordBase64, 'base64').toString('utf8'))
  );
  expect(record).toMatchObject({
    external_id: 'source-plan-id',
    version_id: 'candidate-after-cancel',
    version_number: 4,
    body,
  });
});
