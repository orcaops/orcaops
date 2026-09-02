import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type SourcePlanApprovedPull,
  type SourcePlanGetResult,
  TrpcRequestError,
} from '@orcaops/sdk';
import { findByPath, readPullCacheRecord, sourcePlanCacheDir } from '@orcaops/storage';

import { type PullClient, runPlanPull } from './pull.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function approved(body: string, contentHash = sha(body)): SourcePlanApprovedPull {
  return {
    externalId: 'ext-1',
    slug: 'my-plan',
    title: 'My Plan',
    approvedVersion: { versionNumber: 3, body, contentHash, sourceRef: 'docs/orig.md' },
  };
}

function client(
  getApproved: PullClient['sourcePlan']['getApproved'],
  get?: PullClient['sourcePlan']['get']
): PullClient {
  return {
    sourcePlan: {
      getApproved,
      get: get ?? vi.fn(async () => getResult('IN_REVIEW')),
    },
  };
}

function getResult(status: string, over: Partial<SourcePlanGetResult> = {}): SourcePlanGetResult {
  return {
    externalId: 'ext-1',
    slug: 'my-plan',
    title: 'My Plan',
    status,
    approvedVersionNumber: null,
    webUrl: 'https://cloud.example/p/ext-1',
    captureThread: null,
    ...over,
  };
}

