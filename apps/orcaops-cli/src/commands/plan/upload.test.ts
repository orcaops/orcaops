import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OssSourcePlanBaseline } from '@orcaops/core';
import type { OssSourcePlanUploadPayload, SourcePlanUploadResponse } from '@orcaops/sdk';
import {
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
} from '@orcaops/storage/history/database';

import {
  computeUploadExternalId,
  computeUploadFingerprint,
  suggestReviewers,
  type UploadClient,
} from './upload.js';
import { sourcePlanDatabaseFixture } from '../../../tests/support/source-plan-test-helpers.js';
import { runDatabaseSourcePlanUpload } from '../../lib/database-source-plan-upload.js';

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('upload pure helpers', () => {
  it('fingerprint keeps field boundaries distinct', () => {
    const base = {
      title: 'a',
      body: 'b',
      reviewers: [] as string[],
      review_note: null,
      source_ref: null,
      derived_from: null,
    };
    expect(computeUploadFingerprint(base)).not.toBe(
      computeUploadFingerprint({ ...base, title: 'ab', body: '' })
    );
  });

  it('fingerprint changes with authored content and remains stable otherwise', () => {
    const base = {
      body: 'x',
      title: 't',
      reviewers: [] as string[],
      review_note: null,
      source_ref: null,
      derived_from: null,
    };
    const fingerprint = computeUploadFingerprint(base);
    expect(computeUploadFingerprint({ ...base })).toBe(fingerprint);
    expect(computeUploadFingerprint({ ...base, body: 'y' })).not.toBe(fingerprint);
    expect(computeUploadFingerprint({ ...base, title: 'u' })).not.toBe(fingerprint);
    expect(computeUploadFingerprint({ ...base, reviewers: ['@a'] })).not.toBe(fingerprint);
  });

  it('external id is deterministic per real path and fingerprint', () => {
    expect(computeUploadExternalId('/r/a.md', 'fp1')).toBe(
      computeUploadExternalId('/r/a.md', 'fp1')
    );
    expect(computeUploadExternalId('/r/a.md', 'fp1')).not.toBe(
      computeUploadExternalId('/r/b.md', 'fp1')
    );
    expect(computeUploadExternalId('/r/a.md', 'fp1')).not.toBe(
      computeUploadExternalId('/r/a.md', 'fp2')
    );
  });

  it('suggests matching reviewers and caps each result', () => {
    const members = [
      { handle: 'alice@example.dev', name: 'Alice Apple' },
      { handle: 'bob@example.dev', name: 'Bob Banana' },
    ];
    expect(suggestReviewers(['@alice'], members)).toEqual([
      { tag: '@alice', matches: [{ handle: 'alice@example.dev', name: 'Alice Apple' }] },
    ]);
    expect(suggestReviewers(['banana'], members)[0]?.matches[0]?.handle).toBe('bob@example.dev');
    expect(suggestReviewers(['bob@example.dev (Bob)'], members)[0]?.matches[0]?.handle).toBe(
      'bob@example.dev'
    );
    expect(suggestReviewers(['@zelda'], members)).toEqual([]);
    const many = Array.from({ length: 9 }, (_, index) => ({
      handle: `alice${index}@example.dev`,
      name: `Alice ${index}`,
    }));
    expect(suggestReviewers(['alice'], many)[0]?.matches).toHaveLength(5);
  });
});

async function uploadFixture() {
  const database = await sourcePlanDatabaseFixture();
  cleanups.push(database.cleanup);
  let tick = 0;
  const create = vi.fn(
    async (payload: OssSourcePlanUploadPayload): Promise<SourcePlanUploadResponse> => ({
      id: 'row-1',
      externalId: payload.external_id,
      slug: 'my-plan',
      status: 'DRAFT',
      unresolved: ['@alice'],
    })
  );
  const listReviewers = vi.fn(async () => ({
    members: [{ handle: 'alice@example.dev', name: 'Alice Apple' }],
    scope: 'all_members',
  }));
  const baseline: OssSourcePlanBaseline = {
    repo_url: 'https://github.com/example/repository',
    branch: 'main',
    head_sha: 'a'.repeat(40),
  };
  const client: UploadClient = { sourcePlan: { create, listReviewers } };
  const options = {
    reader: database.reader,
    openWriter: database.openWriter,
    client,
    repoRoot: database.authority.resolvedRoot,
    target: database.target,
    absPath: path.join(database.authority.resolvedRoot, 'docs', 'plan.md'),
    fileRealpath: path.join(database.authority.resolvedRoot, 'docs', 'plan.md'),
    body: '# Plan\n\nbody',
    title: 'My Plan',
    reviewers: ['@alice'],
    reviewNote: null,
    secretAllow: [] as string[],
    resolveBaseline: vi.fn(async () => baseline),
    now: () => `2026-06-08T00:00:0${tick++}.000Z`,
  };
  return { ...database, options, create, listReviewers, baseline };
}

