import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type SourcePlanApprovedPull,
  type SourcePlanGetResult,
  TrpcRequestError,
} from '@orcaops/sdk';
import {
  readProjectSourcePlanLocator,
  readProjectSourcePlanNamespace,
} from '@orcaops/storage/history/database';

import { type PullClient, runPlanPull } from './pull.js';
import { sourcePlanDatabaseFixture } from '../../../tests/support/source-plan-test-helpers.js';
import { createDatabasePlanPullPersistence } from '../../lib/database-source-plan-pull.js';
import { databaseSourcePlanLookup } from '../../lib/database-source-plan-resolver.js';

const pathResolutionFault = vi.hoisted(() => ({ code: '', path: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (pathResolutionFault.code && String(args[0]) === pathResolutionFault.path) {
        throw Object.assign(new Error('injected path resolution failure'), {
          code: pathResolutionFault.code,
        });
      }
      return actual.realpath(...args);
    },
  };
});

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
  let database: Awaited<ReturnType<typeof sourcePlanDatabaseFixture>>;
  beforeEach(async () => {
    pathResolutionFault.code = '';
    pathResolutionFault.path = '';
    repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-pull-cmd-')));
    database = await sourcePlanDatabaseFixture();
  });
  afterEach(async () => {
    await database.cleanup();
    await rm(repoRoot, { recursive: true, force: true });
  });

  const baseArgs = () => ({
    persistence: createDatabasePlanPullPersistence({
      reader: database.reader,
      target: database.target,
      secretAllow: [],
      openWriter: database.openWriter,
    }),
    baseUrl: 'https://cloud.example',
    orgId: 'org_1',
    idOrSlug: 'ext-1',
    pulledAt: '2026-06-08T00:00:00.000Z',
    secretAllow: [],
  });

  it('fetches the approved version, verifies the hash, retains the record, and returns the ref', async () => {
    const body = '# Approved\n\nbody';
    const result = await runPlanPull({
      client: client(vi.fn(async () => approved(body))),
      ...baseArgs(),
    });
    expect(result.ref).toBe('cloud:ext-1@3');
    expect(result.version_number).toBe(3);
    const rec = (await databaseSourcePlanLookup(database.reader)('ext-1', 3))[0]?.record;
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
        ...baseArgs(),
      })
    ).rejects.toThrow(/Integrity check failed/);
  });

  it('with --out writes the body and records the by-path lineage pointer', async () => {
    const body = 'out body';
    const outPath = path.join(repoRoot, 'pulled.md');
    const result = await runPlanPull({
      client: client(vi.fn(async () => approved(body))),
      ...baseArgs(),
      outPath,
    });
    expect(result.out).toBe(outPath);
    expect(await readFile(outPath, 'utf8')).toBe(body);
    const namespace = readProjectSourcePlanNamespace(database.reader, {
      serverUrl: database.target.server_url,
      orgId: database.target.org_id,
      accountId: database.target.account_id,
    })!;
    expect(
      readProjectSourcePlanLocator(database.reader, {
        namespaceId: namespace.namespaceId,
        kind: 'path',
        realPath: await realpath(outPath),
      })?.record
    ).toMatchObject({ externalId: 'ext-1', approvedVersion: 3 });
  });

  it('allows --out outside the repository while retaining its canonical path', async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'orcaops-pull-out-')));
    try {
      const outPath = path.join(outside, 'pulled.md');
      const result = await runPlanPull({
        client: client(vi.fn(async () => approved('external output'))),
        ...baseArgs(),
        outPath,
      });

      expect(result.out).toBe(outPath);
      expect(await readFile(outPath, 'utf8')).toBe('external output');
      const namespace = readProjectSourcePlanNamespace(database.reader, {
        serverUrl: database.target.server_url,
        orgId: database.target.org_id,
        accountId: database.target.account_id,
      })!;
      expect(
        readProjectSourcePlanLocator(database.reader, {
          namespaceId: namespace.namespaceId,
          kind: 'path',
          realPath: await realpath(outPath),
        })?.record
      ).toMatchObject({ externalId: 'ext-1', approvedVersion: 3 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('creates missing nested output directories and retains the canonical locator', async () => {
    const body = 'nested output';
    const outPath = path.join(repoRoot, 'new', 'nested', 'pulled.md');

    const result = await runPlanPull({
      client: client(vi.fn(async () => approved(body))),
      ...baseArgs(),
      outPath,
    });

    expect(result.out).toBe(outPath);
    expect(await readFile(outPath, 'utf8')).toBe(body);
    const namespace = readProjectSourcePlanNamespace(database.reader, {
      serverUrl: database.target.server_url,
      orgId: database.target.org_id,
      accountId: database.target.account_id,
    })!;
    expect(
      readProjectSourcePlanLocator(database.reader, {
        namespaceId: namespace.namespaceId,
        kind: 'path',
        realPath: outPath,
      })?.record
    ).toMatchObject({ externalId: 'ext-1', approvedVersion: 3 });
  });

  it('writes through an existing leaf symlink using the same canonical output and locator', async () => {
    const body = 'canonical target body';
    const targetPath = path.join(repoRoot, 'target.md');
    const linkedPath = path.join(repoRoot, 'linked.md');
    await writeFile(targetPath, 'old body', 'utf8');
    await symlink(targetPath, linkedPath);

    const result = await runPlanPull({
      client: client(vi.fn(async () => approved(body))),
      ...baseArgs(),
      outPath: linkedPath,
    });

    expect(result.out).toBe(targetPath);
    expect(await readFile(targetPath, 'utf8')).toBe(body);
    expect(await realpath(linkedPath)).toBe(targetPath);
    const namespace = readProjectSourcePlanNamespace(database.reader, {
      serverUrl: database.target.server_url,
      orgId: database.target.org_id,
      accountId: database.target.account_id,
    })!;
    expect(
      readProjectSourcePlanLocator(database.reader, {
        namespaceId: namespace.namespaceId,
        kind: 'path',
        realPath: targetPath,
      })?.record
    ).toMatchObject({ externalId: 'ext-1', approvedVersion: 3 });
  });

  it('refuses a missing nested suffix below a secret-like symlink target before any seam runs', async () => {
    const secretParent = path.join(repoRoot, `ghp_${'A'.repeat(36)}`);
    const safeAlias = path.join(repoRoot, 'safe-output');
    await mkdir(secretParent);
    await symlink(secretParent, safeAlias, 'dir');
    const output = path.join(safeAlias, 'missing', 'nested', 'plan.md');
    const getApproved = vi.fn(async () => approved('must not be fetched'));
    const persistence = {
      preflight: vi.fn(async () => {}),
      writeRecord: vi.fn(async () => {}),
      writePathPointer: vi.fn(async () => {}),
    };

    await expect(
      runPlanPull({
        ...baseArgs(),
        client: client(getApproved),
        outPath: output,
        persistence,
      })
    ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });

    expect(getApproved).not.toHaveBeenCalled();
    expect(persistence.preflight).not.toHaveBeenCalled();
    expect(persistence.writeRecord).not.toHaveBeenCalled();
    expect(persistence.writePathPointer).not.toHaveBeenCalled();
    await expect(stat(path.join(secretParent, 'missing'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(path.join(secretParent, 'missing', 'nested', 'plan.md'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['EACCES', 'EIO', 'ENOTDIR'])(
    'propagates an injected %s output-resolution failure before any seam runs',
    async (code) => {
      const output = path.join(repoRoot, 'unresolved.md');
      pathResolutionFault.path = output;
      pathResolutionFault.code = code;
      const getApproved = vi.fn(async () => approved('must not be fetched'));
      const persistence = {
        preflight: vi.fn(async () => {}),
        writeRecord: vi.fn(async () => {}),
        writePathPointer: vi.fn(async () => {}),
      };

      await expect(
        runPlanPull({
          ...baseArgs(),
          client: client(getApproved),
          outPath: output,
          persistence,
        })
      ).rejects.toMatchObject({ code });

      expect(getApproved).not.toHaveBeenCalled();
      expect(persistence.preflight).not.toHaveBeenCalled();
      expect(persistence.writeRecord).not.toHaveBeenCalled();
      expect(persistence.writePathPointer).not.toHaveBeenCalled();
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('maps a NOT_FOUND getApproved error to a clear "no APPROVED version"', async () => {
    await expect(
      runPlanPull({
        client: client(
          vi.fn(async () => {
            throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
          })
        ),
        ...baseArgs(),
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
        ...baseArgs(),
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
        ...baseArgs(),
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
        ...baseArgs(),
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
        ...baseArgs(),
      })
    ).rejects.toThrow(/is PINNED/);
  });

  const pinnedWith = async (webUrl: unknown, baseUrl?: string): Promise<string> => {
    try {
      await runPlanPull({
        client: client(
          vi.fn(async () => {
            throw new TrpcRequestError('not found', { code: 'NOT_FOUND', httpStatus: 404 });
          }),
          vi.fn(async () => getResult('PINNED', { webUrl } as Partial<SourcePlanGetResult>))
        ),
        ...baseArgs(),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected runPlanPull to reject');
  };

  it('prints the plan web page when it is on the cloud host itself', async () => {
    const message = await pinnedWith('https://cloud.example/p/ext-1');
    expect(message).toContain('is PINNED');
    expect(message).toContain('https://cloud.example/p/ext-1');
  });

  it('prints a plan web page that is a sibling of the cloud host', async () => {
    const message = await pinnedWith(
      'https://app.cloud.example/p/ext-1',
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
    const message = await pinnedWith(webUrl);
    expect(message).toContain('is PINNED');
    expect(message).not.toContain(webUrl);
    expect(message).not.toContain('web page');
  });

  it.each([
    ['the cloud returns no web URL', undefined],
    ['the cloud returns an empty web URL', ''],
  ])('still reports the pin when %s', async (_label, webUrl) => {
    const message = await pinnedWith(webUrl);
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
        ...baseArgs(),
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
        ...baseArgs(),
      })
    ).rejects.toThrow(/No APPROVED version/);
  });

  it('rejects an approved body carrying a forbidden control char before anything durable lands', async () => {
    // U+0085 (NEL) is C1: storable locally, rejected by the wire assert — so a
    // retained copy would become a permanently unpushable pin.
    const err = await runPlanPull({
      client: client(vi.fn(async () => approved('clean prose\u0085dirty tail'))),
      ...baseArgs(),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'NO_INPUT' });
    expect((err as Error).message).toMatch(/U\+0085/);
    expect((err as Error).message).toMatch(/web surface/);
    // Nothing durable: no by-id record was written.
    expect(await databaseSourcePlanLookup(database.reader)('ext-1', 3)).toEqual([]);
  });

  it('rejects a NUL-bearing approved body and skips the --out write', async () => {
    const outPath = path.join(repoRoot, 'pulled.md');
    await expect(
      runPlanPull({
        client: client(vi.fn(async () => approved('before\u0000after'))),
        ...baseArgs(),
        outPath,
      })
    ).rejects.toMatchObject({ code: 'NO_INPUT' });
    await expect(readFile(outPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      readProjectSourcePlanNamespace(database.reader, {
        serverUrl: database.target.server_url,
        orgId: database.target.org_id,
        accountId: database.target.account_id,
      })
    ).toBeNull();
  });

  it('rejects a whitespace-only approved body with NO_INPUT', async () => {
    await expect(
      runPlanPull({
        client: client(vi.fn(async () => approved('   \n  '))),
        ...baseArgs(),
      })
    ).rejects.toMatchObject({ code: 'NO_INPUT' });
  });

  it('lands the by-id record before the --out write, so a post-preflight failure still leaves a pinnable record', async () => {
    const body = 'durable body';
    // An outPath that is an existing directory passes canonical preflight, then
    // atomicWriteFile cannot rename a file over it after the by-id record lands.
    const badOut = path.join(repoRoot, 'blocker');
    await mkdir(badOut);
    await expect(
      runPlanPull({
        client: client(vi.fn(async () => approved(body))),
        ...baseArgs(),
        outPath: badOut,
      })
    ).rejects.toThrow();
    // The resolve-critical by-id record landed first.
    const rec = (await databaseSourcePlanLookup(database.reader)('ext-1', 3))[0]?.record;
    expect(rec?.body).toBe(body);
    // No lineage pointer — the --out file never materialized.
    const namespace = readProjectSourcePlanNamespace(database.reader, {
      serverUrl: database.target.server_url,
      orgId: database.target.org_id,
      accountId: database.target.account_id,
    })!;
    expect(
      readProjectSourcePlanLocator(database.reader, {
        namespaceId: namespace.namespaceId,
        kind: 'path',
        realPath: badOut,
      })
    ).toBeNull();
  });

  it('does NOT relabel a malformed cloud-record ZodError as INVALID_INPUT (stays cloud-data → CLOUD_ERROR)', async () => {
    // versionNumber 0 passes integrity + the blank guard but fails the record
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
      ...baseArgs(),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).not.toBe('INVALID_INPUT');
  });
});
