import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudWireError, type SourcePlanReviewPullResponse, TrpcRequestError } from '@orcaops/sdk';
import { readReviewCandidate, readReviewProposal, sourcePlanCacheDir } from '@orcaops/storage';

import { parseVersionFlag, type ReviewPullClient, runReviewPull } from './pull.js';
import { seedCandidate } from './test-helpers.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const candidateResp = (body: string, contentHash = sha(body)): SourcePlanReviewPullResponse => ({
  externalId: 'ext-1',
  target: 'candidate',
  versionId: 'ver_4',
  versionNumber: 4,
  proposalId: null,
  baseVersionNumber: null,
  contentHash,
  body,
});
const proposalResp = (body: string): SourcePlanReviewPullResponse => ({
  externalId: 'ext-1',
  target: 'proposal',
  versionId: null,
  versionNumber: null,
  proposalId: 'prop_9',
  baseVersionNumber: 4,
  contentHash: sha(body),
  body,
});
const versionResp = (n: number, body: string): SourcePlanReviewPullResponse => ({
  externalId: 'ext-1',
  target: 'version',
  versionId: `ver_${n}`,
  versionNumber: n,
  proposalId: null,
  baseVersionNumber: null,
  contentHash: sha(body),
  body,
});

function client(reviewPull: ReviewPullClient['sourcePlan']['reviewPull']): ReviewPullClient {
  return { sourcePlan: { reviewPull } };
}