describe('database plan upload', () => {
  it('retains exact identity, payload, unresolved reviewers and suggestions', async () => {
    const fixture = await uploadFixture();
    const discovery = { externalId: null as string | null };
    fixture.options.reviewers = ['@bob', '@alice', '@bob'];
    fixture.listReviewers.mockImplementation(async () => {
      const namespace = readProjectSourcePlanNamespace(fixture.reader, {
        serverUrl: fixture.target.server_url,
        orgId: fixture.target.org_id,
        accountId: fixture.target.account_id,
      });
      discovery.externalId = namespace
        ? (readProjectSourcePlanLocator(fixture.reader, {
            namespaceId: namespace.namespaceId,
            kind: 'upload',
            realPath: fixture.options.fileRealpath,
          })?.record.externalId ?? null)
        : null;
      return {
        members: [{ handle: 'alice@example.dev', name: 'Alice Apple' }],
        scope: 'all_members',
      };
    });

    const result = await runDatabaseSourcePlanUpload(fixture.options);
    const payload = fixture.create.mock.calls[0]![0];
    const fingerprint = computeUploadFingerprint({
      body: fixture.options.body,
      title: fixture.options.title,
      reviewers: ['@alice', '@bob'],
      review_note: null,
      source_ref: path.join('docs', 'plan.md'),
      derived_from: null,
    });

    expect(payload).toMatchObject({
      external_id: computeUploadExternalId(fixture.options.fileRealpath, fingerprint),
      content_hash: sha(fixture.options.body),
      reviewers: ['@alice', '@bob'],
      baseline: fixture.baseline,
    });
    expect(result).toMatchObject({
      external_id: payload.external_id,
      unresolved: ['@alice'],
      reviewer_suggestions: [
        { tag: '@alice', matches: [{ handle: 'alice@example.dev', name: 'Alice Apple' }] },
      ],
    });
    expect(discovery.externalId).toBe(payload.external_id);
  });

  it('replays the retained terminal result without recomputing its baseline or calling cloud', async () => {
    const fixture = await uploadFixture();
    const first = await runDatabaseSourcePlanUpload(fixture.options);
    const cloudCalls = fixture.create.mock.calls.length;
    const replay = await runDatabaseSourcePlanUpload({
      ...fixture.options,
      resolveBaseline: vi.fn(async () => {
        throw new Error('must retain the original baseline');
      }),
    });

    expect(replay).toEqual(first);
    expect(fixture.create).toHaveBeenCalledTimes(cloudCalls);
    expect(fixture.options.resolveBaseline).toHaveBeenCalledTimes(1);
  });

  it('does not discover reviewers on success and ignores discovery failure', async () => {
    const success = await uploadFixture();
    success.create.mockImplementation(async (payload) => ({
      id: 'row-1',
      externalId: payload.external_id,
      slug: 'my-plan',
      status: 'DRAFT',
      unresolved: [],
    }));
    const result = await runDatabaseSourcePlanUpload(success.options);
    expect(result.reviewer_suggestions).toBeUndefined();
    expect(success.listReviewers).not.toHaveBeenCalled();

    const unresolved = await uploadFixture();
    unresolved.listReviewers.mockRejectedValue(new Error('reviewer lookup failed'));
    const degraded = await runDatabaseSourcePlanUpload(unresolved.options);
    expect(degraded.unresolved).toEqual(['@alice']);
    expect(degraded.reviewer_suggestions).toBeUndefined();
  });

  it('reports the prior immutable draft when the retained file content changes', async () => {
    const fixture = await uploadFixture();
    const first = await runDatabaseSourcePlanUpload(fixture.options);
    const second = await runDatabaseSourcePlanUpload({
      ...fixture.options,
      body: '# Plan\n\nEDITED',
    });

    expect(second.external_id).not.toBe(first.external_id);
    expect(second.prior_external_id).toBe(first.external_id);
  });

  it('keeps prior-draft locators independent across account namespaces', async () => {
    const fixture = await uploadFixture();
    const first = await runDatabaseSourcePlanUpload(fixture.options);
    const secondTarget = { ...fixture.target, account_id: 'account_2' };
    const second = await runDatabaseSourcePlanUpload({
      ...fixture.options,
      target: secondTarget,
    });

    expect(second.external_id).toBe(first.external_id);
    expect(second.prior_external_id).toBeUndefined();
    expect(fixture.create).toHaveBeenCalledTimes(2);
    const namespaces = [fixture.target, secondTarget].map((target) =>
      readProjectSourcePlanNamespace(fixture.reader, {
        serverUrl: target.server_url,
        orgId: target.org_id,
        accountId: target.account_id,
      })
    );
    expect(namespaces[0]?.namespaceId).not.toBe(namespaces[1]?.namespaceId);
    for (const namespace of namespaces) {
      expect(
        namespace &&
          readProjectSourcePlanLocator(fixture.reader, {
            namespaceId: namespace.namespaceId,
            kind: 'upload',
            realPath: fixture.options.fileRealpath,
          })?.record.externalId
      ).toBe(first.external_id);
    }
  });

  it('refuses malformed authored input before opening a writer or calling cloud', async () => {
    const fixture = await uploadFixture();
    const openWriter = vi.fn(fixture.openWriter);

    await expect(
      runDatabaseSourcePlanUpload({
        ...fixture.options,
        openWriter,
        body: `# Plan\n\nbody\u0085tail`,
      })
    ).rejects.toThrow(/U\+0085 at offset 12/);
    await expect(
      runDatabaseSourcePlanUpload({
        ...fixture.options,
        openWriter,
        title: 'x'.repeat(201),
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      runDatabaseSourcePlanUpload({
        ...fixture.options,
        openWriter,
        reviewers: [`@${'a'.repeat(300)}`],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(openWriter).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('rejects a cloud response that changes the authored external id', async () => {
    const fixture = await uploadFixture();
    fixture.create.mockImplementation(async () => ({
      id: 'row-1',
      externalId: 'foreign-id',
      slug: 'my-plan',
      status: 'DRAFT',
      unresolved: [],
    }));

    await expect(runDatabaseSourcePlanUpload(fixture.options)).rejects.toMatchObject({
      code: 'CLOUD_ERROR',
      message: expect.stringMatching(/did not honor/i),
    });
  });
});
