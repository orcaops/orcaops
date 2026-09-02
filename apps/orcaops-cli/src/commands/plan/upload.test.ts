import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OssSourcePlanUploadPayload, SourcePlanUploadResponse } from '@orcaops/sdk';
import { sourcePlanCacheDir } from '@orcaops/storage';

import {
  computeUploadExternalId,
  computeUploadFingerprint,
  runPlanUpload,
  suggestReviewers,
  type UploadClient,
  uploadsIndexPath,
} from './upload.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('upload pure helpers', () => {
  it('fingerprint is boundary-safe (field boundaries cannot alias)', () => {
    // Reused storage canonicalJson keeps the JCS property: distinct field splits
    // hash distinctly even when the naive concatenation would collide.
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

  it('fingerprint changes with body / title / reviewers and is otherwise stable', () => {
    const base = {
      body: 'x',
      title: 't',
      reviewers: [] as string[],
      review_note: null,
      source_ref: null,
      derived_from: null,
    };
    const fp = computeUploadFingerprint(base);
    expect(computeUploadFingerprint({ ...base })).toBe(fp);
    expect(computeUploadFingerprint({ ...base, body: 'y' })).not.toBe(fp);
    expect(computeUploadFingerprint({ ...base, title: 'u' })).not.toBe(fp);
    expect(computeUploadFingerprint({ ...base, reviewers: ['@a'] })).not.toBe(fp);
  });

  it('external_id is deterministic per (realpath, fingerprint) and never collapses distinct files', () => {
    expect(computeUploadExternalId('/r/a.md', 'fp1')).toBe(
      computeUploadExternalId('/r/a.md', 'fp1')
    );
    // distinct files, identical content (same fp) → distinct ids
    expect(computeUploadExternalId('/r/a.md', 'fp1')).not.toBe(
      computeUploadExternalId('/r/b.md', 'fp1')
    );
    // same file, edited content (different fp) → distinct ids
    expect(computeUploadExternalId('/r/a.md', 'fp1')).not.toBe(
      computeUploadExternalId('/r/a.md', 'fp2')
    );
  });

  it('uploadsIndexPath is org-scoped', () => {
    const a = uploadsIndexPath('/c', 'https://x', 'org_a', '/r/p.md');
    const b = uploadsIndexPath('/c', 'https://x', 'org_b', '/r/p.md');
    expect(a).not.toBe(b);
    expect(a).toMatch(/uploads[/\\][0-9a-f]{64}\.json$/);
  });

  it('uploadsIndexPath canonicalizes base_url (case / trailing-slash / default-port invariant)', () => {
    const base = uploadsIndexPath('/c', 'https://cloud.example', 'org_1', '/r/p.md');
    expect(uploadsIndexPath('/c', 'https://Cloud.Example', 'org_1', '/r/p.md')).toBe(base);
    expect(uploadsIndexPath('/c', 'https://cloud.example/', 'org_1', '/r/p.md')).toBe(base);
    expect(uploadsIndexPath('/c', 'https://cloud.example:443', 'org_1', '/r/p.md')).toBe(base);
    expect(uploadsIndexPath('/c', 'https://other.example', 'org_1', '/r/p.md')).not.toBe(base);
  });
});