describe('runReviewPull', () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-review-pull-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const base = (root: string) => ({
    repoRoot: root,
    baseUrl: 'https://cloud.example',
    orgId: 'org_1',
    externalId: 'ext-1',
    pulledAt: '2026-06-09T00:00:00.000Z',
  });

  it('pulls the candidate, verifies the hash, caches it, returns ref + version_id', async () => {
    const body = '# Candidate\n\nbody';
    const result = await runReviewPull({
      client: client(vi.fn(async () => candidateResp(body))),
      ...base(repoRoot),
    });
    expect(result.target).toBe('candidate');
    expect(result.version_id).toBe('ver_4');
    expect(result.ref).toBe('ext-1');
    // The resolved base rides the result for origin-keyed cache identity.
    expect(result.base_url).toBe('https://cloud.example');
    const rec = await readReviewCandidate(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'ext-1'
    );
    expect(rec?.body).toBe(body);
    expect(rec?.version_id).toBe('ver_4');
  });

  it('pulls a proposal with --proposal and caches a proposal record', async () => {
    const body = '# Proposal\n\nbody';
    const result = await runReviewPull({
      client: client(vi.fn(async () => proposalResp(body))),
      proposalId: 'prop_9',
      ...base(repoRoot),
    });
    expect(result.target).toBe('proposal');
    expect(result.proposal_id).toBe('prop_9');
    const rec = await readReviewProposal(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'prop_9'
    );
    expect(rec?.body).toBe(body);
  });

  it('sends proposal_id: null when pulling the candidate', async () => {
    const reviewPull = vi.fn(async () => candidateResp('x'));
    await runReviewPull({ client: client(reviewPull), ...base(repoRoot) });
    expect(reviewPull).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: 'ext-1', proposal_id: null })
    );
  });

  it('throws on a body/hash mismatch (corrupt transit)', async () => {
    await expect(
      runReviewPull({
        client: client(vi.fn(async () => candidateResp('real', 'deadbeef'))),
        ...base(repoRoot),
      })
    ).rejects.toThrow(/Integrity check failed/);
  });

  it('maps a NOT_FOUND reviewPull to a friendly NO_INPUT (not a raw CLOUD_ERROR)', async () => {
    const reviewPull = vi.fn(async () => {
      throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
    });
    const err = await runReviewPull({ client: client(reviewPull), ...base(repoRoot) }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toMatch(/not found/i);
  });

  it('maps a missing-procedure rejection to the version-skew message, not the not-found one', async () => {
    const reviewPull = vi.fn(async () => {
      throw new TrpcRequestError('anything', {
        code: 'NOT_FOUND',
        httpStatus: 404,
        appCode: 'UNKNOWN_PROCEDURE',
      });
    });
    const err = await runReviewPull({ client: client(reviewPull), ...base(repoRoot) }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toMatch(/doesn't expose the plan-review surface/);
  });

  it('passes a non-NOT_FOUND reviewPull error through unchanged (stays CLOUD_ERROR-bound)', async () => {
    const reviewPull = vi.fn(async () => {
      throw new TrpcRequestError('boom', { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 });
    });
    const err = await runReviewPull({ client: client(reviewPull), ...base(repoRoot) }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as { code?: string }).code).not.toBe('NO_INPUT');
  });

  it('rejects a blank candidate body with NO_INPUT', async () => {
    await expect(
      runReviewPull({
        client: client(vi.fn(async () => candidateResp('   \n  '))),
        ...base(repoRoot),
      })
    ).rejects.toMatchObject({ code: 'NO_INPUT' });
  });

  it('with --out writes the body file', async () => {
    const body = 'out body';
    const outPath = path.join(repoRoot, 'pulled.md');
    const result = await runReviewPull({
      client: client(vi.fn(async () => candidateResp(body))),
      outPath,
      ...base(repoRoot),
    });
    expect(result.out).toBe(outPath);
    expect(await readFile(outPath, 'utf8')).toBe(body);
  });

  it('allows --out outside the repository', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-review-pull-out-'));
    try {
      const outPath = path.join(outside, 'pulled.md');
      const result = await runReviewPull({
        client: client(vi.fn(async () => candidateResp('external output'))),
        outPath,
        ...base(repoRoot),
      });

      expect(result.out).toBe(outPath);
      expect(await readFile(outPath, 'utf8')).toBe('external output');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('--version sends version_number on the wire and returns the sealed target', async () => {
    const reviewPull = vi.fn(async () => versionResp(2, 'sealed v2'));
    const result = await runReviewPull({
      client: client(reviewPull),
      versionNumber: 2,
      ...base(repoRoot),
    });
    expect(reviewPull).toHaveBeenCalledWith(expect.objectContaining({ version_number: 2 }));
    expect(result.target).toBe('version');
    expect(result.version_number).toBe(2);
  });

  it('--version writes NO record and does NOT clobber a seeded candidate (not a CAS base)', async () => {
    await seedCandidate(repoRoot, { versionId: 'ver_4', versionNumber: 4 });
    await runReviewPull({
      client: client(vi.fn(async () => versionResp(2, 'sealed v2'))),
      versionNumber: 2,
      ...base(repoRoot),
    });
    const rec = await readReviewCandidate(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'ext-1'
    );
    // The CAS token is untouched: still the seeded candidate, not the sealed v2.
    expect(rec?.version_id).toBe('ver_4');
    expect(rec?.version_number).toBe(4);
  });

  it('--version with --out writes the body file (read-only fetch still materializes)', async () => {
    const outPath = path.join(repoRoot, 'v2.md');
    const result = await runReviewPull({
      client: client(vi.fn(async () => versionResp(2, 'sealed v2'))),
      versionNumber: 2,
      outPath,
      ...base(repoRoot),
    });
    expect(result.out).toBe(outPath);
    expect(await readFile(outPath, 'utf8')).toBe('sealed v2');
  });

  it('--version NOT_FOUND maps to the friendly version-does-not-exist message', async () => {
    const reviewPull = vi.fn(async () => {
      throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
    });
    const err = await runReviewPull({
      client: client(reviewPull),
      versionNumber: 7,
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toMatch(/Version 7 does not exist/);
  });

  it('CloudWireError for a mismatched version response surfaces unchanged', async () => {
    const wireErr = new CloudWireError(
      'cloud returned target "candidate" for a version_number pull'
    );
    const reviewPull = vi.fn(async () => {
      throw wireErr;
    });
    const err = await runReviewPull({
      client: client(reviewPull),
      versionNumber: 2,
      ...base(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    // Must NOT be softened to NO_INPUT/NOT_FOUND — the wrapper labels it CLOUD_ERROR.
    expect(err).toBe(wireErr);
  });

  it('a version target WITHOUT a version request is a wire violation (record protected)', async () => {
    await expect(
      runReviewPull({
        client: client(vi.fn(async () => versionResp(2, 'sealed v2'))),
        ...base(repoRoot),
      })
    ).rejects.toThrow(/Unexpected wire response/);
    const rec = await readReviewCandidate(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'ext-1'
    );
    expect(rec).toBeNull();
  });

  it('parseVersionFlag rejects non-integer / non-positive values with INVALID_INPUT', () => {
    for (const bad of ['abc', '0', '-1', '1.5', '']) {
      let err: unknown = null;
      try {
        parseVersionFlag(bad, '--version', 'plan-review-pull');
      } catch (e) {
        err = e;
      }
      expect(err, `expected "${bad}" to be rejected`).toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(parseVersionFlag('3', '--version', 'plan-review-pull')).toBe(3);
  });

  it('FILE-FIRST: a failed --out leaves NO cached record (fail-closed, inverse of plan pull)', async () => {
    // An outPath whose parent is a FILE → atomicWriteFile fails with ENOTDIR
    // BEFORE writeReviewPullRecord runs. The record must NOT advance — so a later
    // push has no stale CAS token and is forced to re-pull.
    const blocker = path.join(repoRoot, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const badOut = path.join(blocker, 'nested.md');
    await expect(
      runReviewPull({
        client: client(vi.fn(async () => candidateResp('body'))),
        outPath: badOut,
        ...base(repoRoot),
      })
    ).rejects.toThrow();
    const rec = await readReviewCandidate(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'ext-1'
    );
    expect(rec).toBeNull();
  });
});
