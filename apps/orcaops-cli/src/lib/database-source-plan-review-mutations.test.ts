import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { isForbiddenError } from '@orcaops/core';
import { TrpcRequestError } from '@orcaops/sdk';
import { canonicalJson, type ReviewPullRecord, sha256Hex, uuidv7 } from '@orcaops/storage';
import { artifactOperationId } from '@orcaops/storage/history/artifact-operation-id';
import { normalizeHistoryRoot } from '@orcaops/storage/history/authority';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from '@orcaops/storage/history/database';
import { retainProjectRemoteRequest } from '@orcaops/storage/history/database/source-plan-upload';
import type { RemoteTransportScope } from '@orcaops/storage/history/database/source-plan-upload';
import type { RemoteTarget } from '@orcaops/storage/history/remote-target';

import {
  createDatabaseSourcePlanReviewMutationClient,
  type SourcePlanReviewMutationCloudClient,
} from './database-source-plan-review-mutations.js';
import { createDatabasePlanReviewPersistence } from './database-source-plan-review.js';
import { runReviewPropose } from '../commands/plan/review/propose.js';
import { runReviewPush } from '../commands/plan/review/push.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];

afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-review-mutation-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const initialized = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-09T00:00:00Z',
    authorize() {},
  });
  initialized.close();
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  const openWriter = vi.fn(async () => openProjectDatabase({ authority, mode: 'writer' }));
  return { reader, openWriter, root: root.resolvedRoot };
}

const target: RemoteTarget = {
  server_url: 'https://cloud.example.test',
  org_id: 'organization',
  account_id: 'account-a',
};

function cloud(): SourcePlanReviewMutationCloudClient {
  return {
    sourcePlan: {
      reviewRequest: vi.fn(async (input) => ({
        externalId: input.external_id,
        added: [{ userId: 'ben', rawTag: 'Ben' }],
        alreadyRequested: [],
        unresolved: [],
      })),
      reviewPush: vi.fn(async (input) => ({
        status: 'published' as const,
        externalId: input.external_id,
        candidateVersionId: 'candidate-next',
        candidateVersionNumber: 4,
        contentHash: input.content_hash,
      })),
      reviewPropose: vi.fn(async (input) => ({
        externalId: input.external_id,
        proposalId: 'proposal-one',
        baseVersionId: input.base_version_id,
        needsRebase: false,
      })),
      reviewComment: vi.fn(async (input) => ({
        externalId: input.external_id,
        commentId: 'comment-one',
      })),
      setReviewerVerdict: vi.fn(async (input) => ({
        externalId: input.external_id,
        reviewer: 'reviewer@example.test',
        state: input.verdict,
        note: input.note,
        updatedAt: '2026-09-09T00:00:00Z',
      })),
      declineProposal: vi.fn(async (input) => ({
        externalId: input.external_id,
        proposalId: input.proposal_id,
        state: 'DECLINED',
        reason: input.reason,
      })),
    },
  };
}

function client(
  f: Awaited<ReturnType<typeof fixture>>,
  remote: SourcePlanReviewMutationCloudClient,
  command: Record<string, unknown> = { verb: 'comment', body: 'Review comment' },
  options: { signal?: AbortSignal; now?: () => string; publicationAt?: string } = {}
) {
  let tick = 0;
  return createDatabaseSourcePlanReviewMutationClient({
    reader: f.reader,
    openWriter: f.openWriter,
    client: remote,
    target,
    command,
    secretAllow: [],
    now: options.now ?? (() => `2026-09-09T00:00:0${tick++}Z`),
    publicationAt: options.publicationAt ?? '2026-09-09T00:00:01Z',
    signal: options.signal,
  });
}

const comment = {
  schema_version: 1 as const,
  external_id: 'source-plan-id',
  parent_comment_id: null,
  target_version_id: 'candidate-version',
  target_proposal_id: null,
  body: 'Review comment',
  quote: null,
  disambiguator: null,
};