describe('runPlanPull', () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-pull-cmd-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const baseArgs = (root: string) => ({
    repoRoot: root,
    baseUrl: 'https://cloud.example',
    orgId: 'org_1',
    idOrSlug: 'ext-1',
    pulledAt: '2026-06-08T00:00:00.000Z',
  });

  it('fetches the approved version, verifies the hash, caches the record, returns the ref', async () => {
    const body = '# Approved\n\nbody';
    const result = await runPlanPull({
      client: client(vi.fn(async () => approved(body))),
      ...baseArgs(repoRoot),
    });
    expect(result.ref).toBe('cloud:ext-1@3');
    expect(result.version_number).toBe(3);
    const rec = await readPullCacheRecord(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'ext-1',
      3
    );
    expect(rec?.body).toBe(body);
    expect(rec?.content_hash).toBe(sha(body));
    expect(rec?.source_ref).toBe('docs/orig.md');
    expect(rec?.base_url).toBe('https://cloud.example');
    expect(rec?.org_id).toBe('org_1');
  });

  it('throws on a body/hash mismatch (corrupt transfer)', async () => {
    await expect(
      runPlanPull({
        client: client(vi.fn(async () => approved('real', 'deadbeef'))),
        ...baseArgs(repoRoot),
      })
    ).rejects.toThrow(/Integrity check failed/);
  });

  it('with --out writes the body and records the by-path lineage pointer', async () => {
    const body = 'out body';
    const outPath = path.join(repoRoot, 'pulled.md');
    const result = await runPlanPull({
      client: client(vi.fn(async () => approved(body))),
      ...baseArgs(repoRoot),
      outPath,
    });
    expect(result.out).toBe(outPath);
    expect(await readFile(outPath, 'utf8')).toBe(body);
    expect(
      await findByPath(sourcePlanCacheDir(repoRoot), 'https://cloud.example', 'org_1', outPath)
    ).toEqual({ external_id: 'ext-1', version_number: 3 });
  });

  it('allows --out outside the repository while keeping its cache pointer contained', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'orcaops-pull-out-'));
    try {
      const outPath = path.join(outside, 'pulled.md');
      const result = await runPlanPull({
        client: client(vi.fn(async () => approved('external output'))),
        ...baseArgs(repoRoot),
        outPath,
      });

      expect(result.out).toBe(outPath);
      expect(await readFile(outPath, 'utf8')).toBe('external output');
      expect(
        await findByPath(sourcePlanCacheDir(repoRoot), 'https://cloud.example', 'org_1', outPath)
      ).toEqual({ external_id: 'ext-1', version_number: 3 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('maps a NOT_FOUND getApproved error to a clear "no APPROVED version"', async () => {
    await expect(
      runPlanPull({
        client: client(
          vi.fn(async () => {
            throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
          })
        ),
        ...baseArgs(repoRoot),
      })
    ).rejects.toThrow(/No APPROVED version/);
  });

  it('does not infer NOT_FOUND from a bare HTTP status', async () => {
    const raw = new TrpcRequestError('nf', { httpStatus: 404 });
    await expect(
      runPlanPull({
        client: client(
          vi.fn(async () => {
            throw raw;
          })
        ),
        ...baseArgs(repoRoot),
      })
    ).rejects.toBe(raw);
  });

  it('maps a missing-procedure rejection to the version-skew message, not "no APPROVED version"', async () => {
    await expect(
      runPlanPull({
        client: client(
          vi.fn(async () => {
            throw new TrpcRequestError('anything', {
              code: 'NOT_FOUND',
              httpStatus: 404,
              appCode: 'UNKNOWN_PROCEDURE',
            });
          })
        ),
        ...baseArgs(repoRoot),
      })
    ).rejects.toThrow(/doesn't expose the plan-review surface/);
  });

  // A typed missing-procedure getApproved may also carry NOT_FOUND, so it must
  // keep the version-skew message even when metadata resolves PINNED. Without the
  // !isMissingProcedureError guard this would mislabel skew as "is PINNED".
  it('keeps the version-skew message for a missing-procedure getApproved even when get() returns PINNED', async () => {
    await expect(
      runPlanPull({
        client: client(
          vi.fn(async () => {
            throw new TrpcRequestError('anything', {
              code: 'NOT_FOUND',
              httpStatus: 404,
              appCode: 'UNKNOWN_PROCEDURE',
            });
          }),
          vi.fn(async () => getResult('PINNED'))
        ),
        ...baseArgs(repoRoot),
      })
    ).rejects.toThrow(/doesn't expose the plan-review surface/);
  });

  // A pin transitions the cloud plan APPROVED→PINNED, so re-pulling a plan you
  // just pinned 404s on getApproved. Best-effort metadata disambiguates that
  // from a never-approved plan; misreading it risks a duplicate pin.
  it('disambiguates a PINNED plan: NOT_FOUND getApproved + PINNED metadata → "is PINNED" message', async () => {
    await expect(
      runPlanPull({
        client: client(
          vi.fn(async () => {
            throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
          }),
          vi.fn(async () => getResult('PINNED'))
        ),
        ...baseArgs(repoRoot),
      })
    ).rejects.toThrow(/is PINNED/);
  });

  const pinnedWith = async (webUrl: unknown, root: string, baseUrl?: string): Promise<string> => {
    try {
      await runPlanPull({
        client: client(
          vi.fn(async () => {
            throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
          }),
          vi.fn(async () => getResult('PINNED', { webUrl } as Partial<SourcePlanGetResult>))
        ),
        ...baseArgs(root),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected runPlanPull to reject');
  };

  it('prints the plan web page when it is on the cloud host itself', async () => {
    const message = await pinnedWith('https://cloud.example/p/ext-1', repoRoot);
    expect(message).toContain('is PINNED');
    expect(message).toContain('https://cloud.example/p/ext-1');
  });

  it('prints a plan web page that is a sibling of the cloud host', async () => {
    const message = await pinnedWith(
      'https://app.cloud.example/p/ext-1',
      repoRoot,
      'https://api.cloud.example'
    );
    expect(message).toContain('is PINNED');
    expect(message).toContain('https://app.cloud.example/p/ext-1');
  });

  it.each([
    ['a foreign host', 'https://evil.example/p/ext-1'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a file: URL', 'file:///etc/passwd'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['embedded credentials', 'https://user:pw@cloud.example/p/ext-1'],
  ])('refuses to print %s', async (_label, webUrl) => {
    const message = await pinnedWith(webUrl, repoRoot);
    expect(message).toContain('is PINNED');
    expect(message).not.toContain(webUrl);
    expect(message).not.toContain('web page');
  });

  it.each([
    ['the cloud returns no web URL', undefined],
    ['the cloud returns an empty web URL', ''],
  ])('still reports the pin when %s', async (_label, webUrl) => {
    const message = await pinnedWith(webUrl, repoRoot);
    expect(message).toContain('is PINNED');
    expect(message).not.toContain('web page');
  });

  it('a NOT_FOUND with non-PINNED metadata still falls through to "no APPROVED version"', async () => {
    await expect(
      runPlanPull({
        client: client(
          vi.fn(async () => {
            throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
          }),
          vi.fn(async () => getResult('IN_REVIEW'))
        ),
        ...baseArgs(repoRoot),
      })
    ).rejects.toThrow(/No APPROVED version/);
  });

  it('a failing metadata lookup never worsens the error (best-effort) → "no APPROVED version"', async () => {
    await expect(
      runPlanPull({
        client: client(
          vi.fn(async () => {
            throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
          }),
          vi.fn(async () => {
            throw new Error('metadata boom');
          })
        ),
        ...baseArgs(repoRoot),
      })
    ).rejects.toThrow(/No APPROVED version/);
  });

  it('rejects an approved body carrying a forbidden control char before anything durable lands', async () => {
    // U+0085 (NEL) is C1: storable locally, rejected by the wire assert — so a
    // cached copy would become a permanently unpushable pin.
    const err = await runPlanPull({
      client: client(vi.fn(async () => approved('clean prose\u0085dirty tail'))),
      ...baseArgs(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toMatch(/U\+0085/);
    expect((err as Error).message).toMatch(/web surface/);
    // Nothing durable: no by-id record was written.
    expect(
      await readPullCacheRecord(
        sourcePlanCacheDir(repoRoot),
        'https://cloud.example',
        'org_1',
        'ext-1',
        3
      )
    ).toBeNull();
  });

  it('rejects a NUL-bearing approved body and skips the --out write', async () => {
    const outPath = path.join(repoRoot, 'pulled.md');
    await expect(
      runPlanPull({
        client: client(vi.fn(async () => approved('before\u0000after'))),
        ...baseArgs(repoRoot),
        outPath,
      })
    ).rejects.toMatchObject({ code: 'NO_INPUT' });
    await expect(readFile(outPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await findByPath(sourcePlanCacheDir(repoRoot), 'https://cloud.example', 'org_1', outPath)
    ).toBeNull();
  });

  it('rejects a whitespace-only approved body with NO_INPUT', async () => {
    await expect(
      runPlanPull({
        client: client(vi.fn(async () => approved('   \n  '))),
        ...baseArgs(repoRoot),
      })
    ).rejects.toMatchObject({ code: 'NO_INPUT' });
  });

  it('lands the by-id record before the --out write, so a failed --out still leaves a pinnable record', async () => {
    const body = 'durable body';
    // An outPath whose parent is a FILE → atomicWriteFile fails with ENOTDIR,
    // AFTER the by-id record has already been written.
    const blocker = path.join(repoRoot, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const badOut = path.join(blocker, 'nested.md');
    await expect(
      runPlanPull({
        client: client(vi.fn(async () => approved(body))),
        ...baseArgs(repoRoot),
        outPath: badOut,
      })
    ).rejects.toThrow();
    // The resolve-critical by-id record landed first.
    const rec = await readPullCacheRecord(
      sourcePlanCacheDir(repoRoot),
      'https://cloud.example',
      'org_1',
      'ext-1',
      3
    );
    expect(rec?.body).toBe(body);
    // No lineage pointer — the --out file never materialized.
    expect(
      await findByPath(sourcePlanCacheDir(repoRoot), 'https://cloud.example', 'org_1', badOut)
    ).toBeNull();
  });

  it('does NOT relabel a malformed cloud-record ZodError as INVALID_INPUT (stays cloud-data → CLOUD_ERROR)', async () => {
    // versionNumber 0 passes integrity + the blank guard but fails the cache
    // schema's positive-int rule → a raw ZodError. runPlanPull must NOT map it to
    // a user-input OrcaopsError; the wrapper's shared envelope maps it to
    // CLOUD_ERROR (the correct label for a corrupt cloud surface).
    const bad: SourcePlanApprovedPull = {
      externalId: 'ext-1',
      slug: 'my-plan',
      title: 'My Plan',
      approvedVersion: { versionNumber: 0, body: 'x', contentHash: sha('x'), sourceRef: null },
    };
    const err = await runPlanPull({
      client: client(vi.fn(async () => bad)),
      ...baseArgs(repoRoot),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).not.toBe('INVALID_INPUT');
  });
});