describe('runPlanUpload', () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-upload-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function fakeClient(unresolved: string[]): {
    client: UploadClient;
    create: ReturnType<typeof vi.fn>;
  } {
    const create = vi.fn(
      async (p: OssSourcePlanUploadPayload): Promise<SourcePlanUploadResponse> => ({
        id: 'row-1',
        externalId: p.external_id,
        slug: 'my-plan',
        status: 'DRAFT',
        unresolved,
      })
    );
    const listReviewers = vi.fn(async () => ({ members: [], scope: 'all_members' }));
    return { client: { sourcePlan: { create, listReviewers } }, create };
  }

  function baseArgs(root: string) {
    return {
      repoRoot: root,
      baseUrl: 'https://cloud.example',
      orgId: 'org_1',
      absPath: path.join(root, 'docs', 'plan.md'),
      fileRealpath: path.join(root, 'docs', 'plan.md'),
      body: '# Plan\n\nbody',
      title: 'My Plan',
      reviewers: ['@alice'],
      reviewNote: null,
      authoredAt: '2026-06-08T00:00:00.000Z',
    };
  }

  it('rejects a body with a forbidden control character before any wire call', async () => {
    const { client, create } = fakeClient([]);
    const args = baseArgs(repoRoot);
    // U+0085 (NEL) — the C1 byte the wire policy forbids and plan pull would
    // permanently reject on the way back down.
    await expect(
      runPlanUpload({ client, ...args, body: `# Plan\n\nbody\u0085tail` })
    ).rejects.toThrow(/U\+0085 at offset 12/);
    expect(create).not.toHaveBeenCalled();
  });

  it('calls create with the deterministic id + content_hash + title, surfaces & persists unresolved', async () => {
    const { client, create } = fakeClient(['@alice']);
    const args = baseArgs(repoRoot);
    const result = await runPlanUpload({ client, ...args });

    const fp = computeUploadFingerprint({
      body: args.body,
      title: args.title,
      reviewers: args.reviewers,
      review_note: null,
      source_ref: path.join('docs', 'plan.md'),
      derived_from: null,
    });
    const expectedId = computeUploadExternalId(args.fileRealpath, fp);

    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0][0] as OssSourcePlanUploadPayload;
    expect(payload.external_id).toBe(expectedId);
    expect(payload.content_hash).toBe(sha(args.body));
    expect(payload.title).toBe('My Plan');
    expect(payload.source_ref).toBe(path.join('docs', 'plan.md'));
    expect(result.external_id).toBe(expectedId);
    expect(result.unresolved).toEqual(['@alice']);
    expect(result.prior_external_id).toBeUndefined();

    const idx = JSON.parse(
      await readFile(
        uploadsIndexPath(sourcePlanCacheDir(repoRoot), args.baseUrl, args.orgId, args.fileRealpath),
        'utf8'
      )
    );
    expect(idx).toMatchObject({ external_id: expectedId, unresolved: ['@alice'] });
  });

  it('ships the authoring baseline on the payload but EXCLUDES it from the crash-safe id', async () => {
    const baseline = {
      repo_url: 'https://github.com/foo/bar',
      branch: 'main',
      head_sha: 'ab12f3e',
    };
    const withBaseline = fakeClient([]);
    const args = baseArgs(repoRoot);
    const first = await runPlanUpload({ client: withBaseline.client, ...args, baseline });
    const payload = withBaseline.create.mock.calls[0][0] as OssSourcePlanUploadPayload;
    expect(payload.baseline).toEqual(baseline);

    // Same content from a different/absent git state → same external_id (the
    // baseline is render context, not content identity — no spurious new draft).
    const second = await runPlanUpload({ client: fakeClient([]).client, ...args });
    expect(second.external_id).toBe(first.external_id);
    expect(second.prior_external_id).toBeUndefined();
  });

  it('did-you-mean assist: fires only on unresolved tags, swallows every failure', async () => {
    const members = [
      { handle: 'alice@example.dev', name: 'Alice Apple' },
      { handle: 'bob@example.dev', name: 'Bob Banana' },
    ];
    const args = baseArgs(repoRoot);

    // Unresolved + working discovery → suggestions (leading '@' stripped, case-insensitive).
    const { client } = fakeClient(['@Alice']);
    const listReviewers = vi.fn(async () => ({ members, scope: 'all_members' }));
    client.sourcePlan.listReviewers = listReviewers;
    const result = await runPlanUpload({ client, ...args });
    expect(listReviewers).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      repo_url: null,
    });
    expect(result.reviewer_suggestions).toEqual([
      { tag: '@Alice', matches: [{ handle: 'alice@example.dev', name: 'Alice Apple' }] },
    ]);

    // No unresolved → discovery NEVER called.
    const happy = fakeClient([]);
    const notCalled = vi.fn(async () => ({ members, scope: 'all_members' }));
    happy.client.sourcePlan.listReviewers = notCalled;
    await runPlanUpload({ client: happy.client, ...baseArgs(repoRoot), title: 'Other Plan' });
    expect(notCalled).not.toHaveBeenCalled();

    // Discovery throwing → upload still succeeds with no suggestions.
    const broken = fakeClient(['@ghost']);
    broken.client.sourcePlan.listReviewers = vi.fn(async () => {
      throw new Error('reviewer lookup failed');
    });
    const degraded = await runPlanUpload({
      client: broken.client,
      ...baseArgs(repoRoot),
      title: 'Third Plan',
    });
    expect(degraded.unresolved).toEqual(['@ghost']);
    expect(degraded.reviewer_suggestions).toBeUndefined();
  });

  it('did-you-mean assist derives the discovery repo_url from the baseline (one remote resolution)', async () => {
    const baseline = {
      repo_url: 'https://github.com/foo/bar',
      branch: 'main',
      head_sha: 'ab12f3e',
    };
    const { client } = fakeClient(['@alice']);
    const listReviewers = vi.fn(async () => ({
      members: [{ handle: 'alice@example.dev', name: 'Alice Apple' }],
      scope: 'all_members',
    }));
    client.sourcePlan.listReviewers = listReviewers;
    await runPlanUpload({ client, ...baseArgs(repoRoot), baseline });
    expect(listReviewers).toHaveBeenCalledExactlyOnceWith({
      schema_version: 1,
      repo_url: 'https://github.com/foo/bar',
    });
  });

  it('did-you-mean assist runs only AFTER the prior-draft index write (no extra wire call in the create→index window)', async () => {
    const args = baseArgs(repoRoot);
    const indexPath = uploadsIndexPath(
      sourcePlanCacheDir(repoRoot),
      args.baseUrl,
      args.orgId,
      args.fileRealpath
    );
    const { client } = fakeClient(['@alice']);
    let indexWhenDiscoveryRan: { external_id?: string } | null = null;
    client.sourcePlan.listReviewers = vi.fn(async () => {
      indexWhenDiscoveryRan = JSON.parse(await readFile(indexPath, 'utf8'));
      return {
        members: [{ handle: 'alice@example.dev', name: 'Alice Apple' }],
        scope: 'all_members',
      };
    });
    const result = await runPlanUpload({ client, ...args });
    // Suggestions still ride the result — and the index was already on disk
    // when the discovery call fired. (A readFile failure above would be
    // swallowed into "no suggestions", so assert the suggestions too.)
    expect(result.reviewer_suggestions).toHaveLength(1);
    expect(indexWhenDiscoveryRan).toMatchObject({ external_id: result.external_id });
  });

  it('suggestReviewers matches substrings both directions, caps at 5, drops no-match tags', () => {
    const members = [
      { handle: 'alice@example.dev', name: 'Alice Apple' },
      { handle: 'bob@example.dev', name: 'Bob Banana' },
    ];
    // Tag fragment of a handle; tag fragment of a name; full-handle-containing tag; miss.
    expect(suggestReviewers(['@alice'], members)).toEqual([
      { tag: '@alice', matches: [{ handle: 'alice@example.dev', name: 'Alice Apple' }] },
    ]);
    expect(suggestReviewers(['banana'], members)[0]?.matches[0]?.handle).toBe('bob@example.dev');
    expect(suggestReviewers(['bob@example.dev (Bob)'], members)[0]?.matches[0]?.handle).toBe(
      'bob@example.dev'
    );
    expect(suggestReviewers(['@zelda'], members)).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => ({
      handle: `alice${i}@example.dev`,
      name: `Alice ${i}`,
    }));
    expect(suggestReviewers(['alice'], many)[0]?.matches).toHaveLength(5);
  });

  it('re-surfaces persisted unresolved on a replay (cloud returns [])', async () => {
    const args = baseArgs(repoRoot);
    await runPlanUpload({ client: fakeClient(['@alice']).client, ...args });
    const result = await runPlanUpload({ client: fakeClient([]).client, ...args });
    expect(result.unresolved).toEqual(['@alice']);
    expect(result.prior_external_id).toBeUndefined();
  });

  it('reports the prior immutable draft when the file content changed', async () => {
    const args = baseArgs(repoRoot);
    const first = await runPlanUpload({ client: fakeClient([]).client, ...args });
    const second = await runPlanUpload({
      client: fakeClient([]).client,
      ...args,
      body: '# Plan\n\nEDITED',
    });
    expect(second.external_id).not.toBe(first.external_id);
    expect(second.prior_external_id).toBe(first.external_id);
  });

  it('refuses a symlinked upload index before making a cloud request', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-upload-outside-'));
    try {
      const args = baseArgs(repoRoot);
      await runPlanUpload({ client: fakeClient([]).client, ...args });
      const indexPath = uploadsIndexPath(
        sourcePlanCacheDir(repoRoot),
        args.baseUrl,
        args.orgId,
        args.fileRealpath
      );
      const external = path.join(outside, 'index.json');
      await writeFile(external, 'external sentinel', 'utf8');
      await unlink(indexPath);
      await symlink(external, indexPath);
      const { client, create } = fakeClient([]);

      await expect(runPlanUpload({ client, ...args })).rejects.toThrow(/must not contain symlinks/);
      expect(create).not.toHaveBeenCalled();
      expect(await readFile(external, 'utf8')).toBe('external sentinel');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('normalizes reviewers (sorted + deduped) for both the id and the wire payload', async () => {
    const a = fakeClient([]);
    const first = await runPlanUpload({
      client: a.client,
      ...baseArgs(repoRoot),
      reviewers: ['@bob', '@alice', '@bob'],
    });
    const b = fakeClient([]);
    const second = await runPlanUpload({
      client: b.client,
      ...baseArgs(repoRoot),
      reviewers: ['@alice', '@bob'],
    });
    // Reorder + dedup ⇒ same crash-safe external_id (no spurious new draft).
    expect(second.external_id).toBe(first.external_id);
    expect(second.prior_external_id).toBeUndefined();
    // The wire payload carries the canonical sorted-unique set.
    expect((a.create.mock.calls[0][0] as OssSourcePlanUploadPayload).reviewers).toEqual([
      '@alice',
      '@bob',
    ]);
  });

  it('maps an over-long --title to INVALID_INPUT with a clean message (not CLOUD_ERROR)', async () => {
    await expect(
      runPlanUpload({
        client: fakeClient([]).client,
        ...baseArgs(repoRoot),
        title: 'x'.repeat(201),
      })
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/title/i),
    });
  });

  it('maps an over-long reviewer tag to INVALID_INPUT (user input, not cloud)', async () => {
    await expect(
      runPlanUpload({
        client: fakeClient([]).client,
        ...baseArgs(repoRoot),
        reviewers: [`@${'a'.repeat(300)}`],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('surfaces CLOUD_ERROR when the cloud echoes a different external_id', async () => {
    const create = vi.fn(
      async (): Promise<SourcePlanUploadResponse> => ({
        id: 'row-1',
        externalId: 'A-FOREIGN-ID',
        slug: 'my-plan',
        status: 'DRAFT',
        unresolved: [],
      })
    );
    await expect(
      runPlanUpload({
        client: {
          sourcePlan: {
            create,
            listReviewers: vi.fn(async () => ({ members: [], scope: 'all_members' })),
          },
        },
        ...baseArgs(repoRoot),
      })
    ).rejects.toMatchObject({
      code: 'CLOUD_ERROR',
      message: expect.stringMatching(/did not honor/i),
    });
  });
});