async function retainUnattemptedComment(
  f: Awaited<ReturnType<typeof fixture>>,
  command: Record<string, unknown>,
  payload: typeof comment
) {
  const projectId = f.reader.authority.projectId;
  const commandKey = artifactOperationId(
    projectId,
    canonicalJson({ target, command }),
    'source_plan.review.command'
  );
  const identity = {
    target,
    commandKey,
    ordinal: 0,
    method: 'sourcePlan.reviewComment' as const,
  };
  const requestId = artifactOperationId(
    projectId,
    canonicalJson(identity),
    'source_plan.review.request'
  );
  const scope: RemoteTransportScope = {
    target,
    artifactId: null,
    method: identity.method,
    targetExternalId: payload.external_id,
    idempotencyKey: commandKey,
  };
  const writer = await f.openWriter();
  try {
    await retainProjectRemoteRequest(
      writer,
      {
        operationId: artifactOperationId(
          projectId,
          canonicalJson(identity),
          'source_plan.review.request.operation'
        ),
        requestId,
        scope,
        expectedSelection: null,
        payloadBytes: Buffer.from(canonicalJson(payload)),
        preparedAt: '2026-09-09T00:00:00Z',
      },
      { secretAllow: [] }
    );
  } finally {
    writer.close();
  }
}

function candidate(body = '# Candidate\n'): ReviewPullRecord {
  return {
    schema_version: 1,
    target: 'candidate',
    external_id: 'source-plan-id',
    version_id: 'candidate-version',
    version_number: 3,
    proposal_id: null,
    base_version_number: null,
    content_hash: sha256Hex(body),
    body,
    base_url: target.server_url,
    org_id: target.org_id,
    pulled_at: '2026-09-09T00:00:00Z',
  };
}

function persistence(
  f: Awaited<ReturnType<typeof fixture>>,
  publicationAdmission?: ReturnType<typeof client>['publicationAdmission']
) {
  return createDatabasePlanReviewPersistence({
    reader: f.reader,
    target,
    secretAllow: [],
    openWriter: f.openWriter,
    publicationAdmission,
  });
}

it('replays an acknowledged mutation without another writer or SDK call', async () => {
  const f = await fixture();
  const remote = cloud();
  const first = await client(f, remote).sourcePlan.reviewComment(comment);
  const opens = f.openWriter.mock.calls.length;
  const counters = f.reader.read(() => null).counters;

  await expect(client(f, remote).sourcePlan.reviewComment(comment)).resolves.toEqual(first);
  expect(remote.sourcePlan.reviewComment).toHaveBeenCalledTimes(1);
  expect(f.openWriter).toHaveBeenCalledTimes(opens);
  expect(f.reader.read(() => null).counters).toEqual(counters);
});

it('retains an unknown result and refuses every automatic resend', async () => {
  const f = await fixture();
  const remote = cloud();
  vi.mocked(remote.sourcePlan.reviewComment).mockRejectedValueOnce(new Error('response lost'));
  await expect(client(f, remote).sourcePlan.reviewComment(comment)).rejects.toThrow(
    /not acknowledged/
  );
  const opens = f.openWriter.mock.calls.length;
  const counters = f.reader.read(() => null).counters;

  await expect(client(f, remote).sourcePlan.reviewComment(comment)).rejects.toThrow(
    /will not be resent.*orcaops plan review status.*orcaops plan review view source-plan-id.*cannot prove remote absence/i
  );
  expect(remote.sourcePlan.reviewComment).toHaveBeenCalledTimes(1);
  expect(f.openWriter).toHaveBeenCalledTimes(opens);
  expect(f.reader.read(() => null).counters).toEqual(counters);
});

it('replays an acknowledged cloud rejection with its typed classification', async () => {
  const f = await fixture();
  const remote = cloud();
  vi.mocked(remote.sourcePlan.reviewComment).mockRejectedValueOnce(
    new TrpcRequestError('forbidden', { code: 'FORBIDDEN', httpStatus: 403 })
  );
  await expect(client(f, remote).sourcePlan.reviewComment(comment)).rejects.toSatisfy(
    isForbiddenError
  );
  const opens = f.openWriter.mock.calls.length;

  await expect(client(f, remote).sourcePlan.reviewComment(comment)).rejects.toSatisfy(
    isForbiddenError
  );
  expect(remote.sourcePlan.reviewComment).toHaveBeenCalledTimes(1);
  expect(f.openWriter).toHaveBeenCalledTimes(opens);
});

it('allows only one concurrent invocation to call the SDK', async () => {
  const f = await fixture();
  const remote = cloud();
  const results = await Promise.allSettled([
    client(f, remote).sourcePlan.reviewComment(comment),
    client(f, remote).sourcePlan.reviewComment(comment),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).not.toHaveLength(0);
  expect(remote.sourcePlan.reviewComment).toHaveBeenCalledTimes(1);
});

it('resumes retained request bytes when the local comment target changes before attempt', async () => {
  const f = await fixture();
  const remote = cloud();
  const command = { verb: 'comment', body: comment.body };
  const original = { ...comment, target_version_id: 'candidate-original' };
  await retainUnattemptedComment(f, command, original);

  await client(f, remote, command).sourcePlan.reviewComment({
    ...comment,
    target_version_id: 'candidate-current',
  });

  expect(remote.sourcePlan.reviewComment).toHaveBeenCalledWith(original);
});

it('refuses a concurrent request with different resolved bytes under one command identity', async () => {
  const f = await fixture();
  const remote = cloud();
  const command = { verb: 'comment', body: comment.body };
  const results = await Promise.allSettled([
    client(f, remote, command).sourcePlan.reviewComment({
      ...comment,
      target_version_id: 'candidate-a',
    }),
    client(f, remote, command).sourcePlan.reviewComment({
      ...comment,
      target_version_id: 'candidate-b',
    }),
  ]);

  expect(remote.sourcePlan.reviewComment).toHaveBeenCalledTimes(1);
  expect(results.filter((result) => result.status === 'rejected')).toSatisfy(
    (rejected: PromiseRejectedResult[]) =>
      rejected.length === 1 && rejected[0].reason?.code === 'IDEMPOTENCY_CONFLICT'
  );
});

it('settles an acknowledged response after cancellation starts during the SDK call', async () => {
  const f = await fixture();
  const remote = cloud();
  const controller = new AbortController();
  vi.mocked(remote.sourcePlan.reviewComment).mockImplementationOnce(async (payload) => {
    controller.abort();
    return {
      externalId: payload.external_id,
      commentId: 'comment-after-cancel',
    };
  });

  await expect(
    client(f, remote, undefined, { signal: controller.signal }).sourcePlan.reviewComment(comment)
  ).resolves.toMatchObject({ commentId: 'comment-after-cancel' });
  await expect(client(f, remote).sourcePlan.reviewComment(comment)).resolves.toMatchObject({
    commentId: 'comment-after-cancel',
  });
  expect(remote.sourcePlan.reviewComment).toHaveBeenCalledTimes(1);
});

it('replays a successful propose-on-conflict push without retaining or dispatching a proposal', async () => {
  const f = await fixture();
  const remote = cloud();
  const records = persistence(f);
  await records.writeRecord(candidate());
  const body = '# Published candidate\n';
  const command = { verb: 'push', externalId: 'source-plan-id', body, onConflict: 'propose' };
  let runCount = 0;
  const run = () => {
    const pulledAt = `2026-09-09T00:00:0${++runCount}Z`;
    const transport = client(f, remote, command, { publicationAt: pulledAt });
    return runReviewPush({
      client: transport,
      persistence: persistence(f, transport.publicationAdmission),
      repoRoot: f.root,
      baseUrl: target.server_url,
      orgId: target.org_id,
      externalId: 'source-plan-id',
      body,
      onConflict: 'propose',
      baseline: null,
      pulledAt,
    });
  };

  const first = await run();
  const counters = f.reader.read(() => null).counters;
  await expect(run()).resolves.toEqual(first);
  expect(remote.sourcePlan.reviewPush).toHaveBeenCalledTimes(1);
  expect(remote.sourcePlan.reviewPropose).not.toHaveBeenCalled();
  expect(
    f.reader.read((view) =>
      view.get<{ count: number }>(
        "SELECT count(*) AS count FROM remote_requests WHERE method='sourcePlan.reviewPropose'"
      )
    ).value?.count
  ).toBe(0);
  expect(f.reader.read(() => null).counters).toEqual(counters);
  expect(await records.readCandidate('source-plan-id')).toMatchObject({
    version_id: 'candidate-next',
    pulled_at: '2026-09-09T00:00:01Z',
  });
});

it('recovers the original publication admission after candidate state changes', async () => {
  const f = await fixture();
  const remote = cloud();
  const records = persistence(f);
  await records.writeRecord(candidate());
  const body = '# Published candidate\n';
  const command = { verb: 'push', externalId: 'source-plan-id', body, onConflict: 'fail' };
  const request = {
    schema_version: 1 as const,
    external_id: 'source-plan-id',
    body,
    content_hash: sha256Hex(body),
    expected_candidate_version_id: 'candidate-version',
    on_conflict: 'fail' as const,
    baseline: null,
  };
  const first = client(f, remote, command, { publicationAt: '2026-09-09T00:00:01Z' });
  await first.sourcePlan.reviewPush(request);
  const original = first.publicationAdmission();
  expect(original).toMatchObject({
    expectedCandidateSelection: expect.objectContaining({ version: 1 }),
    publicationAt: '2026-09-09T00:00:01Z',
    request,
  });

  await records.writeRecord({
    ...candidate('# Later candidate\n'),
    version_id: 'candidate-later',
    version_number: 5,
    pulled_at: '2026-09-09T01:00:00Z',
  });
  const opens = f.openWriter.mock.calls.length;
  const retry = client(f, remote, command, { publicationAt: '2026-09-09T02:00:00Z' });
  await retry.sourcePlan.reviewPush({
    ...request,
    expected_candidate_version_id: 'candidate-later',
  });

  expect(retry.publicationAdmission()).toEqual(original);
  expect(remote.sourcePlan.reviewPush).toHaveBeenCalledTimes(1);
  expect(f.openWriter).toHaveBeenCalledTimes(opens);
});

it('does not restore an acknowledged candidate after a newer selection', async () => {
  const f = await fixture();
  const remote = cloud();
  const records = persistence(f);
  await records.writeRecord(candidate());
  const body = '# Published candidate\n';
  const command = { verb: 'push', externalId: 'source-plan-id', body, onConflict: 'fail' };
  const run = (pulledAt: string) => {
    const transport = client(f, remote, command, { publicationAt: pulledAt });
    return runReviewPush({
      client: transport,
      persistence: persistence(f, transport.publicationAdmission),
      repoRoot: f.root,
      baseUrl: target.server_url,
      orgId: target.org_id,
      externalId: 'source-plan-id',
      body,
      onConflict: 'fail',
      baseline: null,
      pulledAt,
    });
  };

  await run('2026-09-09T00:00:01Z');
  const newer = {
    ...candidate('# Later candidate\n'),
    version_id: 'candidate-later',
    version_number: 5,
    pulled_at: '2026-09-09T01:00:00Z',
  };
  await records.writeRecord(newer);
  const counters = f.reader.read(() => null).counters;
  const opens = f.openWriter.mock.calls.length;

  await expect(run('2026-09-09T02:00:00Z')).resolves.toMatchObject({ status: 'published' });
  expect(remote.sourcePlan.reviewPush).toHaveBeenCalledTimes(1);
  expect(f.openWriter).toHaveBeenCalledTimes(opens);
  expect(f.reader.read(() => null).counters).toEqual(counters);
  expect(await records.readCandidate('source-plan-id')).toEqual(newer);
});

it('does not publish an acknowledged candidate over state that changed before recovery', async () => {
  const f = await fixture();
  const remote = cloud();
  const records = persistence(f);
  await records.writeRecord(candidate());
  const body = '# Interrupted candidate\n';
  const command = { verb: 'push', externalId: 'source-plan-id', body, onConflict: 'fail' };
  let interruptPublication = true;
  const run = (pulledAt: string) => {
    const transport = client(f, remote, command, { publicationAt: pulledAt });
    const retained = persistence(f, transport.publicationAdmission);
    return runReviewPush({
      client: transport,
      persistence: {
        ...retained,
        async writeRecord(...args: Parameters<typeof retained.writeRecord>) {
          if (interruptPublication) {
            interruptPublication = false;
            throw new Error('interrupted before local publication');
          }
          return retained.writeRecord(...args);
        },
      },
      repoRoot: f.root,
      baseUrl: target.server_url,
      orgId: target.org_id,
      externalId: 'source-plan-id',
      body,
      onConflict: 'fail',
      baseline: null,
      pulledAt,
    });
  };

  await expect(run('2026-09-09T00:00:01Z')).rejects.toThrow('interrupted before local publication');
  const newer = {
    ...candidate('# Later candidate\n'),
    version_id: 'candidate-later',
    version_number: 5,
    pulled_at: '2026-09-09T01:00:00Z',
  };
  await records.writeRecord(newer);
  const counters = f.reader.read(() => null).counters;

  await expect(run('2026-09-09T02:00:00Z')).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  expect(remote.sourcePlan.reviewPush).toHaveBeenCalledTimes(1);
  expect(f.reader.read(() => null).counters).toEqual(counters);
  expect(await records.readCandidate('source-plan-id')).toEqual(newer);
});

it('publishes an acknowledged candidate after cancellation starts during the SDK call', async () => {
  const f = await fixture();
  const remote = cloud();
  const records = persistence(f);
  await records.writeRecord(candidate());
  const controller = new AbortController();
  vi.mocked(remote.sourcePlan.reviewPush).mockImplementationOnce(async (request) => {
    controller.abort();
    return {
      status: 'published',
      externalId: request.external_id,
      candidateVersionId: 'candidate-after-cancel',
      candidateVersionNumber: 4,
      contentHash: request.content_hash,
    };
  });
  const body = '# Published after cancel\n';
  const command = { verb: 'push', externalId: 'source-plan-id', body, onConflict: 'fail' };
  const transport = client(f, remote, command, {
    signal: controller.signal,
    publicationAt: '2026-09-09T00:00:01Z',
  });

  await expect(
    runReviewPush({
      client: transport,
      persistence: persistence(f, transport.publicationAdmission),
      repoRoot: f.root,
      baseUrl: target.server_url,
      orgId: target.org_id,
      externalId: 'source-plan-id',
      body,
      onConflict: 'fail',
      baseline: null,
      pulledAt: '2026-09-09T00:00:01Z',
    })
  ).resolves.toMatchObject({ candidate_version_id: 'candidate-after-cancel' });
  expect(await records.readCandidate('source-plan-id')).toMatchObject({
    version_id: 'candidate-after-cancel',
    body,
  });
  expect(remote.sourcePlan.reviewPush).toHaveBeenCalledTimes(1);
});

it('replays a proposal without refreshing its retained observation time', async () => {
  const f = await fixture();
  const remote = cloud();
  const records = persistence(f);
  await records.writeRecord(candidate());
  const body = '# Proposal\n';
  const command = { verb: 'propose', externalId: 'source-plan-id', body };
  const run = (pulledAt: string) => {
    const transport = client(f, remote, command, { publicationAt: pulledAt });
    return runReviewPropose({
      client: transport,
      persistence: persistence(f, transport.publicationAdmission),
      repoRoot: f.root,
      baseUrl: target.server_url,
      orgId: target.org_id,
      externalId: 'source-plan-id',
      body,
      baseline: null,
      pulledAt,
    });
  };

  const first = await run('2026-09-09T00:00:01Z');
  const counters = f.reader.read(() => null).counters;
  const opens = f.openWriter.mock.calls.length;
  await expect(run('2026-09-09T01:00:00Z')).resolves.toEqual(first);
  expect(remote.sourcePlan.reviewPropose).toHaveBeenCalledTimes(1);
  expect(f.openWriter).toHaveBeenCalledTimes(opens);
  expect(f.reader.read(() => null).counters).toEqual(counters);
  expect(await records.readProposal('source-plan-id', 'proposal-one')).toMatchObject({
    pulled_at: '2026-09-09T00:00:01Z',
  });
});

it('resumes a conflict proposal from the retained base after cancellation and cache change', async () => {
  const f = await fixture();
  const remote = cloud();
  const controller = new AbortController();
  vi.mocked(remote.sourcePlan.reviewPush).mockImplementationOnce(async () => {
    controller.abort();
    return {
      status: 'conflict',
      conflict: {
        current_candidate_version_id: 'candidate-current',
        current_version_number: 4,
      },
    };
  });
  const records = persistence(f);
  await records.writeRecord(candidate());
  const body = '# Proposed candidate\n';
  const command = { verb: 'push', externalId: 'source-plan-id', body, onConflict: 'propose' };
  const run = (signal?: AbortSignal, pulledAt = '2026-09-09T00:00:01Z') => {
    const transport = client(f, remote, command, { signal, publicationAt: pulledAt });
    return runReviewPush({
      client: transport,
      persistence: persistence(f, transport.publicationAdmission),
      repoRoot: f.root,
      baseUrl: target.server_url,
      orgId: target.org_id,
      externalId: 'source-plan-id',
      body,
      onConflict: 'propose',
      baseline: null,
      pulledAt,
    });
  };

  await expect(run(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(remote.sourcePlan.reviewPropose).not.toHaveBeenCalled();
  await records.writeRecord({
    ...candidate(),
    version_id: 'candidate-retry',
    version_number: 4,
    pulled_at: '2026-09-09T01:00:00Z',
  });

  await expect(run(undefined, '2026-09-09T02:00:00Z')).resolves.toMatchObject({
    status: 'filed_as_proposal',
    proposal_id: 'proposal-one',
  });
  expect(remote.sourcePlan.reviewPush).toHaveBeenCalledTimes(1);
  expect(remote.sourcePlan.reviewPropose).toHaveBeenCalledTimes(1);
  expect(remote.sourcePlan.reviewPropose).toHaveBeenCalledWith(
    expect.objectContaining({ base_version_id: 'candidate-version' })
  );
  expect(await records.readProposal('source-plan-id', 'proposal-one')).toMatchObject({
    body,
    proposal_id: 'proposal-one',
    pulled_at: '2026-09-09T02:00:00Z',
  });
  const counters = f.reader.read(() => null).counters;
  const opens = f.openWriter.mock.calls.length;
  await expect(run(undefined, '2026-09-09T03:00:00Z')).resolves.toMatchObject({
    status: 'filed_as_proposal',
    proposal_id: 'proposal-one',
  });
  expect(remote.sourcePlan.reviewPush).toHaveBeenCalledTimes(1);
  expect(remote.sourcePlan.reviewPropose).toHaveBeenCalledTimes(1);
  expect(f.openWriter).toHaveBeenCalledTimes(opens);
  expect(f.reader.read(() => null).counters).toEqual(counters);
  expect(await records.readProposal('source-plan-id', 'proposal-one')).toMatchObject({
    pulled_at: '2026-09-09T02:00:00Z',
  });
});

const reviewerRequest = { schema_version: 1 as const, external_id: 'plan', reviewers: ['Ben'] };

it('replays an acknowledged reviewer request without resending or publishing a candidate', async () => {
  const f = await fixture();
  const remote = cloud();
  const command = { verb: 'request', reviewers: ['Ben'] };
  const first = client(f, remote, command);
  const result = await first.sourcePlan.reviewRequest(reviewerRequest);
  expect(first.publicationAdmission()).toBeNull();
  expect(await client(f, remote, command).sourcePlan.reviewRequest(reviewerRequest)).toEqual(
    result
  );
  expect(remote.sourcePlan.reviewRequest).toHaveBeenCalledTimes(1);
  expect(remote.sourcePlan.reviewPush).not.toHaveBeenCalled();
});

it('preserves unknown reviewer response fields through live dispatch and replay', async () => {
  const f = await fixture();
  const remote = cloud();
  vi.mocked(remote.sourcePlan.reviewRequest).mockResolvedValueOnce({
    externalId: 'plan',
    added: [{ userId: 'ben', rawTag: 'Ben' }],
    alreadyRequested: [],
    unresolved: [],
    futureField: { retained: true },
  } as never);
  const command = { verb: 'request', reviewers: ['Ben'] };
  const live = await client(f, remote, command).sourcePlan.reviewRequest(reviewerRequest);
  const replay = await client(f, remote, command).sourcePlan.reviewRequest(reviewerRequest);
  expect(live).toMatchObject({ futureField: { retained: true } });
  expect(replay).toEqual(live);
  expect(remote.sourcePlan.reviewRequest).toHaveBeenCalledTimes(1);
});

it('retains an unknown reviewer request outcome and refuses blind replay', async () => {
  const f = await fixture();
  const remote = cloud();
  vi.mocked(remote.sourcePlan.reviewRequest).mockRejectedValue(new Error('connection lost'));
  const command = { verb: 'request', reviewers: ['Ben'] };
  await expect(
    client(f, remote, command).sourcePlan.reviewRequest(reviewerRequest)
  ).rejects.toThrow(/not acknowledged/);
  await expect(
    client(f, remote, command).sourcePlan.reviewRequest(reviewerRequest)
  ).rejects.toThrow(/not acknowledged/);
  expect(remote.sourcePlan.reviewRequest).toHaveBeenCalledTimes(1);
});

it('sends a resent reviewer request again after an acknowledged outcome', async () => {
  const f = await fixture();
  const remote = cloud();
  const plain = { verb: 'request', reviewers: ['Ben'] };
  const first = await client(f, remote, plain).sourcePlan.reviewRequest(reviewerRequest);
  expect(await client(f, remote, plain).sourcePlan.reviewRequest(reviewerRequest)).toEqual(first);
  expect(remote.sourcePlan.reviewRequest).toHaveBeenCalledTimes(1);

  // A fresh resend marker is a different command, so it keys a new journal row.
  for (const token of ['nonce-1', 'nonce-2']) {
    await client(f, remote, { ...plain, resend: token }).sourcePlan.reviewRequest(reviewerRequest);
  }
  expect(remote.sourcePlan.reviewRequest).toHaveBeenCalledTimes(3);
});

it('sends a resent reviewer request after an unknown outcome the plain path refuses', async () => {
  const f = await fixture();
  const remote = cloud();
  const plain = { verb: 'request', reviewers: ['Ben'] };
  vi.mocked(remote.sourcePlan.reviewRequest).mockRejectedValueOnce(new Error('connection lost'));
  await expect(client(f, remote, plain).sourcePlan.reviewRequest(reviewerRequest)).rejects.toThrow(
    /not acknowledged/
  );
  await expect(client(f, remote, plain).sourcePlan.reviewRequest(reviewerRequest)).rejects.toThrow(
    /not acknowledged/
  );

  const resent = await client(f, remote, {
    ...plain,
    resend: 'nonce-1',
  }).sourcePlan.reviewRequest(reviewerRequest);
  expect(resent.externalId).toBe(reviewerRequest.external_id);
  expect(remote.sourcePlan.reviewRequest).toHaveBeenCalledTimes(2);

  // The refused key keeps its retained unknown outcome; the resend does not erase it.
  await expect(client(f, remote, plain).sourcePlan.reviewRequest(reviewerRequest)).rejects.toThrow(
    /not acknowledged/
  );
});

it('cancels a reviewer request before sending it', async () => {
  const f = await fixture();
  const remote = cloud();
  const controller = new AbortController();
  controller.abort();
  await expect(
    client(f, remote, { verb: 'request' }, { signal: controller.signal }).sourcePlan.reviewRequest(
      reviewerRequest
    )
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(remote.sourcePlan.reviewRequest).not.toHaveBeenCalled();
});
